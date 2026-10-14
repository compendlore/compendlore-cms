import { themeBrandStyleSlots, type ThemeBrandDefinition } from "../../core/src/index.js";
import { RegistryError } from "./errors.js";

const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const localePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const activeTextPattern = /[<>{}]|(?:javascript|data):|url\s*\(|\*\*|__|\[[^\]]*\]\s*\(/i;

export function validateThemeBrand(brand: ThemeBrandDefinition): void {
	if (!isRecord(brand)) throw invalid();
	assertKeys(brand, ["accessibleLabel", "fallbackLocale", "logo", "segments"]);
	if (typeof brand.fallbackLocale !== "string" || !localePattern.test(brand.fallbackLocale)) {
		throw invalid();
	}
	validateLocalizedText(brand.accessibleLabel, brand.fallbackLocale, 160);
	if (!Array.isArray(brand.segments) || brand.segments.length === 0 || brand.segments.length > 16) {
		throw invalid();
	}
	const identifiers = new Set<string>();
	for (const segment of brand.segments) {
		if (!isRecord(segment)) throw invalid();
		assertKeys(segment, ["identifier", "styleSlot", "text"]);
		validateIdentifier(segment.identifier);
		if (identifiers.has(segment.identifier)) throw invalid();
		identifiers.add(segment.identifier);
		validateLocalizedText(segment.text, brand.fallbackLocale, 120);
		if (
			segment.styleSlot !== undefined &&
			(typeof segment.styleSlot !== "string" ||
				!themeBrandStyleSlots.some((slot) => slot === segment.styleSlot))
		) {
			throw invalid();
		}
	}
	for (const locale of Object.keys(brand.accessibleLabel)) {
		const rendered = brand.segments
			.map((segment) => localized(segment.text, locale, brand.fallbackLocale))
			.join("");
		if (!rendered.trim()) throw invalid();
	}
	if (brand.logo !== undefined) {
		if (!isRecord(brand.logo)) throw invalid();
		assertKeys(brand.logo, ["alternativeText", "assetIdentifier"]);
		validateIdentifier(brand.logo.assetIdentifier);
		validateLocalizedText(brand.logo.alternativeText, brand.fallbackLocale, 160);
	}
}

function validateLocalizedText(
	values: unknown,
	fallbackLocale: string,
	maximumLength: number,
): asserts values is Readonly<Record<string, string>> {
	if (
		!isRecord(values) ||
		!Object.keys(values).some((locale) => locale.toLowerCase() === fallbackLocale.toLowerCase())
	) {
		throw invalid();
	}
	for (const [locale, value] of Object.entries(values)) {
		if (
			!localePattern.test(locale) ||
			typeof value !== "string" ||
			!value.trim() ||
			value.length > maximumLength ||
			activeTextPattern.test(value)
		) {
			throw invalid();
		}
	}
}

function localized(
	values: Readonly<Record<string, string>>,
	locale: string,
	fallbackLocale: string,
): string {
	const normalizedValues = new Map(
		Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
	);
	const normalizedLocale = locale.toLowerCase();
	return (
		normalizedValues.get(normalizedLocale) ??
		normalizedValues.get(normalizedLocale.split("-", 1)[0] ?? normalizedLocale) ??
		normalizedValues.get(fallbackLocale.toLowerCase()) ??
		""
	);
}

function assertKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
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
	return new RegistryError("registry.contract_invalid", "The theme brand declaration is invalid.");
}
