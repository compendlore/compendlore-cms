import type { CoreJsonValue, RegistryMutationCandidate } from "../../core/src/index.js";
import {
	contributionKey,
	type ContributionDefinition,
	type ContributionOwner,
} from "./contracts.js";
import { RegistryError } from "./errors.js";
import { messageDeliveryProfiles } from "./messaging.js";
import { themeTokenTypes } from "./themes.js";

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
	if (definition.type === "connector" && !definition.connector) {
		throw invalid("Une contribution de connecteur doit déclarer son contrat.");
	}
	if (definition.type !== "connector" && definition.connector) {
		throw invalid("Un contrat de connecteur ne peut appartenir qu’à un connecteur.");
	}
	if (definition.connector) validateConnector(definition.connector);
	if (definition.type === "frontend-network" && !definition.frontendNetwork) {
		throw invalid("Une contribution réseau frontend doit déclarer sa politique.");
	}
	if (definition.type !== "frontend-network" && definition.frontendNetwork) {
		throw invalid("Une politique réseau frontend ne peut appartenir qu’à sa contribution.");
	}
	if (definition.frontendNetwork) validateFrontendNetwork(definition.frontendNetwork);
	validateStatisticContract(definition);
	validateMessagingContract(definition);
	validateThemeContract(definition);
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

function validateThemeContract(definition: ContributionDefinition): void {
	assertExclusiveContract(definition, "theme", "theme");
	assertExclusiveContract(definition, "theme-extension", "themeExtension");
	if (definition.theme) {
		if (!semverPattern.test(definition.theme.schemaVersion)) {
			throw invalid("La version du schéma de thème doit respecter SemVer.");
		}
		if (definition.theme.surfaces.length === 0) {
			throw invalid("Un thème doit déclarer au moins une surface.");
		}
		validateUniqueValues(definition.theme.surfaces, "surface de thème");
		if (Object.keys(definition.theme.tokens).length === 0) {
			throw invalid("Un thème doit déclarer au moins un jeton.");
		}
		for (const [identifier, token] of Object.entries(definition.theme.tokens)) {
			validateIdentifier(identifier, "jeton de thème");
			if (!themeTokenTypes.includes(token.type)) throw invalid("Le type du jeton est inconnu.");
			validateThemeTokenValue(token.type, token.value);
			validateLocalizedText(token.description);
		}
		const variants = new Set<string>();
		for (const variant of definition.theme.variants) {
			validateIdentifier(variant.identifier, "variante de thème");
			if (variants.has(variant.identifier)) throw invalid("Une variante de thème est dupliquée.");
			variants.add(variant.identifier);
			validateLocalizedText(variant.label);
			for (const [identifier, value] of Object.entries(variant.tokens)) {
				const token = definition.theme.tokens[identifier];
				if (!token) throw invalid("Une variante référence un jeton de thème inconnu.");
				validateThemeTokenValue(token.type, value);
			}
		}
		if (definition.theme.fallbackThemeIdentifier) {
			validateIdentifier(definition.theme.fallbackThemeIdentifier, "thème de repli");
		}
	}
	if (definition.themeExtension) {
		const extension = definition.themeExtension;
		if (!semverPattern.test(extension.schemaVersion)) {
			throw invalid("La version du schéma d’extension de thème doit respecter SemVer.");
		}
		validateIdentifier(extension.targetThemeIdentifier, "thème cible");
		if (
			!Number.isSafeInteger(extension.order) ||
			extension.order < -10_000 ||
			extension.order > 10_000
		) {
			throw invalid("L’ordre de l’extension de thème est invalide.");
		}
		for (const identifier of Object.keys(extension.tokens)) {
			validateIdentifier(identifier, "jeton d’extension de thème");
		}
		validateUniqueIdentifiers(extension.conflictsWith, "conflit de thème");
	}
}

function validateThemeTokenValue(type: string, value: string | number): void {
	if (type === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw invalid("La valeur numérique d’un jeton de thème est invalide.");
		}
		return;
	}
	if (typeof value !== "string" || !value.trim() || value.length > 512) {
		throw invalid("La valeur textuelle d’un jeton de thème est invalide.");
	}
	if (/url\s*\(|expression\s*\(|[{};]/i.test(value)) {
		throw invalid("Un jeton de thème ne peut pas contenir de CSS arbitraire.");
	}
}

function validateStatisticContract(definition: ContributionDefinition): void {
	assertExclusiveContract(definition, "event", "statisticEvent");
	assertExclusiveContract(definition, "dimension", "statisticDimension");
	assertExclusiveContract(definition, "metric", "statisticMetric");
	assertExclusiveContract(definition, "statistic-policy", "statisticPolicy");

	if (definition.statisticEvent) {
		if (!semverPattern.test(definition.statisticEvent.schemaVersion)) {
			throw invalid("La version du schéma statistique doit respecter SemVer.");
		}
		validateLocalizedText(definition.statisticEvent.purpose);
		validateRetention(definition.statisticEvent.retentionDays);
		for (const [fieldName, field] of Object.entries(definition.statisticEvent.fields)) {
			validateIdentifier(fieldName, "champ statistique");
			assertNonSensitiveStatisticName(fieldName);
			if (
				field.maximumLength !== undefined &&
				(field.type !== "string" ||
					!Number.isSafeInteger(field.maximumLength) ||
					field.maximumLength < 1 ||
					field.maximumLength > 4_096)
			) {
				throw invalid("La longueur maximale d’un champ statistique est invalide.");
			}
			validateScalarValues(field.allowedValues, field.type);
		}
		validateUniqueIdentifiers(
			definition.statisticEvent.dimensionIdentifiers,
			"dimension statistique",
		);
	}

	if (definition.statisticDimension) {
		assertNonSensitiveStatisticName(definition.identifier);
		validateLocalizedText(definition.statisticDimension.purpose);
		if (
			!Number.isSafeInteger(definition.statisticDimension.cardinalityLimit) ||
			definition.statisticDimension.cardinalityLimit < 1 ||
			definition.statisticDimension.cardinalityLimit > 100_000
		) {
			throw invalid("La cardinalité d’une dimension statistique est invalide.");
		}
		validateScalarValues(
			definition.statisticDimension.allowedValues,
			definition.statisticDimension.valueType,
		);
	}

	if (definition.statisticMetric) {
		validateIdentifier(definition.statisticMetric.eventIdentifier, "événement statistique");
		if (definition.statisticMetric.field) {
			validateIdentifier(definition.statisticMetric.field, "champ de métrique");
		}
		if (!/^[A-Za-z][A-Za-z0-9._%/-]{0,31}$/.test(definition.statisticMetric.unit)) {
			throw invalid("L’unité d’une métrique statistique est invalide.");
		}
		if (definition.statisticMetric.granularities.length === 0) {
			throw invalid("Une métrique doit déclarer au moins une granularité.");
		}
		validateUniqueValues(definition.statisticMetric.granularities, "granularité statistique");
		validateUniqueIdentifiers(
			definition.statisticMetric.dimensionIdentifiers,
			"dimension statistique",
		);
	}

	if (definition.statisticPolicy) {
		validateIdentifier(definition.statisticPolicy.purposeIdentifier, "finalité statistique");
		validateRetention(definition.statisticPolicy.retentionDays);
		if (
			!Number.isFinite(definition.statisticPolicy.sampleRate) ||
			definition.statisticPolicy.sampleRate < 0 ||
			definition.statisticPolicy.sampleRate > 1
		) {
			throw invalid("Le taux d’échantillonnage statistique doit être compris entre 0 et 1.");
		}
		if (
			definition.statisticPolicy.anonymizeAfterDays !== undefined &&
			(!Number.isSafeInteger(definition.statisticPolicy.anonymizeAfterDays) ||
				definition.statisticPolicy.anonymizeAfterDays < 0 ||
				definition.statisticPolicy.anonymizeAfterDays > definition.statisticPolicy.retentionDays)
		) {
			throw invalid("Le délai d’anonymisation statistique est invalide.");
		}
	}
}

function validateMessagingContract(definition: ContributionDefinition): void {
	assertExclusiveContract(definition, "message-topic", "messageTopic");
	assertExclusiveContract(definition, "message-template", "messageTemplate");
	if (definition.messageTopic) {
		const topic = definition.messageTopic;
		if (!semverPattern.test(topic.schemaVersion)) {
			throw invalid("La version du schéma de message doit respecter SemVer.");
		}
		validateLocalizedText(topic.purpose);
		if (!messageDeliveryProfiles.includes(topic.profile)) {
			throw invalid("Le profil de livraison du message est inconnu.");
		}
		validateRetention(topic.retentionDays);
		validateUniqueValues(topic.audiences, "audience de message");
		validateUniqueValues(topic.presentations, "présentation de message");
		validateUniqueValues(topic.channels, "canal de message");
		if (
			topic.audiences.length === 0 ||
			topic.presentations.length === 0 ||
			topic.channels.length === 0
		) {
			throw invalid("Un sujet de message doit déclarer audience, présentation et canal.");
		}
		if (
			topic.maximumRecipients !== undefined &&
			(!Number.isSafeInteger(topic.maximumRecipients) ||
				topic.maximumRecipients < 1 ||
				topic.maximumRecipients > 100_000)
		) {
			throw invalid("La limite de destinataires du message est invalide.");
		}
		if (
			topic.profile === "direct-acknowledged" &&
			(topic.audiences.includes("broadcast") ||
				topic.maximumRecipients === undefined ||
				topic.maximumRecipients > 100)
		) {
			throw invalid("Un envoi direct avec accusé doit cibler au plus 100 destinataires.");
		}
		if (
			topic.expiresAfterSeconds !== undefined &&
			(!Number.isSafeInteger(topic.expiresAfterSeconds) ||
				topic.expiresAfterSeconds < 1 ||
				topic.expiresAfterSeconds > 31_536_000)
		) {
			throw invalid("L’expiration du message est invalide.");
		}
		for (const [fieldName, field] of Object.entries(topic.payload)) {
			validateIdentifier(fieldName, "champ de message");
			assertNonSensitiveMessageName(fieldName);
			if (
				field.maximumLength !== undefined &&
				(field.type !== "string" ||
					!Number.isSafeInteger(field.maximumLength) ||
					field.maximumLength < 1 ||
					field.maximumLength > 65_536)
			) {
				throw invalid("La longueur maximale d’un champ de message est invalide.");
			}
		}
	}
	if (definition.messageTemplate) {
		const template = definition.messageTemplate;
		validateIdentifier(template.topicIdentifier, "sujet de modèle de message");
		if (!semverPattern.test(template.templateVersion)) {
			throw invalid("La version du modèle de message doit respecter SemVer.");
		}
		validateSafeLocalizedText(template.title);
		validateSafeLocalizedText(template.body);
		if (template.summary) validateSafeLocalizedText(template.summary);
		for (const [action, labels] of Object.entries(template.actionLabels ?? {})) {
			validateIdentifier(action, "action de message");
			validateSafeLocalizedText(labels);
		}
	}
}

function assertExclusiveContract(
	definition: ContributionDefinition,
	type: ContributionDefinition["type"],
	property:
		| "messageTemplate"
		| "messageTopic"
		| "statisticDimension"
		| "statisticEvent"
		| "statisticMetric"
		| "statisticPolicy"
		| "theme"
		| "themeExtension",
): void {
	const contract = definition[property];
	if (definition.type === type && !contract) {
		throw invalid(`La contribution ${type} doit déclarer son contrat.`);
	}
	if (definition.type !== type && contract) {
		throw invalid(`Le contrat ${property} ne peut appartenir qu’à une contribution ${type}.`);
	}
}

function validateRetention(days: number): void {
	if (!Number.isSafeInteger(days) || days < 1 || days > 3_650) {
		throw invalid("La durée de conservation doit être comprise entre 1 et 3 650 jours.");
	}
}

function validateScalarValues(
	values: readonly (boolean | number | string)[] | undefined,
	type: string,
): void {
	if (!values) return;
	if (values.length === 0 || values.length > 1_000) {
		throw invalid("La liste des valeurs statistiques autorisées est invalide.");
	}
	for (const value of values) {
		const expectedType = type === "duration" || type === "integer" ? "number" : type;
		if (typeof value !== expectedType || (type === "integer" && !Number.isSafeInteger(value))) {
			throw invalid("Une valeur statistique autorisée ne correspond pas au type déclaré.");
		}
	}
	validateUniqueValues(values, "valeur statistique");
}

function validateUniqueIdentifiers(values: readonly string[] | undefined, label: string): void {
	if (!values) return;
	for (const value of values) validateIdentifier(value, label);
	validateUniqueValues(values, label);
}

function validateUniqueValues(values: readonly unknown[], label: string): void {
	if (new Set(values).size !== values.length) {
		throw invalid(`Une ${label} est déclarée plusieurs fois.`);
	}
}

function assertNonSensitiveStatisticName(name: string): void {
	if (/(?:content|email|password|secret|token)/i.test(name)) {
		throw invalid("Un champ statistique ne peut pas contenir une donnée sensible interdite.");
	}
}

function assertNonSensitiveMessageName(name: string): void {
	if (/(?:2fa|mfa|password|recovery.?code|secret|token)/i.test(name)) {
		throw invalid("Une charge de message ne peut pas déclarer de secret ou de facteur.");
	}
}

function validateSafeLocalizedText(value: Readonly<Record<string, string>>): void {
	validateLocalizedText(value);
	for (const text of Object.values(value)) {
		if (/<\/?[A-Za-z][^>]*>|javascript:|on[a-z]+\s*=/i.test(text)) {
			throw invalid("Un modèle de message ne peut pas contenir de HTML ou de script.");
		}
	}
}

function validateConnector(connector: NonNullable<ContributionDefinition["connector"]>): void {
	validateIdentifier(connector.identifier, "connecteur");
	let baseUrl: URL;
	try {
		baseUrl = new URL(connector.baseUrl);
	} catch {
		throw invalid("L’URL de base du connecteur est invalide.");
	}
	if (
		baseUrl.protocol !== "https:" ||
		baseUrl.username ||
		baseUrl.password ||
		baseUrl.search ||
		baseUrl.hash ||
		(baseUrl.port && baseUrl.port !== "443")
	) {
		throw invalid("L’URL de base du connecteur doit être une URL HTTPS sûre.");
	}
	if (connector.allowedDomains.length === 0)
		throw invalid("Le connecteur doit autoriser au moins un domaine.");
	for (const domain of connector.allowedDomains) validateDomain(domain);
	if (!connector.allowedDomains.includes(baseUrl.hostname.toLowerCase())) {
		throw invalid("Le domaine de l’URL de base doit être explicitement autorisé.");
	}
	const endpointIdentifiers = new Set<string>();
	for (const endpoint of connector.endpoints) {
		validateIdentifier(endpoint.identifier, "endpoint de connecteur");
		if (endpointIdentifiers.has(endpoint.identifier))
			throw invalid("Un endpoint de connecteur est dupliqué.");
		endpointIdentifiers.add(endpoint.identifier);
		if (
			!/^\/(?:[A-Za-z0-9._~-]+|:[a-z][a-z0-9]*)(?:\/(?:[A-Za-z0-9._~-]+|:[a-z][a-z0-9]*))*$/.test(
				endpoint.path,
			)
		) {
			throw invalid("Le chemin d’un endpoint de connecteur est invalide.");
		}
		if (
			endpoint.successStatuses.length === 0 ||
			endpoint.successStatuses.some(
				(status) => !Number.isSafeInteger(status) || status < 200 || status > 399,
			)
		) {
			throw invalid("Les statuts de succès du connecteur sont invalides.");
		}
		validatePositiveLimit(endpoint.maximumResponseBytes, 64 * 1024 * 1024, "taille de réponse");
		validatePositiveLimit(endpoint.timeoutMs, 120_000, "délai");
		validateNonNegativeLimit(endpoint.retries, 5, "nombre de nouvelles tentatives");
		validateNonNegativeLimit(endpoint.cacheTtlSeconds, 86_400, "durée du cache");
		if (endpoint.retries && endpoint.method !== "GET" && !endpoint.retrySafe) {
			throw invalid(
				"Un endpoint non idempotent doit confirmer que ses nouvelles tentatives sont sûres.",
			);
		}
		for (const path of endpoint.response.requiredJsonPaths ?? []) validateJsonPath(path);
		if (endpoint.response.format !== "json" && endpoint.response.requiredJsonPaths?.length) {
			throw invalid("Les chemins de réponse ne sont utilisables qu’avec le format JSON.");
		}
		const parameters = new Set<string>();
		for (const parameter of endpoint.parameters ?? []) {
			validateIdentifier(parameter.name, "paramètre de connecteur");
			if (parameters.has(parameter.name)) throw invalid("Un paramètre de connecteur est dupliqué.");
			parameters.add(parameter.name);
			if (
				parameter.location === "header" &&
				["authorization", "cookie", "host"].includes(parameter.name.toLowerCase())
			) {
				throw invalid("Cet en-tête est réservé au Core.");
			}
		}
		for (const placeholder of endpoint.path.matchAll(/:([a-z][a-z0-9]*)/g)) {
			if (
				!endpoint.parameters?.some(
					(parameter) =>
						parameter.name === placeholder[1] &&
						parameter.location === "path" &&
						parameter.required,
				)
			) {
				throw invalid("Chaque paramètre de chemin doit être déclaré comme obligatoire.");
			}
		}
	}
	if (!endpointIdentifiers.has(connector.connectionTestEndpoint)) {
		throw invalid("L’endpoint de test de connexion est inconnu.");
	}
	validateAuthentication(connector.authentication, baseUrl, new Set(connector.allowedDomains));
	validatePositiveLimit(connector.timeoutMs, 120_000, "délai global");
	validateNonNegativeLimit(connector.retries, 5, "nouvelles tentatives globales");
	validateNonNegativeLimit(connector.cacheTtlSeconds, 86_400, "cache global");
	if (connector.quota) {
		validatePositiveLimit(connector.quota.limit, 1_000_000, "quota");
		validatePositiveLimit(connector.quota.windowSeconds, 86_400, "fenêtre de quota");
	}
}

function validateAuthentication(
	authentication: NonNullable<ContributionDefinition["connector"]>["authentication"],
	baseUrl: URL,
	allowedDomains: ReadonlySet<string>,
): void {
	if (authentication.kind === "none") return;
	if (authentication.kind === "api-key") {
		validateSecretReference(authentication.secretReference);
		if (
			!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(authentication.header) ||
			["cookie", "host"].includes(authentication.header.toLowerCase())
		) {
			throw invalid("L’en-tête de clé API est invalide.");
		}
		return;
	}
	if (authentication.kind === "basic") {
		validateSecretReference(authentication.usernameSecretReference);
		validateSecretReference(authentication.passwordSecretReference);
		return;
	}
	if (authentication.kind === "bearer") {
		validateSecretReference(authentication.secretReference);
		return;
	}
	validateSecretReference(authentication.clientIdSecretReference);
	if (authentication.clientSecretReference)
		validateSecretReference(authentication.clientSecretReference);
	validateEndpointReference(authentication.tokenEndpoint, "jeton OAuth");
	if (authentication.flow === "client-credentials" && !authentication.clientSecretReference) {
		throw invalid("Le flux Client Credentials exige un secret client.");
	}
	if (authentication.flow === "authorization-code-pkce" && !authentication.authorizationEndpoint) {
		throw invalid("Le flux PKCE exige un endpoint d’autorisation.");
	}
	if (authentication.flow === "device-code" && !authentication.deviceAuthorizationEndpoint) {
		throw invalid("Le flux Device Code exige son endpoint d’autorisation.");
	}
	if (authentication.authorizationEndpoint)
		validateEndpointReference(authentication.authorizationEndpoint, "autorisation OAuth");
	if (authentication.deviceAuthorizationEndpoint)
		validateEndpointReference(authentication.deviceAuthorizationEndpoint, "Device Code");
	for (const endpoint of [
		authentication.tokenEndpoint,
		authentication.authorizationEndpoint,
		authentication.deviceAuthorizationEndpoint,
	]) {
		if (!endpoint) continue;
		const url = new URL(endpoint, baseUrl);
		if (!allowedDomains.has(url.hostname.toLowerCase())) {
			throw invalid("Un endpoint OAuth utilise un domaine qui n’est pas autorisé.");
		}
	}
	for (const path of [
		authentication.accessTokenPath,
		authentication.refreshTokenPath,
		authentication.expiresInPath,
	]) {
		if (path) validateJsonPath(path);
	}
}

function validateFrontendNetwork(
	network: NonNullable<ContributionDefinition["frontendNetwork"]>,
): void {
	validateIdentifier(network.ownerIdentifier, "propriétaire réseau frontend");
	if (network.domains.length === 0 || network.methods.length === 0) {
		throw invalid("La politique réseau frontend doit déclarer des domaines et méthodes.");
	}
	for (const domain of network.domains) validateDomain(domain);
}

function validateSecretReference(reference: string): void {
	if (!/^[a-z][a-z0-9-]{1,31}:[A-Za-z0-9_./-]{1,256}$/.test(reference)) {
		throw invalid("Une référence de secret est invalide.");
	}
}

function validateDomain(domain: string): void {
	if (
		domain !== domain.toLowerCase() ||
		!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ||
		domain.endsWith(".local")
	) {
		throw invalid("Un domaine déclaré est invalide.");
	}
}

function validateEndpointReference(value: string, label: string): void {
	if (
		!/^\/[A-Za-z0-9._~:/-]+$/.test(value) &&
		!/^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~:/-]*)?$/.test(value)
	) {
		throw invalid(`L’endpoint ${label} est invalide.`);
	}
}

function validateJsonPath(path: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)) {
		throw invalid("Un chemin JSON déclaré est invalide.");
	}
}

function validatePositiveLimit(value: number | undefined, maximum: number, label: string): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) {
		throw invalid(`La ${label} du connecteur est invalide.`);
	}
}

function validateNonNegativeLimit(value: number | undefined, maximum: number, label: string): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > maximum)) {
		throw invalid(`La valeur ${label} du connecteur est invalide.`);
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
