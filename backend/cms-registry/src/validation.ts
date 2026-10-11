import type { CoreJsonValue, RegistryMutationCandidate } from "../../core/src/index.js";
import {
	contributionKey,
	type ContributionDefinition,
	type ContributionOwner,
} from "./contracts.js";
import { RegistryError } from "./errors.js";

const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const localePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const semverPattern =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function validateContributionDefinition(definition: ContributionDefinition): void {
	validateIdentifier(definition.identifier, "contribution");
	validateOwner(definition.owner);
	if (!semverPattern.test(definition.version)) {
		throw invalid("La version doit respecter SemVer.");
	}
	const key = contributionKey(definition.type, definition.identifier);
	const dependencies = new Set<string>();
	for (const dependency of definition.dependencies ?? []) {
		validateIdentifier(dependency.contributionKey, "dépendance");
		if (dependency.contributionKey === key) throw invalid("Une contribution dépend d’elle-même.");
		if (dependencies.has(dependency.contributionKey)) {
			throw invalid("Une dépendance est déclarée plusieurs fois.");
		}
		dependencies.add(dependency.contributionKey);
		if (
			dependency.versionRange !== undefined &&
			!/^(?:\^|~|>=|>)?\s*(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
				dependency.versionRange,
			)
		) {
			throw invalid("La plage de version d’une dépendance est invalide.");
		}
	}
	for (const capability of definition.requiredCapabilities ?? []) {
		validateIdentifier(capability, "capacité");
	}
	if (definition.type === "method" && !definition.method) {
		throw invalid("Une contribution de méthode doit déclarer son contrat.");
	}
	if (definition.type !== "method" && definition.method) {
		throw invalid("Un contrat de méthode ne peut appartenir qu’à une méthode.");
	}
	if (definition.type === "api-endpoint" && !definition.endpoint) {
		throw invalid("Une contribution d’API doit déclarer son contrat d’endpoint.");
	}
	if (definition.type !== "api-endpoint" && definition.endpoint) {
		throw invalid("Un contrat d’endpoint ne peut appartenir qu’à une contribution d’API.");
	}
	if (definition.method) {
		if (definition.method.timeoutMs < 1 || definition.method.timeoutMs > 120_000) {
			throw invalid("Le délai d’une méthode doit être compris entre 1 ms et 120 secondes.");
		}
		if (definition.method.requiredCapability) {
			validateIdentifier(definition.method.requiredCapability, "permission de méthode");
		}
	}
	if (definition.endpoint) validateEndpoint(definition.endpoint);
	validateConfiguration(definition);
	validateTranslations(definition.translations);
	if (definition.payload !== undefined) assertJsonValue(definition.payload);
	if (definition.replaces !== undefined) {
		validateIdentifier(definition.replaces, "remplacement");
		if (definition.replacementPolicy !== "explicit") {
			throw invalid("Un remplacement doit utiliser la politique explicite.");
		}
	}
}

function validateEndpoint(endpoint: NonNullable<ContributionDefinition["endpoint"]>): void {
	if (
		!/^\/(?:[a-z0-9][a-z0-9._-]*|:[a-z][a-z0-9]*)(?:\/(?:[a-z0-9][a-z0-9._-]*|:[a-z][a-z0-9]*))*$/.test(
			endpoint.route,
		)
	) {
		throw invalid("La route d’API déclarée est invalide.");
	}
	if (!semverPattern.test(endpoint.contractVersion)) {
		throw invalid("La version du contrat d’API doit respecter SemVer.");
	}
	validateIdentifier(endpoint.businessMethodIdentifier, "méthode métier d’API");
	if (endpoint.requiredCapability) {
		validateIdentifier(endpoint.requiredCapability, "permission d’API");
	}
	if (endpoint.quota) {
		if (
			!Number.isSafeInteger(endpoint.quota.limit) ||
			endpoint.quota.limit < 1 ||
			endpoint.quota.limit > 1_000_000 ||
			!Number.isSafeInteger(endpoint.quota.windowSeconds) ||
			endpoint.quota.windowSeconds < 1 ||
			endpoint.quota.windowSeconds > 86_400
		) {
			throw invalid("Le quota d’API est invalide.");
		}
	}
	validateApiSchema(endpoint.input, 0);
	validateApiSchema(endpoint.output, 0);
	const errorCodes = new Set<string>();
	for (const error of endpoint.publicErrors ?? []) {
		validateIdentifier(error.code, "erreur publique");
		if (errorCodes.has(error.code))
			throw invalid("Une erreur publique est déclarée plusieurs fois.");
		errorCodes.add(error.code);
		if (
			!Number.isSafeInteger(error.httpStatus) ||
			error.httpStatus < 400 ||
			error.httpStatus > 599
		) {
			throw invalid("Le statut HTTP d’une erreur publique est invalide.");
		}
		if (Object.keys(error.message).length === 0) {
			throw invalid("Une erreur publique doit posséder un message traduit.");
		}
		validateLocalizedText(error.message);
	}
}

function validateApiSchema(
	schema: NonNullable<ContributionDefinition["endpoint"]>["input"],
	depth: number,
): void {
	if (depth > 12) throw invalid("Le schéma d’API est trop imbriqué.");
	if ("maximumLength" in schema && schema.maximumLength !== undefined) {
		if (
			schema.type !== "string" ||
			!Number.isSafeInteger(schema.maximumLength) ||
			schema.maximumLength < 1 ||
			schema.maximumLength > 1_048_576
		) {
			throw invalid("La longueur maximale du schéma d’API est invalide.");
		}
	}
	if (schema.type === "array") {
		if (
			schema.maximumItems !== undefined &&
			(!Number.isSafeInteger(schema.maximumItems) ||
				schema.maximumItems < 1 ||
				schema.maximumItems > 10_000)
		) {
			throw invalid("La taille maximale du tableau d’API est invalide.");
		}
		validateApiSchema(schema.items, depth + 1);
	}
	if (schema.type === "object") {
		const properties = Object.keys(schema.properties);
		if (properties.length > 256) throw invalid("Le schéma d’objet d’API possède trop de champs.");
		for (const [key, child] of Object.entries(schema.properties)) {
			validateIdentifier(key, "champ d’API");
			validateApiSchema(child, depth + 1);
		}
		for (const required of schema.required ?? []) {
			if (!Object.hasOwn(schema.properties, required)) {
				throw invalid("Un champ obligatoire d’API n’est pas déclaré.");
			}
		}
	}
}

export function toMutationCandidate(
	definition: ContributionDefinition,
	action: RegistryMutationCandidate["action"],
): RegistryMutationCandidate {
	return {
		action,
		contributionKey: contributionKey(definition.type, definition.identifier),
		ownerIdentifier: definition.owner.identifier,
		ownerKind: definition.owner.kind,
		version: definition.version,
		requiredCapabilities: [...(definition.requiredCapabilities ?? [])],
		payload: definitionAsJson(definition),
	};
}

export function compareSemver(first: string, second: string): number {
	const [firstCore, firstPrerelease] = first.split("+")[0]!.split("-", 2);
	const [secondCore, secondPrerelease] = second.split("+")[0]!.split("-", 2);
	const firstParts = firstCore!.split(".").map(Number);
	const secondParts = secondCore!.split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		const difference = firstParts[index]! - secondParts[index]!;
		if (difference !== 0) return difference;
	}
	if (!firstPrerelease && !secondPrerelease) return 0;
	if (!firstPrerelease) return 1;
	if (!secondPrerelease) return -1;
	const firstIdentifiers = firstPrerelease.split(".");
	const secondIdentifiers = secondPrerelease.split(".");
	for (
		let index = 0;
		index < Math.max(firstIdentifiers.length, secondIdentifiers.length);
		index += 1
	) {
		const firstIdentifier = firstIdentifiers[index];
		const secondIdentifier = secondIdentifiers[index];
		if (firstIdentifier === undefined) return -1;
		if (secondIdentifier === undefined) return 1;
		if (firstIdentifier === secondIdentifier) continue;
		const firstNumber = /^\d+$/.test(firstIdentifier) ? Number(firstIdentifier) : undefined;
		const secondNumber = /^\d+$/.test(secondIdentifier) ? Number(secondIdentifier) : undefined;
		if (firstNumber !== undefined && secondNumber !== undefined) return firstNumber - secondNumber;
		if (firstNumber !== undefined) return -1;
		if (secondNumber !== undefined) return 1;
		return firstIdentifier.localeCompare(secondIdentifier);
	}
	return 0;
}

export function validateOwner(owner: ContributionOwner): void {
	validateIdentifier(owner.identifier, "propriétaire");
	if (owner.kind === "core" && owner.identifier !== "core") {
		throw invalid("Le propriétaire Core doit utiliser l’identifiant core.");
	}
}

function validateConfiguration(definition: ContributionDefinition): void {
	const keys = new Set<string>();
	for (const field of definition.configuration ?? []) {
		validateIdentifier(field.key, "configuration");
		if (keys.has(field.key)) throw invalid("Une clé de configuration est dupliquée.");
		keys.add(field.key);
		assertJsonValue(field.defaultValue);
		for (const value of field.allowedValues ?? []) assertJsonValue(value);
		if (Object.keys(field.description).length === 0) {
			throw invalid("Une configuration doit posséder une description traduite.");
		}
		validateLocalizedText(field.description);
	}
}

function validateTranslations(translations: ContributionDefinition["translations"]): void {
	if (!translations) return;
	for (const [locale, entries] of Object.entries(translations)) {
		if (!localePattern.test(locale)) throw invalid(`La langue ${locale} est invalide.`);
		for (const [key, value] of Object.entries(entries)) {
			validateIdentifier(key, "traduction");
			if (!value.trim()) throw invalid("Une traduction ne peut pas être vide.");
		}
	}
}

function validateLocalizedText(value: Readonly<Record<string, string>>): void {
	for (const [locale, text] of Object.entries(value)) {
		if (!localePattern.test(locale) || !text.trim()) {
			throw invalid("Un texte localisé est invalide.");
		}
	}
}

function validateIdentifier(value: string, label: string): void {
	if (!identifierPattern.test(value) || value.length > 160) {
		throw invalid(`L’identifiant de ${label} est invalide.`);
	}
}

function definitionAsJson(definition: ContributionDefinition): CoreJsonValue {
	return JSON.parse(JSON.stringify(definition)) as CoreJsonValue;
}

function assertJsonValue(value: unknown, seen = new Set<object>()): asserts value is CoreJsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw invalid("Un nombre déclaré doit être fini.");
		return;
	}
	if (typeof value !== "object") throw invalid("Une valeur déclarative n’est pas sérialisable.");
	if (seen.has(value)) throw invalid("Une valeur déclarative contient un cycle.");
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) assertJsonValue(item, seen);
	} else {
		const prototype = Object.getPrototypeOf(value) as object | null;
		if (prototype !== Object.prototype && prototype !== null) {
			throw invalid("Une valeur déclarative doit être un objet JSON simple.");
		}
		for (const item of Object.values(value as Record<string, unknown>)) {
			assertJsonValue(item, seen);
		}
	}
	seen.delete(value);
}

function invalid(message: string): RegistryError {
	return new RegistryError("registry.contract_invalid", message);
}
