import { CoreError } from "./errors.js";

export type LocalizedTextFormat = "multiline" | "plain";
export type LocalizedTextLayer = "instance" | "owner" | "translation";

export interface LocalizedTextResourceDefinition {
	readonly identifier: string;
	readonly contributionKey: string;
	readonly namespace: string;
	readonly format: LocalizedTextFormat;
	readonly required: boolean;
	readonly allowInstanceOverride: boolean;
}

export interface LocalizedTextValueDefinition {
	readonly resourceIdentifier: string;
	readonly locale: string;
	readonly sourceLayer: LocalizedTextLayer;
	readonly sourceContributionKey: string;
	readonly value: string;
	readonly revision: number;
}

export interface InstanceLocaleDefinition {
	readonly locale: string;
	readonly enabled: boolean;
	readonly displayOrder: number;
	readonly fallbackLocale?: string;
}

export interface TranslationSourceSelection {
	readonly targetContributionKey: string;
	readonly locale: string;
	readonly sourceContributionKey: string;
	readonly priority: number;
	readonly enabled: boolean;
}

export interface LocalizationContext {
	readonly requestedLocales: readonly string[];
	readonly defaultLocale: string;
}

export interface ResolvedLocalizedText {
	readonly identifier: string;
	readonly value: string;
	readonly locale: string;
	readonly revision: number;
	readonly sourceLayer: LocalizedTextLayer;
	readonly sourceContributionKey: string;
}

export class LocalizationEngine {
	private readonly resources = new Map<string, LocalizedTextResourceDefinition>();
	private readonly values = new Map<string, LocalizedTextValueDefinition[]>();
	private readonly locales = new Map<string, InstanceLocaleDefinition>();
	private readonly selections = new Map<string, TranslationSourceSelection[]>();

	registerResource(definition: LocalizedTextResourceDefinition): void {
		validateIdentifier(definition.identifier);
		validateIdentifier(definition.contributionKey);
		if (!definition.namespace.trim()) invalid("L’espace de noms de traduction est obligatoire.");
		const current = this.resources.get(definition.identifier);
		if (current && current.contributionKey !== definition.contributionKey) {
			invalid(`La ressource ${definition.identifier} appartient déjà à une autre contribution.`);
		}
		this.resources.set(definition.identifier, Object.freeze({ ...definition }));
	}

	registerValue(definition: LocalizedTextValueDefinition): void {
		const resource = this.resources.get(definition.resourceIdentifier);
		if (!resource) invalid(`La ressource ${definition.resourceIdentifier} est inconnue.`);
		const locale = canonicalizeLocale(definition.locale);
		if (!definition.value.trim()) invalid("Une traduction vide est interdite.");
		if (definition.revision < 1 || !Number.isSafeInteger(definition.revision)) {
			invalid("La révision de traduction est invalide.");
		}
		if (definition.sourceLayer === "instance" && !resource.allowInstanceOverride) {
			invalid(`La ressource ${definition.resourceIdentifier} interdit les surcharges d’instance.`);
		}
		const values = this.values.get(definition.resourceIdentifier) ?? [];
		const latest = values
			.filter(
				(candidate) =>
					candidate.locale === locale &&
					candidate.sourceLayer === definition.sourceLayer &&
					candidate.sourceContributionKey === definition.sourceContributionKey,
			)
			.sort((left, right) => right.revision - left.revision)[0];
		if (latest && definition.revision === latest.revision && definition.value === latest.value) {
			return;
		}
		if (latest && definition.revision <= latest.revision) {
			invalid("La révision de traduction doit être strictement croissante.");
		}
		values.push(Object.freeze({ ...definition, locale }));
		this.values.set(definition.resourceIdentifier, values);
	}

	configureLocales(definitions: readonly InstanceLocaleDefinition[]): void {
		const normalized = definitions.map((definition) => ({
			...definition,
			locale: canonicalizeLocale(definition.locale),
			...(definition.fallbackLocale
				? { fallbackLocale: canonicalizeLocale(definition.fallbackLocale) }
				: {}),
		}));
		const locales = new Map(normalized.map((definition) => [definition.locale, definition]));
		for (const definition of normalized) {
			if (definition.fallbackLocale && !locales.has(definition.fallbackLocale)) {
				invalid(`La locale de repli ${definition.fallbackLocale} n’est pas configurée.`);
			}
			assertFallbackWithoutCycle(definition.locale, locales);
		}
		this.locales.clear();
		for (const definition of normalized) this.locales.set(definition.locale, definition);
	}

	selectTranslationSources(selections: readonly TranslationSourceSelection[]): void {
		this.selections.clear();
		for (const selection of selections) {
			const locale = canonicalizeLocale(selection.locale);
			const key = `${selection.targetContributionKey}:${locale}`;
			const values = this.selections.get(key) ?? [];
			values.push(Object.freeze({ ...selection, locale }));
			this.selections.set(key, values);
		}
	}

	resolve(identifier: string, context: LocalizationContext): ResolvedLocalizedText {
		const resource = this.resources.get(identifier);
		if (!resource) invalid(`La ressource localisée ${identifier} est inconnue.`);
		const values = this.values.get(identifier) ?? [];
		for (const locale of this.localeCandidates(context)) {
			const candidate = this.resolveForLocale(resource, values, locale);
			if (candidate) return { identifier, ...candidate };
		}
		throw new CoreError(
			"configuration.invalid",
			`Aucune valeur localisée n’est disponible pour ${identifier}.`,
		);
	}

	resolveMany(
		identifiers: readonly string[],
		context: LocalizationContext,
	): Readonly<Record<string, ResolvedLocalizedText>> {
		return Object.fromEntries(
			identifiers.map((identifier) => [identifier, this.resolve(identifier, context)]),
		);
	}

	private localeCandidates(context: LocalizationContext): readonly string[] {
		const candidates: string[] = [];
		const visit = (localeValue: string) => {
			let locale = canonicalizeLocale(localeValue);
			const seen = new Set<string>();
			while (!seen.has(locale)) {
				seen.add(locale);
				if (this.locales.get(locale)?.enabled !== false && !candidates.includes(locale)) {
					candidates.push(locale);
				}
				const fallback = this.locales.get(locale)?.fallbackLocale;
				if (fallback) {
					locale = fallback;
					continue;
				}
				const language = new Intl.Locale(locale).language;
				if (language !== locale) {
					locale = language;
					continue;
				}
				break;
			}
		};
		for (const requested of context.requestedLocales) visit(requested);
		visit(context.defaultLocale);
		return candidates;
	}

	private resolveForLocale(
		resource: LocalizedTextResourceDefinition,
		values: readonly LocalizedTextValueDefinition[],
		locale: string,
	): Omit<ResolvedLocalizedText, "identifier"> | undefined {
		const latest = (layer: LocalizedTextLayer, source?: string) =>
			values
				.filter(
					(candidate) =>
						candidate.locale === locale &&
						candidate.sourceLayer === layer &&
						(source === undefined || candidate.sourceContributionKey === source),
				)
				.sort((left, right) => right.revision - left.revision)[0];
		const instance = latest("instance");
		if (instance) return instance;
		const selections = (this.selections.get(`${resource.contributionKey}:${locale}`) ?? [])
			.filter((selection) => selection.enabled)
			.sort((left, right) => left.priority - right.priority);
		for (const selection of selections) {
			const translated = latest("translation", selection.sourceContributionKey);
			if (translated) return translated;
		}
		return latest("owner");
	}
}

export function canonicalizeLocale(locale: string): string {
	try {
		const [canonical] = Intl.getCanonicalLocales(locale.trim());
		if (!canonical) throw new RangeError("Missing locale");
		return canonical;
	} catch (error) {
		throw new CoreError("configuration.invalid", `La locale ${locale} est invalide.`, {
			cause: error,
		});
	}
}

function assertFallbackWithoutCycle(
	start: string,
	locales: ReadonlyMap<string, InstanceLocaleDefinition>,
): void {
	const visited = new Set<string>();
	let current: string | undefined = start;
	while (current) {
		if (visited.has(current)) invalid(`La chaîne de repli de ${start} contient un cycle.`);
		visited.add(current);
		current = locales.get(current)?.fallbackLocale;
	}
}

function validateIdentifier(identifier: string): void {
	if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(identifier)) {
		invalid(`L’identifiant ${identifier} est invalide.`);
	}
}

function invalid(message: string): never {
	throw new CoreError("configuration.invalid", message);
}
