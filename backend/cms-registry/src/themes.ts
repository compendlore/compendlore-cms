export const themeTokenTypes = [
	"color",
	"font-family",
	"font-weight",
	"length",
	"number",
	"shadow",
	"time",
] as const;

export type ThemeTokenType = (typeof themeTokenTypes)[number];
export type ThemeSurface = "administration" | "public" | "recovery";

export interface ThemeTokenDefinition {
	readonly type: ThemeTokenType;
	readonly value: string | number;
	readonly description: Readonly<Record<string, string>>;
}

export interface ThemeVariantDefinition {
	readonly identifier: string;
	readonly label: Readonly<Record<string, string>>;
	readonly tokens: Readonly<Record<string, string | number>>;
}

export interface ThemeDefinition {
	readonly schemaVersion: string;
	readonly surfaces: readonly ThemeSurface[];
	readonly tokens: Readonly<Record<string, ThemeTokenDefinition>>;
	readonly variants: readonly ThemeVariantDefinition[];
	readonly fallbackThemeIdentifier?: string;
}

export interface ThemeExtensionDefinition {
	readonly schemaVersion: string;
	readonly targetThemeIdentifier: string;
	readonly tokens: Readonly<Record<string, string | number>>;
	readonly conflictsWith?: readonly string[];
	readonly order: number;
}
