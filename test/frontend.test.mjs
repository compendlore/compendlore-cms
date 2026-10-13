import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
	AdministrationAssetAccessError,
	AdministrationBundleDelivery,
} from "../backend/build/api/src/index.js";
import {
	ApplicationShell,
	Button,
	catalogEndpoint,
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

test("sert le site et l’administration depuis un seul serveur de développement", async () => {
	const backend = createHttpServer((request, response) => {
		if (
			request.url === "/api/catalog/administration" &&
			request.headers.cookie === "compendlore-admin=verified"
		) {
			response.statusCode = 200;
			response.end("{}");
			return;
		}
		response.statusCode = 403;
		response.end();
	});
	await new Promise((resolve, reject) => {
		backend.once("error", reject);
		backend.listen(0, "127.0.0.1", resolve);
	});
	const backendAddress = backend.address();
	assert.ok(backendAddress && typeof backendAddress === "object");
	const previousApiOrigin = process.env.VITE_API_ORIGIN;
	process.env.VITE_API_ORIGIN = `http://127.0.0.1:${backendAddress.port}`;
	const server = await createServer({
		configFile: fileURLToPath(new URL("../frontend/site/vite.config.ts", import.meta.url)),
		logLevel: "silent",
		root: fileURLToPath(new URL("../frontend/site", import.meta.url)),
		server: { host: "127.0.0.1", port: 0, strictPort: true },
	});
	await server.listen();
	try {
		const address = server.httpServer?.address();
		assert.ok(address && typeof address === "object");
		const origin = `http://127.0.0.1:${address.port}`;
		const site = await globalThis.fetch(`${origin}/`, { headers: { accept: "text/html" } });
		const deniedAdministration = await globalThis.fetch(`${origin}/admin`, {
			redirect: "manual",
			headers: { accept: "text/html" },
		});
		assert.equal(site.status, 200);
		assert.match(await site.text(), /<title>Lore &amp; Dice CMS<\/title>/);
		assert.equal(deniedAdministration.status, 302);
		assert.equal(deniedAdministration.headers.get("location"), "/");
		assert.equal(await deniedAdministration.text(), "");
		const administration = await globalThis.fetch(`${origin}/admin`, {
			headers: {
				accept: "text/html",
				cookie: "compendlore-admin=verified",
			},
		});
		assert.equal(administration.status, 200);
		const administrationDocument = await administration.text();
		assert.match(administrationDocument, /<title>Administration — Lore &amp; Dice CMS<\/title>/);
		assert.match(administrationDocument, /\/administration\/src\/main\.tsx/);
		const administrationEntry = administrationDocument.match(
			/src="([^"]*\/administration\/src\/main\.tsx)"/,
		)?.[1];
		assert.ok(administrationEntry);
		const deniedAsset = await globalThis.fetch(new URL(administrationEntry, origin));
		assert.equal(deniedAsset.status, 404);
		const api = await globalThis.fetch(`${origin}/api/catalog/site`, {
			headers: { accept: "text/html" },
		});
		assert.equal(api.status, 404);
		assert.equal(await api.text(), "Not Found");
	} finally {
		await server.close();
		await new Promise((resolve, reject) =>
			backend.close((error) => (error ? reject(error) : resolve())),
		);
		if (previousApiOrigin === undefined) delete process.env.VITE_API_ORIGIN;
		else process.env.VITE_API_ORIGIN = previousApiOrigin;
	}
});

test("adresse les API sur l’origine backend sans créer de route frontend", () => {
	assert.equal(
		catalogEndpoint("http://localhost:4000", "site"),
		"http://localhost:4000/api/catalog/site",
	);
	assert.equal(
		catalogEndpoint("https://api.example.test", "administration"),
		"https://api.example.test/api/catalog/administration",
	);
	assert.throws(() => catalogEndpoint("https://example.test/backend", "site"));
});

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
					onChange() {},
				}),
			),
		}),
	);
	assert.match(markup, /aria-current="page"/);
	assert.match(markup, /class="application-shell\s+application-shell--without-sidebar"/);
	assert.match(markup, /class="topbar__navigation"/);
	assert.match(markup, /class="page-header"/);
	assert.match(markup, /class="card"/);
	assert.match(markup, /role="switch"/);
	assert.match(markup, /role="tablist"/);
	assert.match(markup, /aria-haspopup="dialog"/);
	assert.match(markup, /class="date-time-picker"/);
	const styles = await readFile(
		new URL("../frontend/styles/src/_components.scss", import.meta.url),
		"utf8",
	);
	assert.match(styles, /prefers-reduced-motion/);
	assert.match(styles, /max-width: 52rem/);
	assert.match(styles, /touch-action: none/);
	assert.match(styles, /\.application-shell/);
	assert.match(styles, /\.topbar/);
	assert.match(styles, /\.date-time-picker/);
});
