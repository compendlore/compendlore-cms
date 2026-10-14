export const themeBrandStyleSlots = ["brand.primary", "brand.accent", "brand.muted"] as const;

export type ThemeBrandStyleSlot = (typeof themeBrandStyleSlots)[number];

export interface ThemeBrandSegmentDefinition {
	readonly identifier: string;
	readonly text: Readonly<Record<string, string>>;
	readonly styleSlot?: ThemeBrandStyleSlot;
}

export interface ThemeBrandLogoDefinition {
	readonly assetIdentifier: string;
	readonly alternativeText: Readonly<Record<string, string>>;
}

export interface ThemeBrandDefinition {
	readonly fallbackLocale: string;
	readonly accessibleLabel: Readonly<Record<string, string>>;
	readonly segments: readonly ThemeBrandSegmentDefinition[];
	readonly logo?: ThemeBrandLogoDefinition;
}

export interface ResolvedThemeBrand {
	readonly accessibleLabel: string;
	readonly segments: readonly {
		readonly identifier: string;
		readonly text: string;
		readonly styleSlot?: string;
	}[];
	readonly logoAssetIdentifier?: string;
	readonly logoAlternativeText?: string;
}

export function resolveThemeBrand(brand: ThemeBrandDefinition, locale: string): ResolvedThemeBrand {
	const normalizedLocale = locale.trim().toLowerCase();
	const language = normalizedLocale.split("-", 1)[0] ?? normalizedLocale;
	const fallbackLocale = brand.fallbackLocale.toLowerCase();
	const localized = (values: Readonly<Record<string, string>>): string => {
		const normalizedValues = new Map(
			Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
		);
		return (
			normalizedValues.get(normalizedLocale) ??
			normalizedValues.get(language) ??
			normalizedValues.get(fallbackLocale) ??
			Object.values(values)[0] ??
			""
		);
	};

	return {
		accessibleLabel: localized(brand.accessibleLabel),
		segments: brand.segments.map((segment) => ({
			identifier: segment.identifier,
			text: localized(segment.text),
			...(segment.styleSlot ? { styleSlot: segment.styleSlot } : {}),
		})),
		...(brand.logo
			? {
					logoAssetIdentifier: brand.logo.assetIdentifier,
					logoAlternativeText: localized(brand.logo.alternativeText),
				}
			: {}),
	};
}
