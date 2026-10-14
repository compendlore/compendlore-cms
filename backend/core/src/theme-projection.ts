import {
	themeTokenCatalog,
	themeTokenFallbacks,
	type ThemeMediaQuery,
	type ThemeTokenSetDefinition,
	type ThemeTokenValue,
} from "./theme-tokens.js";
import type { ThemeSurface } from "./theme-foundation.js";

export interface ThemeCssMediaProjection {
	readonly condition: ThemeMediaQuery;
	readonly variables: Readonly<Record<string, string>>;
}

export interface ThemeCssProjection {
	readonly schemaVersion: 1;
	readonly surface: ThemeSurface;
	readonly designSystemVersion: string;
	readonly revision: string;
	readonly variables: Readonly<Record<string, string>>;
	readonly media: readonly ThemeCssMediaProjection[];
}

const semanticVariables: Readonly<Record<string, string>> = Object.freeze({
	"color.background": "--bg",
	"color.surface": "--panel",
	"color.text": "--text",
	"color.accent": "--gold",
	"color.border": "--line",
	"color.success": "--success",
	"color.warning": "--warning",
	"color.danger": "--danger",
	"page.inline-spacing": "--page-inline-spacing",
});

export const themeCssVariableCatalog: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries(
		Object.keys(themeTokenCatalog).map((identifier) => [
			identifier,
			semanticVariables[identifier] ?? `--theme-${identifier.replaceAll(".", "-")}`,
		]),
	),
);

export function compileThemeCssProjection(input: {
	readonly surface: ThemeSurface;
	readonly designSystemVersion: string;
	readonly revision: string;
	readonly tokens?: ThemeTokenSetDefinition;
}): ThemeCssProjection {
	if (!/^\d+\.\d+\.\d+$/.test(input.designSystemVersion)) {
		throw new Error("The theme projection design-system version is invalid.");
	}
	if (!/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(input.revision)) {
		throw new Error("The theme projection revision is invalid.");
	}
	const globalValues = { ...themeTokenFallbacks, ...(input.tokens?.global ?? {}) };
	return {
		schemaVersion: 1,
		surface: input.surface,
		designSystemVersion: input.designSystemVersion,
		revision: input.revision,
		variables: compileValues(globalValues),
		media: (input.tokens?.media ?? []).map((override) => ({
			condition: override.media,
			variables: compileValues(override.values),
		})),
	};
}

function compileValues(
	values: Readonly<Record<string, ThemeTokenValue>>,
): Readonly<Record<string, string>> {
	return Object.freeze(
		Object.fromEntries(
			Object.entries(values).map(([identifier, value]) => {
				const variable = themeCssVariableCatalog[identifier];
				const contract = themeTokenCatalog[identifier];
				if (!variable || !contract || value.kind !== contract.kind) {
					throw new Error("The theme projection contains an unknown or incompatible token.");
				}
				return [variable, serializeValue(value)];
			}),
		),
	);
}

function serializeValue(value: ThemeTokenValue): string {
	switch (value.kind) {
		case "color":
		case "border-style":
		case "easing":
		case "text-transform":
			return value.value;
		case "duration":
		case "length":
			return `${value.value}${value.unit}`;
		case "font-weight":
		case "line-height":
		case "number":
			return String(value.value);
		case "font-family": {
			const families = value.source === "system" ? value.families : value.fallbackFamilies;
			return families.map(quoteFontFamily).join(", ");
		}
		case "shadow":
			return {
				medium: "0 0.75rem 2rem rgb(0 0 0 / 28%)",
				none: "none",
				soft: "0 0.35rem 1rem rgb(0 0 0 / 18%)",
				strong: "0 1rem 3rem rgb(0 0 0 / 42%)",
			}[value.value];
	}
}

function quoteFontFamily(family: string): string {
	return family.includes(" ") ? `"${family}"` : family;
}
