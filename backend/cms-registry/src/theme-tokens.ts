import {
	themeSystemFontFamilies,
	themeTokenCatalog,
	type ThemeLengthUnit,
	type ThemeMediaQuery,
	type ThemeTokenCatalogEntry,
	type ThemeTokenSetDefinition,
} from "../../core/src/index.js";
import { RegistryError } from "./errors.js";

const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const mediaWidthUnits = new Set<ThemeLengthUnit>(["px", "em", "rem"]);
const systemFontFamilies = new Set<string>(themeSystemFontFamilies);

export function validateThemeTokenSet(definition: ThemeTokenSetDefinition): void {
	if (!isRecord(definition)) throw invalid();
	if (Object.keys(definition).some((key) => key !== "global" && key !== "media")) throw invalid();
	if (definition.global === undefined && definition.media === undefined) throw invalid();
	if (definition.global !== undefined) validateValues(definition.global, false);
	if (definition.media !== undefined) validateMediaOverrides(definition.media);
}

function validateMediaOverrides(overrides: unknown): void {
	if (!Array.isArray(overrides) || overrides.length === 0 || overrides.length > 16) throw invalid();
	const conditions = new Set<string>();
	for (const override of overrides) {
		if (!isRecord(override) || !isRecord(override.media) || !isRecord(override.values)) {
			throw invalid();
		}
		if (Object.keys(override).some((key) => key !== "media" && key !== "values")) {
			throw invalid();
		}
		validateMediaQuery(override.media);
		validateValues(override.values, true);
		const condition = canonicalMediaQuery(override.media);
		if (conditions.has(condition)) throw invalid();
		conditions.add(condition);
	}
}

function validateMediaQuery(media: unknown): asserts media is ThemeMediaQuery {
	if (!isRecord(media)) throw invalid();
	if (
		Object.keys(media).some(
			(key) => key !== "minWidth" && key !== "maxWidth" && key !== "orientation",
		)
	) {
		throw invalid();
	}
	if (
		media.minWidth === undefined &&
		media.maxWidth === undefined &&
		media.orientation === undefined
	) {
		throw invalid();
	}
	const minWidth = media.minWidth;
	const maxWidth = media.maxWidth;
	if (minWidth !== undefined) validateMediaWidth(minWidth);
	if (maxWidth !== undefined) validateMediaWidth(maxWidth);
	if (
		media.orientation !== undefined &&
		(typeof media.orientation !== "string" ||
			!["landscape", "portrait"].includes(media.orientation))
	) {
		throw invalid();
	}
	if (minWidth && maxWidth && minWidth.unit === maxWidth.unit && minWidth.value >= maxWidth.value) {
		throw invalid();
	}
}

function validateMediaWidth(
	width: unknown,
): asserts width is { readonly value: number; readonly unit: "px" | "em" | "rem" } {
	if (
		!isRecord(width) ||
		Object.keys(width).some((key) => key !== "unit" && key !== "value") ||
		typeof width.value !== "number" ||
		!Number.isFinite(width.value) ||
		width.value < 0 ||
		width.value > 10_000 ||
		typeof width.unit !== "string" ||
		!mediaWidthUnits.has(width.unit as ThemeLengthUnit)
	) {
		throw invalid();
	}
}

function validateValues(values: unknown, responsive: boolean): void {
	if (!isRecord(values) || Object.keys(values).length === 0) throw invalid();
	for (const [identifier, value] of Object.entries(values)) {
		const token = themeTokenCatalog[identifier];
		if (!token || (responsive && !token.responsive) || !isRecord(value)) throw invalid();
		validateValue(value, token);
	}
}

function validateValue(
	value: Readonly<Record<string, unknown>>,
	token: ThemeTokenCatalogEntry,
): void {
	if (value.kind !== token.kind) throw invalid();
	switch (token.kind) {
		case "color":
			if (
				Object.keys(value).some((key) => key !== "kind" && key !== "value") ||
				typeof value.value !== "string" ||
				!/^#[\da-f]{3,4}(?:[\da-f]{3,4})?$/i.test(value.value)
			) {
				throw invalid();
			}
			return;
		case "length":
			validateLength(value, token);
			return;
		case "font-family":
			validateFontFamily(value);
			return;
		case "font-weight":
			if (
				Object.keys(value).some((key) => key !== "kind" && key !== "value") ||
				!Number.isSafeInteger(value.value) ||
				(value.value as number) < 100 ||
				(value.value as number) > 900 ||
				(value.value as number) % 100 !== 0
			) {
				throw invalid();
			}
			return;
		case "number":
			if (
				Object.keys(value).some((key) => key !== "kind" && key !== "value") ||
				typeof value.value !== "number" ||
				!Number.isFinite(value.value) ||
				(token.minimum !== undefined && value.value < token.minimum) ||
				(token.maximum !== undefined && value.value > token.maximum)
			) {
				throw invalid();
			}
			return;
		case "duration":
			if (
				Object.keys(value).some((key) => key !== "kind" && key !== "unit" && key !== "value") ||
				value.unit !== "ms" ||
				typeof value.value !== "number" ||
				!Number.isFinite(value.value) ||
				(token.minimum !== undefined && value.value < token.minimum) ||
				(token.maximum !== undefined && value.value > token.maximum)
			) {
				throw invalid();
			}
			return;
		case "line-height":
			if (
				Object.keys(value).some((key) => key !== "kind" && key !== "value") ||
				typeof value.value !== "number" ||
				!Number.isFinite(value.value) ||
				value.value < 0.8 ||
				value.value > 3
			) {
				throw invalid();
			}
			return;
		case "border-style":
			if (
				Object.keys(value).some((key) => key !== "kind" && key !== "value") ||
				typeof value.value !== "string" ||
				!["dashed", "dotted", "none", "solid"].includes(value.value)
			) {
				throw invalid();
			}
			return;
		case "shadow":
			if (
				Object.keys(value).some((key) => key !== "kind" && key !== "value") ||
				typeof value.value !== "string" ||
				!["medium", "none", "soft", "strong"].includes(value.value)
			) {
				throw invalid();
			}
			return;
		case "easing":
			if (
				Object.keys(value).some((key) => key !== "kind" && key !== "value") ||
				typeof value.value !== "string" ||
				!["ease", "ease-in", "ease-in-out", "ease-out", "linear"].includes(value.value)
			) {
				throw invalid();
			}
			return;
		case "text-transform":
			if (
				Object.keys(value).some((key) => key !== "kind" && key !== "value") ||
				typeof value.value !== "string" ||
				!["capitalize", "lowercase", "none", "uppercase"].includes(value.value)
			) {
				throw invalid();
			}
	}
}

function validateLength(
	value: Readonly<Record<string, unknown>>,
	token: ThemeTokenCatalogEntry,
): void {
	const unit = typeof value.unit === "string" ? (value.unit as ThemeLengthUnit) : undefined;
	const maximum = unit ? (token.maximumByUnit?.[unit] ?? token.maximum) : token.maximum;
	if (
		Object.keys(value).some((key) => key !== "kind" && key !== "unit" && key !== "value") ||
		typeof value.value !== "number" ||
		!Number.isFinite(value.value) ||
		typeof value.unit !== "string" ||
		!token.units?.includes(value.unit as ThemeLengthUnit) ||
		(token.minimum !== undefined && value.value < token.minimum) ||
		(maximum !== undefined && value.value > maximum)
	) {
		throw invalid();
	}
}

function validateFontFamily(value: Readonly<Record<string, unknown>>): void {
	if (value.source === "system") {
		if (
			Object.keys(value).some((key) => key !== "kind" && key !== "source" && key !== "families") ||
			!validSystemFamilies(value.families)
		) {
			throw invalid();
		}
		return;
	}
	if (
		value.source !== "asset" ||
		Object.keys(value).some(
			(key) =>
				key !== "kind" &&
				key !== "source" &&
				key !== "assetIdentifier" &&
				key !== "fallbackFamilies",
		) ||
		typeof value.assetIdentifier !== "string" ||
		!identifierPattern.test(value.assetIdentifier) ||
		!validSystemFamilies(value.fallbackFamilies)
	) {
		throw invalid();
	}
}

function validSystemFamilies(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= 8 &&
		new Set(value).size === value.length &&
		value.every((family) => typeof family === "string" && systemFontFamilies.has(family))
	);
}

function canonicalMediaQuery(media: ThemeMediaQuery): string {
	return JSON.stringify({
		maxWidth: media.maxWidth,
		minWidth: media.minWidth,
		orientation: media.orientation,
	});
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(): RegistryError {
	return new RegistryError("registry.contract_invalid", "The theme token declaration is invalid.");
}
