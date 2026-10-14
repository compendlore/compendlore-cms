import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	compendloreRecoveryThemeIdentifier,
	compendloreThemeIdentifier,
	CoreRegistryPort,
	compileThemeCssProjection,
	InMemoryCoreStore,
	resolveThemeFoundationPlan,
	resolveThemeBrand,
	themeBoundaryOwners,
	themeLayerOrder,
	themeSurfaces,
	themeTokenCatalog,
	themeTokenFallbacks,
	themeTypographyRoles,
} from "../backend/build/core/src/index.js";
import {
	createInMemoryCmsRegistry,
	RegistryError,
	validateThemeBrand,
	validateThemeTokenSet,
} from "../backend/build/cms-registry/src/index.js";
import {
	ApplicationShell,
	applyThemeProjection,
	RichBrandContent,
} from "../frontend/ui/build/types/index.js";

const nativeOwner = { kind: "native-module", identifier: "native.site" };

function themeContribution(identifier, theme, overrides = {}) {
	return {
		type: "theme",
		identifier,
		owner: nativeOwner,
		version: "1.0.0",
		withdrawalPolicy: "preserve-data",
		replacementPolicy: "same-owner",
		theme,
		...overrides,
	};
}

async function createRegistry() {
	const store = new InMemoryCoreStore();
	return createInMemoryCmsRegistry(new CoreRegistryPort(store));
}

test("définit les frontières et surfaces du moteur de thèmes", () => {
	assert.deepEqual(themeSurfaces, ["site", "administration", "editor-preview", "recovery"]);
	assert.deepEqual(themeLayerOrder, [
		"core-invariant",
		"design-system",
		"theme",
		"theme-extension",
		"component-style",
		"instance-override",
		"user-preference",
		"accessibility-preference",
	]);
	assert.deepEqual(Object.keys(themeBoundaryOwners), [
		"core",
		"registry",
		"api",
		"frontend",
		"securityKernel",
	]);
	assert.ok(themeBoundaryOwners.frontend.includes("known-css-properties"));
	assert.ok(themeBoundaryOwners.securityKernel.includes("active-content"));
});

test("résout les couches de thème dans un ordre déterministe", () => {
	const plan = resolveThemeFoundationPlan({
		surface: "site",
		baseThemeIdentifier: "official.arcane",
		extensions: [
			{ kind: "theme-extension", sourceIdentifier: "official.high-contrast", priority: 20 },
			{ kind: "theme-extension", sourceIdentifier: "official.spacing", priority: 10 },
		],
		componentStyles: [
			{ kind: "component-style", sourceIdentifier: "addon.bestiary.cards", priority: 0 },
		],
		instanceOverrides: [
			{ kind: "instance-override", sourceIdentifier: "instance.visual", priority: 0 },
		],
		userPreferences: [
			{ kind: "user-preference", sourceIdentifier: "user.readability", priority: 0 },
		],
		accessibilityPreferences: [
			{
				kind: "accessibility-preference",
				sourceIdentifier: "browser.reduced-motion",
				priority: 0,
			},
		],
	});

	assert.equal(plan.fallbackThemeIdentifier, compendloreThemeIdentifier);
	assert.equal(plan.recoveryThemeIdentifier, compendloreRecoveryThemeIdentifier);
	assert.deepEqual(
		plan.layers.map(({ kind, sourceIdentifier }) => [kind, sourceIdentifier]),
		[
			["core-invariant", "core.theme-invariants"],
			["design-system", "core.design-system"],
			["theme", "official.arcane"],
			["theme-extension", "official.spacing"],
			["theme-extension", "official.high-contrast"],
			["component-style", "addon.bestiary.cards"],
			["instance-override", "instance.visual"],
			["user-preference", "user.readability"],
			["accessibility-preference", "browser.reduced-motion"],
		],
	);

	assert.throws(
		() =>
			resolveThemeFoundationPlan({
				surface: "site",
				extensions: [
					{ kind: "theme-extension", sourceIdentifier: "official.first", priority: 1 },
					{ kind: "theme-extension", sourceIdentifier: "official.second", priority: 1 },
				],
			}),
		/The theme layer order contains a conflict/,
	);
});

test("isole la récupération sur le thème Compendlore sûr", () => {
	const recovery = resolveThemeFoundationPlan({ surface: "recovery" });
	assert.equal(recovery.layers.at(-1)?.sourceIdentifier, compendloreRecoveryThemeIdentifier);
	assert.equal(recovery.layers.length, 3);
	assert.throws(
		() =>
			resolveThemeFoundationPlan({
				surface: "recovery",
				userPreferences: [
					{ kind: "user-preference", sourceIdentifier: "user.custom", priority: 0 },
				],
			}),
		/The recovery theme cannot be extended or overridden/,
	);
});

test("valide les contrats de thème et protège les replis", async () => {
	const registry = await createRegistry();
	await registry.register(
		themeContribution(compendloreThemeIdentifier, {
			kind: "full-theme",
			surfaces: ["site", "administration"],
			designSystemVersion: "^1.0.0",
			fallback: "compendlore",
		}),
		{ requester: nativeOwner },
	);
	await registry.register(
		themeContribution(
			compendloreRecoveryThemeIdentifier,
			{
				kind: "full-theme",
				surfaces: ["recovery"],
				designSystemVersion: "^1.0.0",
				fallback: "compendlore",
			},
			{ withdrawalPolicy: "block-uninstall" },
		),
		{ requester: nativeOwner },
	);
	await registry.register(
		themeContribution("official.readability", {
			kind: "theme-extension",
			surfaces: ["site", "editor-preview"],
			designSystemVersion: "^1.0.0",
			fallback: "reject",
			baseThemeIdentifier: compendloreThemeIdentifier,
			order: 10,
		}),
		{ requester: nativeOwner },
	);

	const invalidContracts = [
		{
			kind: "full-theme",
			surfaces: ["administration"],
			designSystemVersion: "^1.0.0",
			fallback: "reject",
		},
		{
			kind: "theme-extension",
			surfaces: ["site"],
			designSystemVersion: "^1.0.0",
			fallback: "compendlore",
			order: 1,
		},
		{
			kind: "component-style",
			surfaces: ["site"],
			designSystemVersion: "^1.0.0",
			fallback: "compendlore",
			componentNamespace: "addon.cards",
			order: -1,
		},
		{
			kind: "full-theme",
			surfaces: ["site"],
			designSystemVersion: "^1.0.0",
			fallback: "compendlore",
			css: "body { display: none; }",
		},
	];
	for (const [index, theme] of invalidContracts.entries()) {
		await assert.rejects(
			registry.register(themeContribution(`invalid.theme-${index}`, theme), {
				requester: nativeOwner,
			}),
			(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
		);
	}
});

test("expose les couleurs, bordures et rôles typographiques thématisables", () => {
	for (const identifier of [
		"color.background",
		"color.surface",
		"color.text",
		"color.accent",
		"color.border",
		"color.success",
		"color.warning",
		"color.danger",
		"border.width",
		"border.style",
		"border.radius",
		"page.inline-spacing",
		"spacing.unit",
		"control.minimum-height",
		"density.scale",
		"shadow.surface",
		"motion.duration",
		"motion.easing",
		"notification.background",
		"notification.border-color",
		"notification.accent-color",
		"notification.border-width",
		"notification.border-radius",
		"notification.padding",
		"notification.content-gap",
		"notification.shadow",
	]) {
		assert.ok(themeTokenCatalog[identifier], identifier);
	}
	assert.deepEqual(themeTypographyRoles, [
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
	]);
	for (const role of themeTypographyRoles) {
		for (const property of [
			"color",
			"font-family",
			"font-size",
			"font-weight",
			"line-height",
			"letter-spacing",
			"text-transform",
		]) {
			assert.ok(themeTokenCatalog[`${role}.${property}`], `${role}.${property}`);
		}
	}
	for (const [identifier, token] of Object.entries(themeTokenCatalog)) {
		if (token.required) assert.ok(themeTokenFallbacks[identifier], identifier);
	}
	assert.doesNotThrow(() => validateThemeTokenSet({ global: themeTokenFallbacks }));
});

test("valide les valeurs globales et surcharges par media query", () => {
	assert.doesNotThrow(() =>
		validateThemeTokenSet({
			global: {
				"color.background": { kind: "color", value: "#090c10" },
				"page.inline-spacing": { kind: "length", value: 32, unit: "px" },
				"body.font-family": {
					kind: "font-family",
					source: "system",
					families: ["Inter", "system-ui"],
				},
				"body.font-size": { kind: "length", value: 1, unit: "rem" },
			},
			media: [
				{
					media: { maxWidth: { value: 64, unit: "em" } },
					values: {
						"page.inline-spacing": { kind: "length", value: 5, unit: "%" },
						"body.font-size": { kind: "length", value: 0.95, unit: "rem" },
					},
				},
				{
					media: { maxWidth: { value: 40, unit: "em" }, orientation: "portrait" },
					values: {
						"page.inline-spacing": { kind: "length", value: 1, unit: "em" },
					},
				},
			],
		}),
	);
});

test("accepte les polices personnalisées analysées et refuse les valeurs actives", () => {
	assert.doesNotThrow(() =>
		validateThemeTokenSet({
			global: {
				"brand.font-family": {
					kind: "font-family",
					source: "asset",
					assetIdentifier: "theme.font.cinzel",
					fallbackFamilies: ["Georgia", "Times New Roman"],
				},
			},
		}),
	);

	const invalidSets = [
		{ global: { "page.inline-spacing": { kind: "length", value: 2, unit: "rem" } } },
		{ global: { "color.background": { kind: "color", value: "url(example.test/a)" } } },
		{
			global: {
				"brand.font-family": {
					kind: "font-family",
					source: "asset",
					assetIdentifier: "https://example.test/font.woff2",
					fallbackFamilies: ["Georgia"],
				},
			},
		},
		{ global: { "unknown.css": { kind: "color", value: "#fff" } } },
		{
			media: [
				{
					media: { raw: "(max-width: 40em)" },
					values: { "page.inline-spacing": { kind: "length", value: 1, unit: "em" } },
				},
			],
		},
	];
	for (const tokenSet of invalidSets) {
		assert.throws(
			() => validateThemeTokenSet(tokenSet),
			(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
		);
	}
});

const richBrand = {
	fallbackLocale: "fr",
	accessibleLabel: {
		fr: "Donjon & Dragon",
		en: "Dungeon & Dragon",
	},
	segments: [
		{
			identifier: "name-start",
			text: { fr: "Donjon ", en: "Dungeon " },
			styleSlot: "brand.primary",
		},
		{
			identifier: "ampersand",
			text: { fr: "&", en: "&" },
			styleSlot: "brand.accent",
		},
		{
			identifier: "name-end",
			text: { fr: " Dragon", en: " Dragon" },
			styleSlot: "brand.primary",
		},
	],
};

test("valide un Brand riche localisable et segmenté", () => {
	assert.doesNotThrow(() => validateThemeBrand(richBrand));
	assert.deepEqual(resolveThemeBrand(richBrand, "fr-FR"), {
		accessibleLabel: "Donjon & Dragon",
		segments: [
			{ identifier: "name-start", text: "Donjon ", styleSlot: "brand.primary" },
			{ identifier: "ampersand", text: "&", styleSlot: "brand.accent" },
			{ identifier: "name-end", text: " Dragon", styleSlot: "brand.primary" },
		],
	});
	assert.equal(resolveThemeBrand(richBrand, "de-DE").accessibleLabel, "Donjon & Dragon");
});

test("refuse le HTML, le CSS et les Brands illisibles", () => {
	const invalidBrands = [
		{ ...richBrand, accessibleLabel: { fr: "" } },
		{ ...richBrand, segments: [] },
		{
			...richBrand,
			segments: [{ identifier: "active", text: { fr: "<strong>Brand</strong>" } }],
		},
		{
			...richBrand,
			segments: [{ identifier: "active", text: { fr: "url(theme.css)" } }],
		},
		{
			...richBrand,
			segments: [{ identifier: "active", text: { fr: "Brand" }, styleSlot: "color: red" }],
		},
		{
			...richBrand,
			segments: [{ identifier: "unknown", text: { fr: "Brand" }, styleSlot: "brand.unknown" }],
		},
		{
			...richBrand,
			logo: { assetIdentifier: "https://example.test/logo.svg", alternativeText: { fr: "Logo" } },
		},
	];
	for (const brand of invalidBrands) {
		assert.throws(
			() => validateThemeBrand(brand),
			(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
		);
	}
});

test("rend le Brand de façon déterministe avec un repli texte", () => {
	const resolved = resolveThemeBrand(richBrand, "fr-FR");
	const brandView = {
		accessibleLabel: resolved.accessibleLabel,
		segments: resolved.segments,
		logoSource: "javascript:alert(1)",
	};
	const content = renderToStaticMarkup(
		createElement(RichBrandContent, { brand: brandView, fallbackLabel: "Compendlore CMS" }),
	);
	assert.match(content, /Donjon/);
	assert.match(content, /data-style-slot="brand\.accent"/);
	assert.doesNotMatch(content, /<img/);
	assert.doesNotMatch(content, /javascript:/);

	const shell = renderToStaticMarkup(
		createElement(ApplicationShell, {
			brand: brandView,
			children: createElement("p", null, "Content"),
		}),
	);
	assert.equal((shell.match(/class="brand"/g) ?? []).length, 1);
	assert.equal((shell.match(/href="\/"/g) ?? []).length, 1);
	assert.match(shell, /aria-label="Donjon &amp; Dragon"/);
	const accessibleFallbackShell = renderToStaticMarkup(
		createElement(ApplicationShell, {
			brand: { accessibleLabel: " ", segments: [] },
			children: createElement("p", null, "Content"),
		}),
	);
	assert.match(accessibleFallbackShell, /aria-label="Compendlore CMS"/);

	const fallback = renderToStaticMarkup(
		createElement(RichBrandContent, { fallbackLabel: "Compendlore CMS" }),
	);
	assert.match(fallback, /Compendlore CMS/);
});

test("compile une projection frontend avec des variables CSS connues", () => {
	const tokens = {
		global: {
			"color.background": { kind: "color", value: "#10151d" },
			"page.inline-spacing": { kind: "length", value: 48, unit: "px" },
		},
		media: [
			{
				media: { maxWidth: { value: 40, unit: "em" } },
				values: { "page.inline-spacing": { kind: "length", value: 1, unit: "em" } },
			},
		],
	};
	validateThemeTokenSet(tokens);
	const projection = compileThemeCssProjection({
		surface: "site",
		designSystemVersion: "1.0.0",
		revision: "theme.revision-8-10",
		tokens,
	});
	assert.equal(projection.variables["--bg"], "#10151d");
	assert.equal(projection.variables["--page-inline-spacing"], "48px");
	assert.equal(projection.media[0]?.variables["--page-inline-spacing"], "1em");
	assert.ok(Object.keys(projection.variables).every((name) => name.startsWith("--")));
});

test("applique séparément les projections de chaque surface", () => {
	const projection = compileThemeCssProjection({
		surface: "site",
		designSystemVersion: "1.0.0",
		revision: "site.current",
		tokens: { global: { "color.accent": { kind: "color", value: "#76c7b7" } } },
	});
	const applied = new Map();
	const root = {
		style: {
			setProperty: (name, value) => applied.set(name, value),
			removeProperty: (name) => applied.delete(name),
		},
		dataset: {},
	};
	const result = applyThemeProjection(root, "site", projection);
	assert.equal(result.status, "applied");
	assert.equal(root.dataset.themeSurface, "site");
	assert.equal(applied.get("--gold"), "#76c7b7");

	const isolated = applyThemeProjection(root, "administration", projection);
	assert.equal(isolated.status, "fallback");
	assert.equal(root.dataset.themeSurface, "administration");
	assert.equal(applied.get("--gold"), "#d1a85a");
});

test("revient au thème Compendlore pour une projection active ou incompatible", () => {
	const applied = new Map();
	const root = {
		style: {
			setProperty: (name, value) => applied.set(name, value),
			removeProperty: (name) => applied.delete(name),
		},
		dataset: {},
	};
	for (const invalid of [
		undefined,
		{
			schemaVersion: 1,
			surface: "site",
			designSystemVersion: "2.0.0",
			revision: "future",
			variables: { "--bg": "#000" },
			media: [],
		},
		{
			schemaVersion: 1,
			surface: "site",
			designSystemVersion: "1.0.0",
			revision: "unsafe",
			variables: { "--unknown-selector": "url(https://example.test/theme.css)" },
			media: [],
		},
	]) {
		assert.equal(applyThemeProjection(root, "site", invalid).status, "fallback");
		assert.equal(applied.get("--bg"), "#090c10");
	}
});
