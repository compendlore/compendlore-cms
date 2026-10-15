import {
	canonicalizeLocale,
	localizationResourceIdentifier,
	localizedTextFormats,
	type LocalizationMaterializationPort,
	type LocalizedTextValueDefinition,
} from "../../core/src/index.js";
import { contributionKey, type ContributionDefinition } from "./contracts.js";
import { RegistryError } from "./errors.js";

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const RESOURCE_IDENTIFIER_PATTERN =
	/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export function validateLocalizedTextContribution(definition: ContributionDefinition): void {
	const localizedTexts = definition.localizedTexts;
	if (!localizedTexts) return;
	if (!localizedTexts.resources?.length && !localizedTexts.translations?.length) {
		throw invalid();
	}
	if ((localizedTexts.resources?.length ?? 0) + (localizedTexts.translations?.length ?? 0) > 512) {
		throw invalid();
	}
	if (definition.type === "translation" && localizedTexts.resources?.length) throw invalid();
	if (definition.type !== "translation" && localizedTexts.translations?.length) throw invalid();

	const resources = new Set<string>();
	for (const resource of localizedTexts.resources ?? []) {
		if (
			!IDENTIFIER_PATTERN.test(resource.namespace) ||
			!IDENTIFIER_PATTERN.test(resource.key) ||
			!localizedTextFormats.includes(resource.format) ||
			typeof resource.allowInstanceOverride !== "boolean" ||
			typeof resource.required !== "boolean"
		) {
			throw invalid();
		}
		const identifier = `${resource.namespace}:${resource.key}`;
		if (resources.has(identifier)) throw invalid();
		resources.add(identifier);
		validateValues(resource.values);
	}

	const targets = new Set<string>();
	for (const translation of localizedTexts.translations ?? []) {
		if (!RESOURCE_IDENTIFIER_PATTERN.test(translation.resourceIdentifier)) throw invalid();
		if (targets.has(translation.resourceIdentifier)) throw invalid();
		targets.add(translation.resourceIdentifier);
		validateValues(translation.values);
	}
}

export async function materializeLocalizedTextContribution(
	definition: ContributionDefinition,
	port: LocalizationMaterializationPort,
): Promise<void> {
	validateLocalizedTextContribution(definition);
	if (!definition.localizedTexts) return;
	const sourceContributionKey = contributionKey(definition.type, definition.identifier);
	const resources = (definition.localizedTexts.resources ?? []).map((resource) => ({
		identifier: localizationResourceIdentifier(
			sourceContributionKey,
			resource.namespace,
			resource.key,
		),
		ownerContributionKey: sourceContributionKey,
		namespace: resource.namespace,
		key: resource.key,
		format: resource.format,
		allowInstanceOverride: resource.allowInstanceOverride,
		required: resource.required,
	}));
	const values: LocalizedTextValueDefinition[] = [];
	for (const resource of definition.localizedTexts.resources ?? []) {
		const resourceIdentifier = localizationResourceIdentifier(
			sourceContributionKey,
			resource.namespace,
			resource.key,
		);
		for (const [locale, value] of Object.entries(resource.values)) {
			values.push({
				resourceIdentifier,
				locale: canonicalizeLocale(locale),
				sourceLayer: "owner",
				sourceContributionKey,
				value,
			});
		}
	}
	for (const translation of definition.localizedTexts.translations ?? []) {
		for (const [locale, value] of Object.entries(translation.values)) {
			values.push({
				resourceIdentifier: translation.resourceIdentifier,
				locale: canonicalizeLocale(locale),
				sourceLayer: "translation",
				sourceContributionKey,
				value,
			});
		}
	}
	await port.materializeLocalization({ sourceContributionKey, resources, values });
}

function validateValues(values: Readonly<Record<string, string>>): void {
	if (
		!values ||
		typeof values !== "object" ||
		Array.isArray(values) ||
		!Object.keys(values).length
	) {
		throw invalid();
	}
	const canonicalLocales = new Set<string>();
	for (const [locale, value] of Object.entries(values)) {
		let canonical: string;
		try {
			canonical = canonicalizeLocale(locale);
		} catch {
			throw invalid();
		}
		if (canonicalLocales.has(canonical) || typeof value !== "string" || !value.trim()) {
			throw invalid();
		}
		canonicalLocales.add(canonical);
	}
}

function invalid(): RegistryError {
	return new RegistryError(
		"registry.contract_invalid",
		"The localized text declaration is invalid.",
	);
}
