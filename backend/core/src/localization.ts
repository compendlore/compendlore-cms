import { CoreError } from "./errors.js";

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAXIMUM_LOCALE_LENGTH = 64;
const MAXIMUM_VALUE_LENGTH = 65_536;

export const localizedTextFormats = ["plain", "multiline"] as const;
export type LocalizedTextFormat = (typeof localizedTextFormats)[number];

export const localizationSourceLayers = ["owner", "translation", "instance"] as const;
export type LocalizationSourceLayer = (typeof localizationSourceLayers)[number];

export interface LocalizedTextResourceDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly namespace: string;
	readonly key: string;
	readonly format: LocalizedTextFormat;
	readonly allowInstanceOverride: boolean;
	readonly required: boolean;
}

export interface LocalizedTextValueDefinition {
	readonly resourceIdentifier: string;
	readonly locale: string;
	readonly sourceLayer: LocalizationSourceLayer;
	readonly sourceContributionKey: string;
	readonly value: string;
	readonly expectedRevision?: number;
	readonly createdBy?: string;
}

export interface StoredLocalizedTextValue extends LocalizedTextValueDefinition {
	readonly locale: string;
	readonly revision: number;
	readonly active: boolean;
}

export interface LocalizationMaterialization {
	readonly sourceContributionKey: string;
	readonly resources: readonly LocalizedTextResourceDefinition[];
	readonly values: readonly LocalizedTextValueDefinition[];
}

export function coreLocalizationFoundation(): LocalizationMaterialization {
	const sourceContributionKey = "core.localization";
	const definitions = [
		["installation", "title", "Compendlore installation"],
		["security", "access_denied", "Access denied"],
		["errors", "internal", "An internal error occurred"],
	] as const;
	return {
		sourceContributionKey,
		resources: definitions.map(([namespace, key]) => ({
			identifier: localizationResourceIdentifier(sourceContributionKey, namespace, key),
			ownerContributionKey: sourceContributionKey,
			namespace,
			key,
			format: "plain",
			allowInstanceOverride: false,
			required: true,
		})),
		values: definitions.map(([namespace, key, value]) => ({
			resourceIdentifier: localizationResourceIdentifier(sourceContributionKey, namespace, key),
			locale: "en",
			sourceLayer: "owner",
			sourceContributionKey,
			value,
		})),
	};
}

export interface InstanceLocaleDefinition {
	readonly instanceId: string;
	readonly locale: string;
	readonly enabled: boolean;
	readonly displayOrder: number;
	readonly default: boolean;
	readonly fallbackLocale?: string;
	readonly flagMediaId?: string;
}

export interface TranslationSourceSelection {
	readonly instanceId: string;
	readonly targetContributionKey: string;
	readonly locale: string;
	readonly sourceContributionKey: string;
	readonly priority: number;
	readonly enabled: boolean;
	readonly updatedBy: string;
}

export interface LocalizationResolutionContext {
	readonly instanceId: string;
	readonly requestedLocale?: string;
	readonly userLocale?: string;
	readonly sessionLocale?: string;
	readonly requestLocale?: string;
	readonly includeProvenance?: boolean;
}

export interface ResolvedLocalizedText {
	readonly resourceIdentifier: string;
	readonly value: string;
	readonly locale: string;
	readonly revision: number;
	readonly missing: boolean;
	readonly sourceLayer?: LocalizationSourceLayer;
	readonly sourceContributionKey?: string;
}

export interface LocalizationWithdrawalImpact {
	readonly contributionKey: string;
	readonly ownedResourceIdentifiers: readonly string[];
	readonly translatedResourceIdentifiers: readonly string[];
	readonly selectedByInstances: readonly string[];
	readonly blocked: boolean;
}

export interface LocalizationRepository {
	materialize(input: LocalizationMaterialization): Promise<void>;
	findResource(identifier: string): Promise<LocalizedTextResourceDefinition | undefined>;
	listResources(): Promise<readonly LocalizedTextResourceDefinition[]>;
	listActiveValues(
		resourceIdentifier: string,
		locale: string,
	): Promise<readonly StoredLocalizedTextValue[]>;
	configureInstanceLocale(definition: InstanceLocaleDefinition): Promise<void>;
	listInstanceLocales(instanceId: string): Promise<readonly InstanceLocaleDefinition[]>;
	selectTranslationSource(selection: TranslationSourceSelection): Promise<void>;
	listTranslationSources(
		instanceId: string,
		targetContributionKey: string,
		locale: string,
	): Promise<readonly TranslationSourceSelection[]>;
	inspectWithdrawal(contributionKey: string): Promise<LocalizationWithdrawalImpact>;
	archiveContribution(contributionKey: string): Promise<void>;
}

export interface LocalizationMaterializationPort {
	materializeLocalization(input: LocalizationMaterialization): Promise<void>;
}

export interface LocalizationResolutionPort {
	resolveLocalizedText(
		resourceIdentifier: string,
		context: LocalizationResolutionContext,
	): Promise<ResolvedLocalizedText>;
	resolveLocalizedTexts(
		resourceIdentifiers: readonly string[],
		context: LocalizationResolutionContext,
	): Promise<readonly ResolvedLocalizedText[]>;
}

export interface LocalizationAdministrationPort {
	configureInstanceLocale(definition: InstanceLocaleDefinition): Promise<void>;
	selectTranslationSource(selection: TranslationSourceSelection): Promise<void>;
}

export interface LocalizationWithdrawalPort {
	inspectLocalizationWithdrawal(contributionKey: string): Promise<LocalizationWithdrawalImpact>;
	archiveLocalizationContribution(contributionKey: string): Promise<void>;
}

export class LocalizationService
	implements
		LocalizationMaterializationPort,
		LocalizationResolutionPort,
		LocalizationAdministrationPort,
		LocalizationWithdrawalPort
{
	constructor(private readonly repository: LocalizationRepository) {}

	async materializeLocalization(input: LocalizationMaterialization): Promise<void> {
		validateContributionKey(input.sourceContributionKey);
		const identifiers = new Set<string>();
		for (const resource of input.resources) {
			validateResource(resource);
			if (resource.ownerContributionKey !== input.sourceContributionKey) {
				throw invalid("A contribution can only create its own localized resources.");
			}
			if (identifiers.has(resource.identifier)) {
				throw invalid("A localized resource is declared more than once.");
			}
			identifiers.add(resource.identifier);
		}

		for (const value of input.values) {
			validateValue(value);
			if (value.sourceContributionKey !== input.sourceContributionKey) {
				throw invalid("The localized value source does not match its contribution.");
			}
			const declared = input.resources.find(
				(resource) => resource.identifier === value.resourceIdentifier,
			);
			const existing = declared ?? (await this.repository.findResource(value.resourceIdentifier));
			if (!existing) throw invalid("The localized resource is not registered.");
			assertLayerAuthority(existing, value);
		}

		for (const resource of input.resources.filter((candidate) => candidate.required)) {
			if (
				!input.values.some(
					(value) =>
						value.resourceIdentifier === resource.identifier && value.sourceLayer === "owner",
				)
			) {
				throw invalid("A required localized resource needs an owner value.");
			}
		}

		await this.repository.materialize({
			...input,
			resources: input.resources.map((resource) => ({ ...resource })),
			values: input.values.map((value) => ({ ...value, locale: canonicalizeLocale(value.locale) })),
		});
	}

	async configureInstanceLocale(definition: InstanceLocaleDefinition): Promise<void> {
		validateInstanceLocale(definition);
		const locale = canonicalizeLocale(definition.locale);
		const fallbackLocale = definition.fallbackLocale
			? canonicalizeLocale(definition.fallbackLocale)
			: undefined;
		if (locale === fallbackLocale) throw invalid("A locale cannot fall back to itself.");

		const current = await this.repository.listInstanceLocales(definition.instanceId);
		const next = [
			...current.filter((candidate) => canonicalizeLocale(candidate.locale) !== locale),
			{ ...definition, locale, ...(fallbackLocale ? { fallbackLocale } : {}) },
		];
		assertFallbackGraph(next);
		if (definition.default && !definition.enabled) {
			throw invalid("The default instance locale must be enabled.");
		}
		await this.repository.configureInstanceLocale({
			...definition,
			locale,
			...(fallbackLocale ? { fallbackLocale } : {}),
		});
	}

	async selectTranslationSource(selection: TranslationSourceSelection): Promise<void> {
		validateTranslationSelection(selection);
		await this.repository.selectTranslationSource({
			...selection,
			locale: canonicalizeLocale(selection.locale),
		});
	}

	async resolveLocalizedText(
		resourceIdentifier: string,
		context: LocalizationResolutionContext,
	): Promise<ResolvedLocalizedText> {
		const resource = await this.repository.findResource(resourceIdentifier);
		if (!resource) throw invalid("The localized resource is not registered.");
		const locales = await this.repository.listInstanceLocales(context.instanceId);
		const candidates = localeCandidates(context, locales);

		for (const locale of candidates) {
			const values = await this.repository.listActiveValues(resourceIdentifier, locale);
			const selected = await this.selectValue(resource, locale, context.instanceId, values);
			if (selected) return resolvedValue(selected, context.includeProvenance ?? false);
		}

		if (resource.required) {
			throw new CoreError(
				"lifecycle.invalid_state",
				"A required localized resource has no resolvable value.",
			);
		}
		return {
			resourceIdentifier,
			value: `[${resource.namespace}.${resource.key}]`,
			locale: candidates[0] ?? "und",
			revision: 0,
			missing: true,
		};
	}

	async resolveLocalizedTexts(
		resourceIdentifiers: readonly string[],
		context: LocalizationResolutionContext,
	): Promise<readonly ResolvedLocalizedText[]> {
		if (new Set(resourceIdentifiers).size !== resourceIdentifiers.length) {
			throw invalid("A localized resource is requested more than once.");
		}
		return Promise.all(
			resourceIdentifiers.map((identifier) => this.resolveLocalizedText(identifier, context)),
		);
	}

	inspectLocalizationWithdrawal(contributionKey: string): Promise<LocalizationWithdrawalImpact> {
		validateContributionKey(contributionKey);
		return this.repository.inspectWithdrawal(contributionKey);
	}

	async archiveLocalizationContribution(contributionKey: string): Promise<void> {
		const impact = await this.inspectLocalizationWithdrawal(contributionKey);
		if (impact.blocked) {
			throw new CoreError(
				"infrastructure.conflict",
				"The localization contribution is still selected by an instance.",
			);
		}
		await this.repository.archiveContribution(contributionKey);
	}

	private async selectValue(
		resource: LocalizedTextResourceDefinition,
		locale: string,
		instanceId: string,
		values: readonly StoredLocalizedTextValue[],
	): Promise<StoredLocalizedTextValue | undefined> {
		if (resource.allowInstanceOverride) {
			const instance = values.find((value) => value.sourceLayer === "instance");
			if (instance) return instance;
		}
		const sources = await this.repository.listTranslationSources(
			instanceId,
			resource.ownerContributionKey,
			locale,
		);
		for (const source of sources.filter((candidate) => candidate.enabled)) {
			const translation = values.find(
				(value) =>
					value.sourceLayer === "translation" &&
					value.sourceContributionKey === source.sourceContributionKey,
			);
			if (translation) return translation;
		}
		return values.find(
			(value) =>
				value.sourceLayer === "owner" &&
				value.sourceContributionKey === resource.ownerContributionKey,
		);
	}
}

export class InMemoryLocalizationRepository implements LocalizationRepository {
	private resources = new Map<string, LocalizedTextResourceDefinition>();
	private values: StoredLocalizedTextValue[] = [];
	private locales = new Map<string, InstanceLocaleDefinition>();
	private selections = new Map<string, TranslationSourceSelection>();

	async materialize(input: LocalizationMaterialization): Promise<void> {
		const resources = new Map(this.resources);
		const values = this.values.map((value) => ({ ...value }));
		for (const resource of input.resources) {
			const current = resources.get(resource.identifier);
			if (current && stableJson(current) !== stableJson(resource)) {
				throw new CoreError(
					"infrastructure.conflict",
					"The localized resource definition conflicts with its active version.",
				);
			}
			resources.set(resource.identifier, { ...resource });
		}

		for (const value of input.values) {
			const active = values.find(
				(candidate) =>
					candidate.active &&
					candidate.resourceIdentifier === value.resourceIdentifier &&
					candidate.locale === value.locale &&
					candidate.sourceLayer === value.sourceLayer &&
					candidate.sourceContributionKey === value.sourceContributionKey,
			);
			if (active?.value === value.value) continue;
			if (
				value.expectedRevision !== undefined &&
				value.expectedRevision !== (active?.revision ?? 0)
			) {
				throw new CoreError("infrastructure.conflict", "The localized value revision is stale.");
			}
			if (active) {
				const activeIndex = values.indexOf(active);
				values[activeIndex] = { ...active, active: false };
			}
			const revision =
				Math.max(
					0,
					...values
						.filter(
							(candidate) =>
								candidate.resourceIdentifier === value.resourceIdentifier &&
								candidate.locale === value.locale &&
								candidate.sourceLayer === value.sourceLayer &&
								candidate.sourceContributionKey === value.sourceContributionKey,
						)
						.map((candidate) => candidate.revision),
				) + 1;
			values.push({ ...value, revision, active: true });
		}
		this.resources = resources;
		this.values = values;
	}

	async findResource(identifier: string): Promise<LocalizedTextResourceDefinition | undefined> {
		const resource = this.resources.get(identifier);
		return resource ? { ...resource } : undefined;
	}

	async listResources(): Promise<readonly LocalizedTextResourceDefinition[]> {
		return [...this.resources.values()].map((resource) => ({ ...resource }));
	}

	async listActiveValues(
		resourceIdentifier: string,
		locale: string,
	): Promise<readonly StoredLocalizedTextValue[]> {
		const canonical = canonicalizeLocale(locale);
		return this.values
			.filter(
				(value) =>
					value.active &&
					value.resourceIdentifier === resourceIdentifier &&
					value.locale === canonical,
			)
			.map((value) => ({ ...value }));
	}

	async configureInstanceLocale(definition: InstanceLocaleDefinition): Promise<void> {
		if (definition.default) {
			for (const [key, candidate] of this.locales) {
				if (candidate.instanceId === definition.instanceId && candidate.default) {
					this.locales.set(key, { ...candidate, default: false });
				}
			}
		}
		this.locales.set(localeKey(definition.instanceId, definition.locale), { ...definition });
	}

	async listInstanceLocales(instanceId: string): Promise<readonly InstanceLocaleDefinition[]> {
		return [...this.locales.values()]
			.filter((locale) => locale.instanceId === instanceId)
			.sort((first, second) => first.displayOrder - second.displayOrder)
			.map((locale) => ({ ...locale }));
	}

	async selectTranslationSource(selection: TranslationSourceSelection): Promise<void> {
		this.selections.set(selectionKey(selection), { ...selection });
	}

	async listTranslationSources(
		instanceId: string,
		targetContributionKey: string,
		locale: string,
	): Promise<readonly TranslationSourceSelection[]> {
		return [...this.selections.values()]
			.filter(
				(selection) =>
					selection.instanceId === instanceId &&
					selection.targetContributionKey === targetContributionKey &&
					selection.locale === locale,
			)
			.sort(
				(first, second) =>
					first.priority - second.priority ||
					first.sourceContributionKey.localeCompare(second.sourceContributionKey),
			)
			.map((selection) => ({ ...selection }));
	}

	async inspectWithdrawal(contributionKey: string): Promise<LocalizationWithdrawalImpact> {
		const ownedResourceIdentifiers = [...this.resources.values()]
			.filter((resource) => resource.ownerContributionKey === contributionKey)
			.map((resource) => resource.identifier)
			.sort();
		const translatedResourceIdentifiers = [
			...new Set(
				this.values
					.filter(
						(value) =>
							value.active &&
							value.sourceLayer === "translation" &&
							value.sourceContributionKey === contributionKey,
					)
					.map((value) => value.resourceIdentifier),
			),
		].sort();
		const selectedByInstances = [
			...new Set(
				[...this.selections.values()]
					.filter(
						(selection) => selection.enabled && selection.sourceContributionKey === contributionKey,
					)
					.map((selection) => selection.instanceId),
			),
		].sort();
		return {
			contributionKey,
			ownedResourceIdentifiers,
			translatedResourceIdentifiers,
			selectedByInstances,
			blocked: selectedByInstances.length > 0,
		};
	}

	async archiveContribution(contributionKey: string): Promise<void> {
		this.values = this.values.map((value) =>
			value.sourceContributionKey === contributionKey ? { ...value, active: false } : value,
		);
	}
}

export function canonicalizeLocale(locale: string): string {
	if (
		typeof locale !== "string" ||
		!locale.trim() ||
		locale.length > MAXIMUM_LOCALE_LENGTH ||
		locale.includes("_")
	) {
		throw invalid("The locale tag is invalid.");
	}
	try {
		const [canonical] = Intl.getCanonicalLocales(locale.trim());
		if (!canonical) throw new RangeError("Missing locale");
		return canonical;
	} catch {
		throw invalid("The locale tag is invalid.");
	}
}

export function localizationResourceIdentifier(
	ownerContributionKey: string,
	namespace: string,
	key: string,
): string {
	validateContributionKey(ownerContributionKey);
	validateIdentifier(namespace, "localized namespace");
	validateIdentifier(key, "localized key");
	return `${ownerContributionKey}:${namespace}:${key}`;
}

function localeCandidates(
	context: LocalizationResolutionContext,
	configured: readonly InstanceLocaleDefinition[],
): readonly string[] {
	const enabled = new Map(
		configured
			.filter((locale) => locale.enabled)
			.map((locale) => [canonicalizeLocale(locale.locale), locale]),
	);
	const candidates: string[] = [];
	const append = (locale: string | undefined): void => {
		if (!locale) return;
		let current = canonicalizeLocale(locale);
		while (current) {
			if (!candidates.includes(current)) candidates.push(current);
			const separator = current.lastIndexOf("-");
			if (separator < 0) break;
			current = current.slice(0, separator);
		}
	};
	for (const locale of [
		context.requestedLocale,
		context.userLocale,
		context.sessionLocale,
		context.requestLocale?.split(",", 1)[0]?.trim(),
	]) {
		append(locale);
	}
	append(configured.find((locale) => locale.default && locale.enabled)?.locale);
	for (let index = 0; index < candidates.length; index += 1) {
		append(enabled.get(candidates[index]!)?.fallbackLocale);
	}
	return candidates;
}

function assertFallbackGraph(locales: readonly InstanceLocaleDefinition[]): void {
	const fallbacks = new Map(
		locales
			.filter((locale) => locale.fallbackLocale)
			.map((locale) => [
				canonicalizeLocale(locale.locale),
				canonicalizeLocale(locale.fallbackLocale!),
			]),
	);
	for (const locale of fallbacks.keys()) {
		const seen = new Set<string>();
		let current: string | undefined = locale;
		while (current) {
			if (seen.has(current)) throw invalid("The locale fallback chain contains a cycle.");
			seen.add(current);
			current = fallbacks.get(current);
		}
	}
}

function validateResource(resource: LocalizedTextResourceDefinition): void {
	validateContributionKey(resource.ownerContributionKey);
	validateIdentifier(resource.namespace, "localized namespace");
	validateIdentifier(resource.key, "localized key");
	if (
		resource.identifier !==
		localizationResourceIdentifier(resource.ownerContributionKey, resource.namespace, resource.key)
	) {
		throw invalid("The localized resource identifier is not canonical.");
	}
	if (!localizedTextFormats.includes(resource.format))
		throw invalid("The localized format is invalid.");
	if (
		typeof resource.allowInstanceOverride !== "boolean" ||
		typeof resource.required !== "boolean"
	) {
		throw invalid("The localized resource policy is invalid.");
	}
}

function validateValue(value: LocalizedTextValueDefinition): void {
	canonicalizeLocale(value.locale);
	validateContributionKey(value.sourceContributionKey);
	if (!localizationSourceLayers.includes(value.sourceLayer)) {
		throw invalid("The localized value source layer is invalid.");
	}
	if (!value.value.trim() || value.value.length > MAXIMUM_VALUE_LENGTH) {
		throw invalid("The localized value is invalid.");
	}
	if (
		value.expectedRevision !== undefined &&
		(!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)
	) {
		throw invalid("The localized value revision is invalid.");
	}
	if (value.sourceLayer === "instance" && !value.createdBy) {
		throw invalid("An instance override requires an administrative actor.");
	}
}

function assertLayerAuthority(
	resource: LocalizedTextResourceDefinition,
	value: LocalizedTextValueDefinition,
): void {
	if (
		(value.sourceLayer === "owner") !==
		(value.sourceContributionKey === resource.ownerContributionKey)
	) {
		throw invalid("The localized value layer does not match resource ownership.");
	}
	if (value.sourceLayer === "instance" && !resource.allowInstanceOverride) {
		throw new CoreError("authorization.denied", "The localized resource cannot be overridden.");
	}
}

function validateInstanceLocale(definition: InstanceLocaleDefinition): void {
	validateUuid(definition.instanceId, "instance");
	canonicalizeLocale(definition.locale);
	if (definition.fallbackLocale) canonicalizeLocale(definition.fallbackLocale);
	if (!Number.isSafeInteger(definition.displayOrder) || definition.displayOrder < 0) {
		throw invalid("The instance locale order is invalid.");
	}
	if (definition.flagMediaId) validateUuid(definition.flagMediaId, "flag media");
}

function validateTranslationSelection(selection: TranslationSourceSelection): void {
	validateUuid(selection.instanceId, "instance");
	validateUuid(selection.updatedBy, "actor");
	validateContributionKey(selection.targetContributionKey);
	validateContributionKey(selection.sourceContributionKey);
	canonicalizeLocale(selection.locale);
	if (
		selection.targetContributionKey === selection.sourceContributionKey ||
		!Number.isSafeInteger(selection.priority) ||
		selection.priority < 0
	) {
		throw invalid("The translation source selection is invalid.");
	}
}

function resolvedValue(
	value: StoredLocalizedTextValue,
	includeProvenance: boolean,
): ResolvedLocalizedText {
	return {
		resourceIdentifier: value.resourceIdentifier,
		value: value.value,
		locale: value.locale,
		revision: value.revision,
		missing: false,
		...(includeProvenance
			? {
					sourceLayer: value.sourceLayer,
					sourceContributionKey: value.sourceContributionKey,
				}
			: {}),
	};
}

function validateContributionKey(value: string): void {
	if (!IDENTIFIER_PATTERN.test(value) || value.length > 160) {
		throw invalid("The localization contribution key is invalid.");
	}
}

function validateIdentifier(value: string, label: string): void {
	if (!IDENTIFIER_PATTERN.test(value) || value.length > 120) {
		throw invalid(`The ${label} is invalid.`);
	}
}

function validateUuid(value: string, label: string): void {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
		throw invalid(`The ${label} identifier is invalid.`);
	}
}

function localeKey(instanceId: string, locale: string): string {
	return `${instanceId}:${canonicalizeLocale(locale)}`;
}

function selectionKey(selection: TranslationSourceSelection): string {
	return `${selection.instanceId}:${selection.targetContributionKey}:${selection.locale}:${selection.sourceContributionKey}`;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([first], [second]) => first.localeCompare(second))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function invalid(message: string): CoreError {
	return new CoreError("configuration.invalid", message);
}
