import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { NativeCatalogAccessError, NativeCatalogApi } from "../backend/build/api/src/index.js";
import { NativeContentRegistry } from "../backend/build/cms-registry/src/index.js";
import { nativeSiteContribution } from "../backend/build/site/src/native-contributions.js";

function audience(overrides = {}) {
	return {
		authenticated: false,
		capabilities: new Set(),
		permissions: new Set(),
		roles: new Set(),
		features: new Set(),
		events: new Set(),
		now: new Date("2026-10-13T00:00:00.000Z"),
		...overrides,
	};
}

function locale(requestedLocales = ["fr-FR"]) {
	return { requestedLocales, defaultLocale: "en" };
}

function pageDocument(componentIdentifier) {
	return {
		breakpoints: [{ identifier: "mobile", minimumWidth: 0, columns: 4, rowHeight: 80, gap: 16 }],
		regions: [{ identifier: "main", order: 10 }],
		containers: [
			{
				identifier: "main",
				regionIdentifier: "main",
				placements: [
					{
						breakpoint: "mobile",
						column: 1,
						row: 1,
						columnSpan: 4,
						rowSpan: 2,
					},
				],
			},
		],
		components: [
			{
				identifier: "main",
				componentIdentifier,
				containerIdentifier: "main",
				order: 10,
			},
		],
	};
}

test("matérialise la contribution native et résout les textes sans langue imposée", () => {
	const registry = new NativeContentRegistry();
	const inspection = registry.register(nativeSiteContribution);
	assert.equal(inspection.owner.kind, "native-module");
	assert.equal(inspection.counts.entityTypes, 1);
	assert.equal(
		registry.localization.resolve("core.page.home.description", locale()).locale,
		"fr-FR",
	);
	assert.equal(
		registry.localization.resolve("core.page.home.description", locale(["de-DE"])).locale,
		"en",
	);
	assert.deepEqual(
		registry.entities.effectiveFields("entity").map((field) => field.identifier),
		["id", "name", "abbreviation", "summary", "description", "icon", "tags", "aliases"],
	);
});

test("résout la navigation publique et protège le catalogue administratif", () => {
	const registry = new NativeContentRegistry();
	registry.register(nativeSiteContribution);
	const publicNavigation = registry.navigation.resolve(audience(), locale());
	assert.equal(publicNavigation.brand.identifier, "core.home");
	assert.equal(publicNavigation.brand.target, "core.home");
	assert.equal(publicNavigation.sidebars.length, 0);
	assert.deepEqual(
		publicNavigation.actions.map((item) => item.identifier),
		["core.login"],
	);

	const capabilities = new Set(["core.administration.access"]);
	const administration = registry.navigation.resolve(
		audience({ authenticated: true, capabilities }),
		locale(),
	);
	assert.deepEqual(
		administration.actions.map((item) => item.identifier),
		["core.administration", "core.profile", "core.logout"],
	);
	assert.deepEqual(
		administration.sidebars[0].items.map((item) => item.identifier),
		["core.admin.dashboard", "core.admin.modules", "core.admin.interface", "core.admin.pages"],
	);

	const api = new NativeCatalogApi(registry);
	assert.throws(
		() =>
			api.read({
				surface: "administration",
				requestedLocales: ["fr-FR"],
				defaultLocale: "en",
				identity: audience(),
			}),
		NativeCatalogAccessError,
	);
	const document = api.read({
		surface: "administration",
		requestedLocales: ["fr-FR"],
		defaultLocale: "en",
		identity: audience({ authenticated: true, capabilities }),
	});
	assert.equal(document.pages[0].route, "/admin");
	assert.equal(document.navigation.brand.target, "/");
	assert.equal(document.contributions[0].contributionKey, "native.site");
});

test("applique héritage, révisions, workflow et requêtes bornées aux entités", () => {
	const registry = new NativeContentRegistry();
	registry.register(nativeSiteContribution);
	registry.register({
		contributionKey: "addon.proof",
		owner: { kind: "addon", identifier: "proof" },
		version: "1.0.0",
		localizedResources: [
			{
				identifier: "proof.note.name",
				namespace: "proof.note",
				format: "plain",
				values: [{ locale: "fr-FR", value: "Note" }],
			},
		],
		entityTypes: [
			{
				identifier: "proof.note",
				parentIdentifier: "entity",
				nameTextIdentifier: "proof.note.name",
				fields: [],
			},
		],
	});
	const record = registry.entities.create({
		typeIdentifier: "proof.note",
		values: { id: "first-note", name: "Première note" },
		authorId: "user-1",
	});
	assert.equal(record.recordId === record.publicId, false);
	const reviewed = registry.entities.transition(record.recordId, 1, "review", "user-1");
	const published = registry.entities.transition(record.recordId, 2, "published", "user-1");
	assert.equal(reviewed.revision, 2);
	assert.equal(published.workflowState, "published");
	assert.equal(
		registry.entities.query({ typeIdentifier: "proof.note", limit: 25 }).records[0].publicId,
		"first-note",
	);
	assert.throws(
		() => registry.entities.query({ typeIdentifier: "proof.note", limit: 101 }),
		/pagination/i,
	);
});

test("gère installation, désactivation, mise à jour et retrait d’une contribution addon", () => {
	const registry = new NativeContentRegistry();
	registry.register(nativeSiteContribution);
	const contribution = {
		contributionKey: "addon.proof-lifecycle",
		owner: { kind: "addon", identifier: "proof-lifecycle" },
		version: "1.0.0",
		dependencies: ["native.site"],
		localizedResources: [
			{
				identifier: "proof.lifecycle.title",
				namespace: "proof.lifecycle",
				format: "plain",
				values: [{ locale: "en", value: "Lifecycle proof" }],
			},
		],
		pageComponentContracts: [
			{
				identifier: "proof.lifecycle.page",
				contractVersion: "1.0.0",
				frontendModuleIdentifier: "proof.lifecycle.page",
			},
		],
		navigationLinks: [
			{
				identifier: "proof.lifecycle",
				mode: "route",
				target: "proof.lifecycle",
				titleTextIdentifier: "proof.lifecycle.title",
			},
		],
		navigationItems: [
			{
				identifier: "proof.lifecycle",
				position: "primary",
				linkIdentifier: "proof.lifecycle",
			},
		],
		pages: [
			{
				identifier: "proof.lifecycle",
				surface: "site",
				titleTextIdentifier: "proof.lifecycle.title",
				context: { kind: "none" },
				routes: [
					{
						identifier: "proof.lifecycle",
						pattern: "/proof-lifecycle",
						canonical: true,
					},
				],
				initialDocument: pageDocument("proof.lifecycle.page"),
			},
		],
	};
	assert.equal(registry.register(contribution).state, "active");
	assert.equal(registry.navigation.resolve(audience(), locale()).primary.length, 1);
	assert.equal(registry.setState(contribution.contributionKey, "disabled").state, "disabled");
	assert.equal(registry.navigation.resolve(audience(), locale()).primary.length, 0);
	registry.setState(contribution.contributionKey, "active");
	assert.equal(registry.register({ ...contribution, version: "1.1.0" }).version, "1.1.0");
	assert.equal(registry.withdraw(contribution.contributionKey).state, "withdrawn");
	assert.equal(registry.pages.resolve("/proof-lifecycle", new Set(), locale()), undefined);
	assert.throws(() => registry.setState("native.site", "disabled"), /native|Core/i);
});

test("la migration de phase 9 ne contient que des catalogues structurels Core", async () => {
	const migration = await readFile(
		new URL("../backend/core/migrations/008_core_native_content_catalogs.up.sql", import.meta.url),
		"utf8",
	);
	for (const table of [
		"localized_text_resources",
		"localized_text_values",
		"entity_types",
		"entity_fields",
		"entity_records",
		"navigation_links",
		"navigation_items",
		"sidebars",
		"sidebar_items",
		"pages",
	]) {
		assert.match(migration, new RegExp(`CREATE TABLE core\\.${table}\\b`));
	}
	assert.match(migration, /\boffset_value NUMERIC NOT NULL DEFAULT 0\b/i);
	assert.doesNotMatch(migration, /\boffset NUMERIC\b/i);
	assert.doesNotMatch(migration, /INSERT INTO core\.(?:entity_types|navigation_items|pages)/i);
	assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\b/i);
});

test("les applications React consomment le catalogue sans enregistrer leurs routes", async () => {
	const [site, administration] = await Promise.all([
		readFile(new URL("../frontend/site/src/App.tsx", import.meta.url), "utf8"),
		readFile(new URL("../frontend/administration/src/App.tsx", import.meta.url), "utf8"),
	]);
	assert.match(site, /useNativeCatalog\("site"\)/);
	assert.match(administration, /useNativeCatalog\("administration"\)/);
	assert.doesNotMatch(site, /kind:\s*"route"/);
	assert.doesNotMatch(administration, /kind:\s*"route"/);
	assert.doesNotMatch(administration, /SidebarRegistry/);
});
