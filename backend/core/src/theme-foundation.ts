export const themeSurfaces = ["site", "administration", "editor-preview", "recovery"] as const;

export type ThemeSurface = (typeof themeSurfaces)[number];

export const themeContributionKinds = ["full-theme", "theme-extension", "component-style"] as const;

export type ThemeContributionKind = (typeof themeContributionKinds)[number];

export const themeLayerOrder = [
	"core-invariant",
	"design-system",
	"theme",
	"theme-extension",
	"component-style",
	"instance-override",
	"user-preference",
	"accessibility-preference",
] as const;

export type ThemeLayerKind = (typeof themeLayerOrder)[number];

export const compendloreThemeIdentifier = "compendlore";
export const compendloreRecoveryThemeIdentifier = "compendlore.recovery";

export interface ThemeContractDefinition {
	readonly kind: ThemeContributionKind;
	readonly surfaces: readonly ThemeSurface[];
	readonly designSystemVersion: string;
	readonly fallback: "compendlore" | "reject";
	readonly baseThemeIdentifier?: string;
	readonly componentNamespace?: string;
	readonly order?: number;
	readonly conflictsWith?: readonly string[];
	readonly tokens?: import("./theme-tokens.js").ThemeTokenSetDefinition;
	readonly brand?: import("./theme-brand.js").ThemeBrandDefinition;
}

export interface ThemeLayerReference {
	readonly kind: Exclude<ThemeLayerKind, "core-invariant" | "design-system" | "theme">;
	readonly sourceIdentifier: string;
	readonly priority: number;
}

export interface ThemeResolutionRequest {
	readonly surface: ThemeSurface;
	readonly baseThemeIdentifier?: string;
	readonly extensions?: readonly ThemeLayerReference[];
	readonly componentStyles?: readonly ThemeLayerReference[];
	readonly instanceOverrides?: readonly ThemeLayerReference[];
	readonly userPreferences?: readonly ThemeLayerReference[];
	readonly accessibilityPreferences?: readonly ThemeLayerReference[];
}

export interface ResolvedThemeLayer {
	readonly kind: ThemeLayerKind;
	readonly sourceIdentifier: string;
	readonly priority: number;
	readonly provenance: "core" | "registry" | "instance" | "user" | "browser";
}

export interface ThemeResolutionPlan {
	readonly surface: ThemeSurface;
	readonly fallbackThemeIdentifier: typeof compendloreThemeIdentifier;
	readonly recoveryThemeIdentifier: typeof compendloreRecoveryThemeIdentifier;
	readonly layers: readonly ResolvedThemeLayer[];
}

export interface ThemeAssignmentCorePort {
	resolveAssignment(request: ThemeResolutionRequest): Promise<ThemeResolutionPlan>;
}

export interface ThemeContractRegistryPort {
	resolvePlan(request: ThemeResolutionRequest): Promise<ThemeResolutionPlan>;
}

export interface ThemeProjectionApiPort {
	readProjection(surface: ThemeSurface): Promise<ThemeResolutionPlan>;
}

export interface ThemeProjectionFrontendPort {
	applyProjection(plan: ThemeResolutionPlan): void;
}

export interface ThemeAssetSecurityDecision {
	readonly status: "allowed" | "denied" | "quarantined";
	readonly evidenceId: string;
}

export interface ThemeAssetSecurityPort {
	inspectThemeAsset(input: {
		readonly assetIdentifier: string;
		readonly mediaType: string;
		readonly digest: string;
	}): Promise<ThemeAssetSecurityDecision>;
}

export const themeBoundaryOwners = Object.freeze({
	core: ["assignments", "revisions", "fallbacks", "publication-state"],
	registry: ["contracts", "compatibility", "conflicts", "resolution-order"],
	api: ["bounded-projections"],
	frontend: ["known-css-properties", "known-assets", "known-variants"],
	securityKernel: ["archives", "fonts", "images", "active-content"],
} as const);

export function resolveThemeFoundationPlan(request: ThemeResolutionRequest): ThemeResolutionPlan {
	if (!themeSurfaces.includes(request.surface)) {
		throw new Error("The theme surface is invalid.");
	}

	const recovery = request.surface === "recovery";
	const baseThemeIdentifier = recovery
		? compendloreRecoveryThemeIdentifier
		: (request.baseThemeIdentifier ?? compendloreThemeIdentifier);
	validateIdentifier(baseThemeIdentifier, "base theme");

	const layers: ResolvedThemeLayer[] = [
		{
			kind: "core-invariant",
			sourceIdentifier: "core.theme-invariants",
			priority: 0,
			provenance: "core",
		},
		{
			kind: "design-system",
			sourceIdentifier: "core.design-system",
			priority: 0,
			provenance: "core",
		},
		{
			kind: "theme",
			sourceIdentifier: baseThemeIdentifier,
			priority: 0,
			provenance: "registry",
		},
	];

	if (recovery) {
		if (hasOptionalLayers(request)) {
			throw new Error("The recovery theme cannot be extended or overridden.");
		}
		return foundationPlan(request.surface, layers);
	}

	appendLayers(layers, request.extensions, "theme-extension", "registry");
	appendLayers(layers, request.componentStyles, "component-style", "registry");
	appendLayers(layers, request.instanceOverrides, "instance-override", "instance");
	appendLayers(layers, request.userPreferences, "user-preference", "user");
	appendLayers(layers, request.accessibilityPreferences, "accessibility-preference", "browser");

	return foundationPlan(request.surface, layers);
}

function appendLayers(
	target: ResolvedThemeLayer[],
	references: readonly ThemeLayerReference[] | undefined,
	expectedKind: ThemeLayerReference["kind"],
	provenance: ResolvedThemeLayer["provenance"],
): void {
	const seenSources = new Set<string>();
	const seenPriorities = new Set<number>();
	const sorted = [...(references ?? [])].sort(
		(first, second) =>
			first.priority - second.priority ||
			first.sourceIdentifier.localeCompare(second.sourceIdentifier),
	);
	for (const reference of sorted) {
		if (reference.kind !== expectedKind) {
			throw new Error("The theme layer kind does not match its resolution stage.");
		}
		validateIdentifier(reference.sourceIdentifier, "theme layer");
		if (!Number.isSafeInteger(reference.priority) || reference.priority < 0) {
			throw new Error("The theme layer priority is invalid.");
		}
		if (seenSources.has(reference.sourceIdentifier) || seenPriorities.has(reference.priority)) {
			throw new Error("The theme layer order contains a conflict.");
		}
		seenSources.add(reference.sourceIdentifier);
		seenPriorities.add(reference.priority);
		target.push({ ...reference, provenance });
	}
}

function foundationPlan(
	surface: ThemeSurface,
	layers: readonly ResolvedThemeLayer[],
): ThemeResolutionPlan {
	return {
		surface,
		fallbackThemeIdentifier: compendloreThemeIdentifier,
		recoveryThemeIdentifier: compendloreRecoveryThemeIdentifier,
		layers,
	};
}

function hasOptionalLayers(request: ThemeResolutionRequest): boolean {
	return [
		request.extensions,
		request.componentStyles,
		request.instanceOverrides,
		request.userPreferences,
		request.accessibilityPreferences,
	].some((layers) => (layers?.length ?? 0) > 0);
}

function validateIdentifier(value: string, label: string): void {
	if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value) || value.length > 160) {
		throw new Error(`The ${label} identifier is invalid.`);
	}
}
