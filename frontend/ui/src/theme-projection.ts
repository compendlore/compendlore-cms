export const frontendThemeSurfaces = [
	"site",
	"administration",
	"editor-preview",
	"recovery",
] as const;

export type FrontendThemeSurface = (typeof frontendThemeSurfaces)[number];

interface FrontendThemeMediaCondition {
	readonly minWidth?: { readonly value: number; readonly unit: "px" | "em" | "rem" };
	readonly maxWidth?: { readonly value: number; readonly unit: "px" | "em" | "rem" };
	readonly orientation?: "landscape" | "portrait";
}

interface FrontendThemeMediaProjection {
	readonly condition: FrontendThemeMediaCondition;
	readonly variables: Readonly<Record<string, string>>;
}

export interface FrontendThemeProjection {
	readonly schemaVersion: 1;
	readonly surface: FrontendThemeSurface;
	readonly designSystemVersion: string;
	readonly revision: string;
	readonly variables: Readonly<Record<string, string>>;
	readonly media: readonly FrontendThemeMediaProjection[];
}

const typographyRoles = [
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
const typographyProperties = [
	"color",
	"font-family",
	"font-size",
	"font-weight",
	"line-height",
	"letter-spacing",
	"text-transform",
] as const;
const frontendThemeCssVariables = new Set([
	"--bg",
	"--panel",
	"--text",
	"--gold",
	"--line",
	"--success",
	"--warning",
	"--danger",
	"--page-inline-spacing",
	"--theme-border-width",
	"--theme-border-radius",
	"--theme-border-style",
	"--theme-spacing-unit",
	"--theme-control-minimum-height",
	"--theme-density-scale",
	"--theme-shadow-surface",
	"--theme-motion-duration",
	"--theme-motion-easing",
	"--theme-notification-background",
	"--theme-notification-border-color",
	"--theme-notification-accent-color",
	"--theme-notification-border-width",
	"--theme-notification-border-radius",
	"--theme-notification-padding",
	"--theme-notification-content-gap",
	"--theme-notification-shadow",
	...typographyRoles.flatMap((role) =>
		typographyProperties.map((property) => `--theme-${role}-${property}`),
	),
]);
const fallbackVariables: Readonly<Record<string, string>> = Object.freeze({
	"--bg": "#090c10",
	"--panel": "#12171d",
	"--text": "#e9e3d7",
	"--gold": "#d1a85a",
	"--line": "#473f31",
	"--success": "#8fc29d",
	"--warning": "#d1a85a",
	"--danger": "#d36757",
	"--page-inline-spacing": "5%",
});
const unsafeCssValuePattern = /[;{}<>]|(?:url|expression|var)\s*\(/i;

export interface AppliedThemeProjection {
	readonly status: "applied" | "fallback";
	readonly revision: string;
	readonly dispose: () => void;
}

export function applyThemeProjection(
	root: HTMLElement,
	expectedSurface: FrontendThemeSurface,
	candidate: unknown,
): AppliedThemeProjection {
	const projection = parseProjection(candidate, expectedSurface);
	if (!projection) {
		clearThemeVariables(root);
		applyVariables(root, fallbackVariables);
		root.dataset.themeSurface = expectedSurface;
		root.dataset.themeRevision = "compendlore-fallback";
		return { status: "fallback", revision: "compendlore-fallback", dispose: () => undefined };
	}

	const media = projection.media.map((entry) => ({
		entry,
		query: globalThis.matchMedia?.(serializeMediaCondition(entry.condition)),
	}));
	const refresh = () => {
		clearThemeVariables(root);
		applyVariables(root, fallbackVariables);
		applyVariables(root, projection.variables);
		for (const item of media) {
			if (item.query?.matches) applyVariables(root, item.entry.variables);
		}
	};
	refresh();
	for (const item of media) item.query?.addEventListener("change", refresh);
	root.dataset.themeSurface = projection.surface;
	root.dataset.themeRevision = projection.revision;

	return {
		status: "applied",
		revision: projection.revision,
		dispose: () => {
			for (const item of media) item.query?.removeEventListener("change", refresh);
		},
	};
}

function parseProjection(
	value: unknown,
	expectedSurface: FrontendThemeSurface,
): FrontendThemeProjection | undefined {
	if (!isRecord(value)) return undefined;
	if (
		!hasOnlyKeys(value, [
			"designSystemVersion",
			"media",
			"revision",
			"schemaVersion",
			"surface",
			"variables",
		])
	) {
		return undefined;
	}
	if (
		value.schemaVersion !== 1 ||
		value.surface !== expectedSurface ||
		typeof value.designSystemVersion !== "string" ||
		!/^1\.\d+\.\d+$/.test(value.designSystemVersion) ||
		typeof value.revision !== "string" ||
		!/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(value.revision) ||
		!validVariables(value.variables) ||
		!Array.isArray(value.media) ||
		value.media.length > 16
	) {
		return undefined;
	}
	for (const entry of value.media) {
		if (
			!isRecord(entry) ||
			!hasOnlyKeys(entry, ["condition", "variables"]) ||
			!validMediaCondition(entry.condition) ||
			!validVariables(entry.variables)
		) {
			return undefined;
		}
	}
	return value as unknown as FrontendThemeProjection;
}

function validVariables(value: unknown): value is Readonly<Record<string, string>> {
	return (
		isRecord(value) &&
		Object.keys(value).length > 0 &&
		Object.entries(value).every(
			([name, cssValue]) =>
				frontendThemeCssVariables.has(name) &&
				typeof cssValue === "string" &&
				cssValue.length > 0 &&
				cssValue.length <= 300 &&
				!unsafeCssValuePattern.test(cssValue),
		)
	);
}

function validMediaCondition(value: unknown): value is FrontendThemeMediaCondition {
	if (!isRecord(value) || !hasOnlyKeys(value, ["maxWidth", "minWidth", "orientation"])) {
		return false;
	}
	if (
		value.minWidth === undefined &&
		value.maxWidth === undefined &&
		value.orientation === undefined
	) {
		return false;
	}
	return (
		(value.minWidth === undefined || validMediaWidth(value.minWidth)) &&
		(value.maxWidth === undefined || validMediaWidth(value.maxWidth)) &&
		(value.orientation === undefined ||
			value.orientation === "landscape" ||
			value.orientation === "portrait")
	);
}

function validMediaWidth(
	value: unknown,
): value is { readonly value: number; readonly unit: "px" | "em" | "rem" } {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["unit", "value"]) &&
		typeof value.value === "number" &&
		Number.isFinite(value.value) &&
		value.value >= 0 &&
		value.value <= 10_000 &&
		(value.unit === "px" || value.unit === "em" || value.unit === "rem")
	);
}

function serializeMediaCondition(condition: FrontendThemeMediaCondition): string {
	return [
		condition.minWidth
			? `(min-width: ${condition.minWidth.value}${condition.minWidth.unit})`
			: undefined,
		condition.maxWidth
			? `(max-width: ${condition.maxWidth.value}${condition.maxWidth.unit})`
			: undefined,
		condition.orientation ? `(orientation: ${condition.orientation})` : undefined,
	]
		.filter(Boolean)
		.join(" and ");
}

function applyVariables(root: HTMLElement, variables: Readonly<Record<string, string>>): void {
	for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
}

function clearThemeVariables(root: HTMLElement): void {
	for (const name of frontendThemeCssVariables) root.style.removeProperty(name);
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
