import {
	compendloreRecoveryThemeIdentifier,
	compendloreThemeIdentifier,
	themeContributionKinds,
	themeSurfaces,
	type ThemeContractDefinition,
} from "../../core/src/index.js";
import type { ContributionDefinition } from "./contracts.js";
import { RegistryError } from "./errors.js";
import { validateThemeBrand } from "./theme-brand.js";
import { validateThemeTokenSet } from "./theme-tokens.js";

const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const versionPattern = /^(?:\^|~|>=|>)?\s*(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const themeContractKeys = new Set([
	"baseThemeIdentifier",
	"brand",
	"componentNamespace",
	"conflictsWith",
	"designSystemVersion",
	"fallback",
	"kind",
	"order",
	"surfaces",
	"tokens",
]);

export function validateThemeContract(definition: ContributionDefinition): void {
	if (definition.type !== "theme") {
		if (definition.theme !== undefined) throw invalid();
		return;
	}
	if (!isRecord(definition.theme)) throw invalid();

	const theme = definition.theme as ThemeContractDefinition;
	if (Object.keys(theme).some((key) => !themeContractKeys.has(key))) throw invalid();
	if (!themeContributionKinds.includes(theme.kind)) throw invalid();
	if (!Array.isArray(theme.surfaces) || theme.surfaces.length === 0) throw invalid();
	if (new Set(theme.surfaces).size !== theme.surfaces.length) throw invalid();
	if (!theme.surfaces.every((surface) => themeSurfaces.includes(surface))) throw invalid();
	if (!versionPattern.test(theme.designSystemVersion)) throw invalid();
	if (theme.fallback !== "compendlore" && theme.fallback !== "reject") throw invalid();
	if (
		theme.surfaces.some((surface) => surface === "administration" || surface === "recovery") &&
		theme.fallback !== "compendlore"
	) {
		throw invalid();
	}

	validateKindSpecificContract(theme);
	validateConflicts(definition.identifier, theme.conflictsWith);
	if (theme.tokens !== undefined) validateThemeTokenSet(theme.tokens);
	if (theme.brand !== undefined) validateThemeBrand(theme.brand);

	if (
		(definition.identifier === compendloreThemeIdentifier ||
			definition.identifier === compendloreRecoveryThemeIdentifier) &&
		definition.owner.kind !== "native-module"
	) {
		throw invalid();
	}
	if (
		theme.surfaces.includes("recovery") &&
		(definition.identifier !== compendloreRecoveryThemeIdentifier ||
			theme.kind !== "full-theme" ||
			definition.withdrawalPolicy !== "block-uninstall")
	) {
		throw invalid();
	}
}

function validateKindSpecificContract(theme: ThemeContractDefinition): void {
	if (theme.kind === "full-theme") {
		if (
			theme.baseThemeIdentifier !== undefined ||
			theme.componentNamespace !== undefined ||
			theme.order !== undefined
		) {
			throw invalid();
		}
		return;
	}

	if (
		!Number.isSafeInteger(theme.order) ||
		(theme.order ?? -1) < 0 ||
		(theme.order ?? 0) > 10_000
	) {
		throw invalid();
	}
	if (theme.kind === "theme-extension") {
		validateIdentifier(theme.baseThemeIdentifier);
		if (theme.componentNamespace !== undefined) throw invalid();
		return;
	}
	validateIdentifier(theme.componentNamespace);
	if (theme.baseThemeIdentifier !== undefined) throw invalid();
}

function validateConflicts(identifier: string, conflicts: readonly string[] | undefined): void {
	if (conflicts === undefined) return;
	if (!Array.isArray(conflicts) || new Set(conflicts).size !== conflicts.length) throw invalid();
	for (const conflict of conflicts) {
		validateIdentifier(conflict);
		if (conflict === identifier) throw invalid();
	}
}

function validateIdentifier(value: unknown): asserts value is string {
	if (typeof value !== "string" || !identifierPattern.test(value) || value.length > 160) {
		throw invalid();
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(): RegistryError {
	return new RegistryError("registry.contract_invalid", "The theme declaration is invalid.");
}
