import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { LocalizationEngine, PageCatalog } from "../backend/build/core/src/index.js";

function localization() {
	const engine = new LocalizationEngine();
	for (const [identifier, value] of [
		["page.world.title", "World"],
		["page.new.title", "New world"],
	]) {
		engine.registerResource({
			identifier,
			contributionKey: "native.test",
			namespace: "page",
			format: "plain",
			required: true,
			allowInstanceOverride: true,
		});
		engine.registerValue({
			resourceIdentifier: identifier,
			locale: "en",
			sourceLayer: "owner",
			sourceContributionKey: "native.test",
			value,
			revision: 1,
		});
	}
	return engine;
}

function document(componentIdentifier) {
	return {
		breakpoints: [
			{ identifier: "mobile", minimumWidth: 0, columns: 4, rowHeight: 80, gap: 16 },
			{
				identifier: "desktop",
				minimumWidth: 1024,
				columns: 12,
				rowHeight: 80,
				gap: 24,
				inherits: "mobile",
			},
		],
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
					{
						breakpoint: "desktop",
						column: 1,
						row: 1,
						columnSpan: 12,
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

function page(identifier, title, pattern) {
	return {
		identifier,
		contributionKey: "native.test",
		ownerKind: "native-module",
		surface: "site",
		titleTextIdentifier: title,
		requiredCapabilities: [],
		editable: true,
		removable: false,
		context: { kind: "entity-type", entityTypeIdentifier: "world" },
		routes: [
			{
				identifier,
				pattern,
				aliases: identifier === "page.world" ? ["/univers/{slug:slug}"] : [],
				canonical: true,
			},
		],
		initialDocument: document("component.world"),
		published: true,
	};
}

test("résout les routes typées, aliases et préférences statiques", () => {
	const pages = new PageCatalog(localization());
	pages.registerComponentContract({
		identifier: "component.world",
		contributionKey: "native.test",
		contractVersion: "1.0.0",
		frontendModuleIdentifier: "component.world",
	});
	pages.register(page("page.world", "page.world.title", "/worlds/{slug:slug}"));
	pages.register(page("page.new", "page.new.title", "/worlds/new"));
	const context = { requestedLocales: ["en"], defaultLocale: "en" };
	assert.equal(pages.resolve("/worlds/new", new Set(), context, "site").identifier, "page.new");
	const alias = pages.resolve("/univers/caerthia", new Set(), context, "site");
	assert.equal(alias.identifier, "page.world");
	assert.equal(alias.routeParameters.slug, "caerthia");
	assert.equal(alias.canonicalRoute, "/worlds/caerthia");
	assert.equal(alias.redirectedFrom, "/univers/caerthia");
});

test("valide, publie, planifie et restaure les révisions atomiquement", () => {
	let now = new Date("2026-10-13T10:00:00.000Z");
	const pages = new PageCatalog(localization(), () => now);
	pages.registerComponentContract({
		identifier: "component.world",
		contributionKey: "native.test",
		contractVersion: "1.0.0",
		frontendModuleIdentifier: "component.world",
	});
	pages.register(page("page.world", "page.world.title", "/worlds/{slug:slug}"));
	const draft = pages.createDraft("page.world", "user-1");
	pages.validateDraft("page.world", draft.revision);
	const scheduledAt = new Date("2026-10-13T11:00:00.000Z");
	pages.schedule("page.world", draft.revision, scheduledAt);
	assert.equal(pages.publishScheduled().length, 0);
	now = scheduledAt;
	assert.equal(pages.publishScheduled()[0].revision, 2);
	assert.equal(pages.rollback("page.world", 1, "user-1").revision, 3);
	assert.equal(pages.history("page.world").length, 3);
});

test("refuse les collisions ambiguës et les dispositions qui se chevauchent", () => {
	const pages = new PageCatalog(localization());
	pages.registerComponentContract({
		identifier: "component.world",
		contributionKey: "native.test",
		contractVersion: "1.0.0",
		frontendModuleIdentifier: "component.world",
	});
	pages.register(page("page.world", "page.world.title", "/worlds/{slug:slug}"));
	assert.throws(
		() => pages.register(page("page.other", "page.new.title", "/worlds/{name:string}")),
		/ambiguë/i,
	);
	const invalid = JSON.parse(JSON.stringify(page("page.overlap", "page.new.title", "/overlap")));
	invalid.initialDocument.containers.push({
		identifier: "other",
		regionIdentifier: "main",
		placements: [
			{
				breakpoint: "mobile",
				column: 1,
				row: 1,
				columnSpan: 2,
				rowSpan: 1,
			},
		],
	});
	assert.throws(() => pages.register(invalid), /chevauchent/i);
});

test("la migration de phase 10 reste structurelle et sans données métier", async () => {
	const migration = await readFile(
		new URL("../backend/core/migrations/009_core_page_engine.up.sql", import.meta.url),
		"utf8",
	);
	for (const table of [
		"page_routes",
		"page_route_aliases",
		"page_revisions",
		"page_publications",
		"page_grid_breakpoints",
		"page_regions",
		"page_containers",
		"page_container_placements",
		"page_component_instances",
	]) {
		assert.match(migration, new RegExp(`CREATE TABLE core\\.${table}\\b`));
	}
	assert.doesNotMatch(migration, /INSERT INTO core\./i);
	assert.doesNotMatch(migration, /\b(?:TRUNCATE|DROP TABLE)\b/i);
});
