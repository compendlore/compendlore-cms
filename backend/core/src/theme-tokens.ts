export const themeTypographyRoles = [
	"body",
	"button",
	"link",
	"title",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"brand",
	"notification-title",
	"notification-body",
	"notification-time",
] as const;

export type ThemeTypographyRole = (typeof themeTypographyRoles)[number];

export const themeLengthUnits = ["px", "em", "rem", "%"] as const;
export type ThemeLengthUnit = (typeof themeLengthUnits)[number];

export const themeSystemFontFamilies = [
	"Arial",
	"Georgia",
	"Inter",
	"system-ui",
	"Times New Roman",
	"Verdana",
] as const;

export interface ThemeLengthValue {
	readonly kind: "length";
	readonly value: number;
	readonly unit: ThemeLengthUnit;
}

export type ThemeTokenValue =
	| { readonly kind: "border-style"; readonly value: "dashed" | "dotted" | "none" | "solid" }
	| { readonly kind: "color"; readonly value: string }
	| { readonly kind: "duration"; readonly value: number; readonly unit: "ms" }
	| {
			readonly kind: "easing";
			readonly value: "ease" | "ease-in" | "ease-in-out" | "ease-out" | "linear";
	  }
	| {
			readonly kind: "font-family";
			readonly source: "asset";
			readonly assetIdentifier: string;
			readonly fallbackFamilies: readonly string[];
	  }
	| {
			readonly kind: "font-family";
			readonly source: "system";
			readonly families: readonly string[];
	  }
	| { readonly kind: "font-weight"; readonly value: number }
	| ThemeLengthValue
	| { readonly kind: "line-height"; readonly value: number }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "shadow"; readonly value: "medium" | "none" | "soft" | "strong" }
	| {
			readonly kind: "text-transform";
			readonly value: "capitalize" | "lowercase" | "none" | "uppercase";
	  };

export interface ThemeMediaQuery {
	readonly minWidth?: Omit<ThemeLengthValue, "kind">;
	readonly maxWidth?: Omit<ThemeLengthValue, "kind">;
	readonly orientation?: "landscape" | "portrait";
}

export interface ThemeTokenMediaOverride {
	readonly media: ThemeMediaQuery;
	readonly values: Readonly<Record<string, ThemeTokenValue>>;
}

export interface ThemeTokenSetDefinition {
	readonly global?: Readonly<Record<string, ThemeTokenValue>>;
	readonly media?: readonly ThemeTokenMediaOverride[];
}

export type ThemeTokenValueKind = ThemeTokenValue["kind"];

export interface ThemeTokenCatalogEntry {
	readonly kind: ThemeTokenValueKind;
	readonly required: boolean;
	readonly responsive: boolean;
	readonly units?: readonly ThemeLengthUnit[];
	readonly minimum?: number;
	readonly maximum?: number;
	readonly maximumByUnit?: Partial<Readonly<Record<ThemeLengthUnit, number>>>;
}

const semanticColorTokens = [
	"color.background",
	"color.surface",
	"color.text",
	"color.accent",
	"color.border",
	"color.success",
	"color.warning",
	"color.danger",
] as const;

const baseTokenCatalog: Record<string, ThemeTokenCatalogEntry> = {
	...Object.fromEntries(
		semanticColorTokens.map((identifier) => [
			identifier,
			{ kind: "color", required: true, responsive: true },
		]),
	),
	"border.width": {
		kind: "length",
		required: true,
		responsive: true,
		units: ["px", "em"],
		minimum: 0,
		maximum: 2,
	},
	"border.radius": {
		kind: "length",
		required: true,
		responsive: true,
		units: ["px", "em", "%"],
		minimum: 0,
		maximum: 50,
	},
	"border.style": { kind: "border-style", required: true, responsive: true },
	"page.inline-spacing": {
		kind: "length",
		required: true,
		responsive: true,
		units: ["px", "em", "%"],
		minimum: 0,
		maximumByUnit: { px: 320, em: 20, "%": 20 },
	},
	"spacing.unit": {
		kind: "length",
		required: true,
		responsive: true,
		units: ["px", "em", "rem"],
		minimum: 0.125,
		maximum: 4,
	},
	"control.minimum-height": {
		kind: "length",
		required: true,
		responsive: true,
		units: ["px", "em", "rem"],
		minimum: 1,
		maximum: 8,
	},
	"density.scale": {
		kind: "number",
		required: true,
		responsive: true,
		minimum: 0.75,
		maximum: 1.5,
	},
	"shadow.surface": { kind: "shadow", required: true, responsive: true },
	"motion.duration": {
		kind: "duration",
		required: true,
		responsive: true,
		minimum: 0,
		maximum: 2_000,
	},
	"motion.easing": { kind: "easing", required: true, responsive: true },
	"notification.background": { kind: "color", required: true, responsive: true },
	"notification.border-color": { kind: "color", required: true, responsive: true },
	"notification.accent-color": { kind: "color", required: true, responsive: true },
	"notification.border-width": {
		kind: "length",
		required: true,
		responsive: true,
		units: ["px", "em"],
		minimum: 0,
		maximumByUnit: { px: 6, em: 0.4 },
	},
	"notification.border-radius": {
		kind: "length",
		required: true,
		responsive: true,
		units: ["px", "em", "rem"],
		minimum: 0,
		maximum: 4,
	},
	"notification.padding": {
		kind: "length",
		required: true,
		responsive: true,
		units: ["px", "em", "rem"],
		minimum: 0.25,
		maximum: 4,
	},
	"notification.content-gap": {
		kind: "length",
		required: true,
		responsive: true,
		units: ["px", "em", "rem"],
		minimum: 0.125,
		maximum: 3,
	},
	"notification.shadow": { kind: "shadow", required: true, responsive: true },
};

const typographyTokenCatalog = Object.fromEntries(
	themeTypographyRoles.flatMap((role) => [
		[`${role}.color`, { kind: "color", required: true, responsive: true }],
		[`${role}.font-family`, { kind: "font-family", required: true, responsive: true }],
		[
			`${role}.font-size`,
			{
				kind: "length",
				required: true,
				responsive: true,
				units: ["px", "em", "rem"],
				minimum: 0.5,
				maximum: 12,
			},
		],
		[`${role}.font-weight`, { kind: "font-weight", required: true, responsive: true }],
		[`${role}.line-height`, { kind: "line-height", required: true, responsive: true }],
		[
			`${role}.letter-spacing`,
			{
				kind: "length",
				required: true,
				responsive: true,
				units: ["px", "em", "rem"],
				minimum: -1,
				maximum: 2,
			},
		],
		[`${role}.text-transform`, { kind: "text-transform", required: true, responsive: true }],
	]),
) as Record<string, ThemeTokenCatalogEntry>;

export const themeTokenCatalog: Readonly<Record<string, ThemeTokenCatalogEntry>> = Object.freeze({
	...baseTokenCatalog,
	...typographyTokenCatalog,
});

const roleSizes: Readonly<Record<ThemeTypographyRole, number>> = {
	body: 1,
	button: 1,
	link: 1,
	title: 1.1,
	h1: 2.5,
	h2: 2.1,
	h3: 1.8,
	h4: 1.5,
	h5: 1.25,
	brand: 1.4,
	"notification-title": 1,
	"notification-body": 0.95,
	"notification-time": 0.78,
};

const typographyFallbacks = Object.fromEntries(
	themeTypographyRoles.flatMap((role) => {
		const display = ["title", "h1", "h2", "h3", "h4", "h5", "brand"].includes(role);
		const notificationTitle = role === "notification-title";
		return [
			[`${role}.color`, { kind: "color", value: display ? "#f2eadc" : "#e9e3d7" }],
			[
				`${role}.font-family`,
				{
					kind: "font-family",
					source: "system",
					families: display ? ["Georgia", "Times New Roman"] : ["Inter", "system-ui"],
				},
			],
			[`${role}.font-size`, { kind: "length", value: roleSizes[role], unit: "rem" }],
			[
				`${role}.font-weight`,
				{ kind: "font-weight", value: display || notificationTitle ? 600 : 400 },
			],
			[
				`${role}.line-height`,
				{ kind: "line-height", value: display ? 1.2 : notificationTitle ? 1.3 : 1.5 },
			],
			[`${role}.letter-spacing`, { kind: "length", value: 0, unit: "em" }],
			[`${role}.text-transform`, { kind: "text-transform", value: "none" }],
		];
	}),
) as Record<string, ThemeTokenValue>;

export const themeTokenFallbacks: Readonly<Record<string, ThemeTokenValue>> = Object.freeze({
	"color.background": { kind: "color", value: "#090c10" },
	"color.surface": { kind: "color", value: "#12171d" },
	"color.text": { kind: "color", value: "#e9e3d7" },
	"color.accent": { kind: "color", value: "#d1a85a" },
	"color.border": { kind: "color", value: "#473f31" },
	"color.success": { kind: "color", value: "#8fc29d" },
	"color.warning": { kind: "color", value: "#d1a85a" },
	"color.danger": { kind: "color", value: "#d36757" },
	"border.width": { kind: "length", value: 1, unit: "px" },
	"border.radius": { kind: "length", value: 0.25, unit: "em" },
	"border.style": { kind: "border-style", value: "solid" },
	"page.inline-spacing": { kind: "length", value: 5, unit: "%" },
	"spacing.unit": { kind: "length", value: 0.5, unit: "rem" },
	"control.minimum-height": { kind: "length", value: 2.75, unit: "rem" },
	"density.scale": { kind: "number", value: 1 },
	"shadow.surface": { kind: "shadow", value: "soft" },
	"motion.duration": { kind: "duration", value: 180, unit: "ms" },
	"motion.easing": { kind: "easing", value: "ease" },
	"notification.background": { kind: "color", value: "#12171d" },
	"notification.border-color": { kind: "color", value: "#473f31" },
	"notification.accent-color": { kind: "color", value: "#d1a85a" },
	"notification.border-width": { kind: "length", value: 1, unit: "px" },
	"notification.border-radius": { kind: "length", value: 0.5, unit: "rem" },
	"notification.padding": { kind: "length", value: 1, unit: "rem" },
	"notification.content-gap": { kind: "length", value: 0.55, unit: "rem" },
	"notification.shadow": { kind: "shadow", value: "strong" },
	...typographyFallbacks,
});
