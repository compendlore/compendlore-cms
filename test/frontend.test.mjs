import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	AdministrationAssetAccessError,
	AdministrationBundleDelivery,
} from "../backend/build/api/src/index.js";
import {
	ApplicationShell,
	Button,
	Card,
	DateTimePicker,
	FrontendModuleRegistry,
	MainNavigationRegistry,
	ModuleOutlet,
	NavigationResolver,
	Notice,
	PageHeader,
	SidebarElementRegistry,
	SidebarRegistry,
	Switch,
	Tabs,
} from "../frontend/ui/build/types/index.js";

test("refuse tout asset administratif avant rôle et second facteur", async () => {
	let reads = 0;
	const delivery = new AdministrationBundleDelivery({
		async read(path) {
			reads += 1;
			return { contentType: "text/html", bytes: Buffer.from(path) };
		},
	});
	await assert.rejects(
		() => delivery.deliver(undefined, "index.html"),
		(error) =>
			error instanceof AdministrationAssetAccessError && error.code === "authorization.denied",
	);
	await assert.rejects(
		() =>
			delivery.deliver(
				{ userId: "user-1", isAdministrator: true, secondFactorVerified: false },
				"index.html",
			),
		(error) =>
			error instanceof AdministrationAssetAccessError &&
			error.code === "administration.second_factor_required",
	);
	assert.equal(reads, 0);
	const asset = await delivery.deliver(
		{ userId: "user-1", isAdministrator: true, secondFactorVerified: true },
		"/assets/admin.js",
	);
	assert.equal(Buffer.from(asset.bytes).toString(), "assets/admin.js");
	assert.equal(reads, 1);
	await assert.rejects(
		() =>
			delivery.deliver(
				{ userId: "user-1", isAdministrator: true, secondFactorVerified: true },
				"/assets/admin.js.map",
			),
		/introuvable/i,
	);
	await assert.rejects(
		() =>
			delivery.deliver(
				{ userId: "user-1", isAdministrator: true, secondFactorVerified: true },
				"assets/..",
			),
		/introuvable/i,
	);
});

test("résout uniquement les contributions frontend autorisées", () => {
	const registry = new FrontendModuleRegistry();
	const component = () => createElement("p", null, "Module chargé");
	registry.register({ identifier: "example.public", kind: "route", path: "/example", component });
	registry.register({
		identifier: "example.private",
		kind: "component",
		requiredCapability: "example.use",
		component,
	});
	assert.equal(registry.resolveRoute("/example", new Set())?.identifier, "example.public");
	assert.equal(registry.resolve("example.private", new Set()), undefined);
	assert.equal(
		registry.resolve("example.private", new Set(["example.use"]))?.identifier,
		"example.private",
	);
	assert.throws(
		() => registry.register({ identifier: "example.public", kind: "page", component }),
		/existe déjà/i,
	);
	const fallback = renderToStaticMarkup(
		createElement(ModuleOutlet, { context: { capabilities: new Set(), locale: "fr-FR" } }),
	);
	assert.match(fallback, /données locales sont conservées/i);
});

test("compose séparément barre principale, sidebar et éléments", () => {
	const mainNavigation = new MainNavigationRegistry();
	const sidebars = new SidebarRegistry();
	const elements = new SidebarElementRegistry();
	const resolver = new NavigationResolver(mainNavigation, sidebars, elements);

	mainNavigation.register({
		identifier: "core.home",
		label: "Accueil",
		href: "/",
		visibility: "hidden",
		systemRole: "home",
	});
	assert.deepEqual(resolver.resolve("/", new Set()), { mainLinks: [] });
	mainNavigation.register({
		identifier: "site.worlds",
		label: "Univers",
		href: "/worlds",
		sidebarIdentifier: "site.worlds.sidebar",
	});
	sidebars.register({ identifier: "site.worlds.sidebar", title: "Univers" });
	elements.register("site.worlds.sidebar", {
		identifier: "site.worlds.category",
		kind: "category",
		label: "Mes univers",
		order: 10,
	});
	elements.register("site.worlds.sidebar", {
		identifier: "site.worlds.create",
		kind: "link",
		label: "Nouvel univers",
		href: "/worlds/new",
		parentIdentifier: "site.worlds.category",
		order: 10,
	});

	const home = resolver.resolve("/", new Set());
	assert.equal(home.mainLinks.length, 1);
	assert.equal(home.mainLinks[0].active, false);
	assert.equal(home.sidebar, undefined);
	const worlds = resolver.resolve("/worlds", new Set());
	assert.equal(worlds.mainLinks[0].active, true);
	assert.equal(worlds.sidebar?.id, "site.worlds.sidebar");
	assert.equal(worlds.sidebar?.items[0].kind, "category");
	assert.equal(worlds.sidebar?.items[0].children[0].id, "site.worlds.create");
	assert.throws(
		() =>
			mainNavigation.register({
				identifier: "other.home",
				label: "Autre accueil",
				href: "/",
				visibility: "hidden",
				systemRole: "home",
			}),
		/existe déjà/i,
	);
});

test("conserve le contrat visuel et accessible du design system", async () => {
	const markup = renderToStaticMarkup(
		createElement(ApplicationShell, {
			primaryNavigation: [{ id: "worlds", label: "Univers", href: "/worlds", active: true }],
			actions: createElement(Button, { tone: "primary" }, "Action"),
			children: createElement(
				"div",
				null,
				createElement(PageHeader, {
					eyebrow: "Section",
					title: "Titre",
					description: "Description",
				}),
				createElement(Card, { title: "Carte", description: "Résumé" }),
				createElement(Switch, { checked: true, label: "Actif", onChange() {} }),
				createElement(Tabs, {
					tabs: [{ id: "one", label: "Premier", content: createElement(Notice, null, "Contenu") }],
					activeId: "one",
					onChange() {},
				}),
				createElement(DateTimePicker, {
					locale: "fr-FR",
					value: "2026-10-11T12:00:00.000Z",
					onChange() {},
				}),
			),
		}),
	);
	assert.match(markup, /aria-current="page"/);
	assert.match(markup, /role="switch"/);
	assert.match(markup, /role="tablist"/);
	assert.match(markup, /aria-haspopup="dialog"/);
	const styles = await readFile(
		new URL("../frontend/styles/src/_components.scss", import.meta.url),
		"utf8",
	);
	assert.match(styles, /prefers-reduced-motion/);
	assert.match(styles, /max-width: 52rem/);
	assert.match(styles, /touch-action: none/);
	const fingerprint = createHash("sha256").update(markup).update(styles).digest("hex");
	assert.equal(fingerprint, "39eedc5336ec7e8dc995e0c32d6c0cb890f7e31d69fb764f14876f882f0d047c");
});
