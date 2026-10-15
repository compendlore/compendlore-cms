import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { administrationMessage } from "../frontend/administration/build/types/messages.js";
import { siteMessage } from "../frontend/site/build/types/messages.js";
import {
	AdministrationAssetAccessError,
	AdministrationBundleDelivery,
} from "../backend/build/api/src/index.js";
import {
	ApplicationShell,
	Button,
	Card,
	DateTimePicker,
	Field,
	FrontendModuleRegistry,
	formatNotificationTime,
	List,
	ListItem,
	LoadingScreen,
	MainNavigationRegistry,
	Modal,
	ModuleOutlet,
	NavigationResolver,
	NotificationCenter,
	Notice,
	PageHeader,
	SelectField,
	SidebarElementRegistry,
	SidebarRegistry,
	Switch,
	Table,
	Tabs,
	AdministrationSessionGuard,
	hasAdministrationShellAccess,
	paginateNotifications,
	parseNavigationProjection,
	parsePageProjection,
	parseRegistryAdministrationProjection,
	parseAdministrationSessionSnapshot,
	parseNativeNotification,
} from "../frontend/ui/build/types/index.js";

test("valide strictement la projection administrative du Registry", () => {
	const projection = parseRegistryAdministrationProjection({
		generatedAt: "2026-10-15T00:00:00.000Z",
		contributions: [
			{
				key: "module.site",
				identifier: "site",
				type: "module",
				state: "active",
				version: "1.0.0",
				owner: { kind: "native-module", identifier: "native.site" },
				locked: false,
				dependencies: ["module.core"],
				dependents: [],
				blockers: [],
				allowedActions: ["disable", "withdraw"],
			},
		],
	});
	assert.equal(projection.contributions[0].owner.identifier, "native.site");
	assert.throws(() =>
		parseRegistryAdministrationProjection({ ...projection, generatedAt: "invalid" }),
	);
	assert.throws(() =>
		parseRegistryAdministrationProjection({
			...projection,
			contributions: [{ ...projection.contributions[0], allowedActions: ["delete"] }],
		}),
	);
});

test("consomme une projection de page API sans route métier React", async () => {
	const projection = parsePageProjection({
		identifier: "core.home",
		component: "core.home",
		title: "Accueil",
		content: [{ kind: "header", title: "Accueil" }],
		revision: 1,
		fingerprint: "a".repeat(64),
	});
	assert.equal(projection.component, "core.home");
	assert.throws(() => parsePageProjection({ ...projection, component: "<script>" }));

	const [site, administration] = await Promise.all([
		readFile(new URL("../frontend/site/src/App.tsx", import.meta.url), "utf8"),
		readFile(new URL("../frontend/administration/src/App.tsx", import.meta.url), "utf8"),
	]);
	for (const application of [site, administration]) {
		assert.match(application, /usePageProjection\(/);
		assert.doesNotMatch(application, /kind:\s*"route"/);
		assert.doesNotMatch(application, /registry\.resolveRoute\(/);
	}
});

test("sert le site et l’administration depuis un seul serveur de développement", async () => {
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
		const administrationRedirect = await globalThis.fetch(`${origin}/admin`, {
			headers: { accept: "text/html" },
			redirect: "manual",
		});
		const administration = await globalThis.fetch(`${origin}/admin?administration-preview=1`, {
			headers: { accept: "text/html" },
		});
		assert.equal(administrationRedirect.status, 302);
		assert.equal(administrationRedirect.headers.get("location"), "/");
		assert.equal(site.status, 200);
		assert.match(await site.text(), /<title>Compendlore CMS<\/title>/);
		assert.equal(administration.status, 200);
		const administrationDocument = await administration.text();
		assert.match(administrationDocument, /<title>Administration — Compendlore CMS<\/title>/);
		assert.match(administrationDocument, /\/administration\/src\/main\.tsx/);
	} finally {
		await server.close();
	}
});

test("protège le shell et les diagnostics de l’administration", async () => {
	const [application, siteConfig, administrationConfig] = await Promise.all([
		readFile(new URL("../frontend/administration/src/App.tsx", import.meta.url), "utf8"),
		readFile(new URL("../frontend/site/vite.config.ts", import.meta.url), "utf8"),
		readFile(new URL("../frontend/administration/vite.config.ts", import.meta.url), "utf8"),
	]);

	assert.match(siteConfig, /administration-preview/);
	assert.match(siteConfig, /statusCode = 302/);
	assert.match(siteConfig, /setHeader\("location", "\/"\)/);
	assert.match(administrationConfig, /base:\s*"\/admin\/"/);
	assert.match(administrationConfig, /manifest:\s*true/);
	assert.match(administrationConfig, /sourcemap:\s*false/);
	assert.match(application, /status:\s*"authenticated"/);
	assert.match(application, /session:\s*administrationSession/);
	assert.match(application, /administration\.notFound\.title/);
	assert.equal(
		administrationMessage("fr-FR", "administration.notFound.title"),
		"Page administrative indisponible",
	);
	assert.equal(
		administrationMessage("de-DE", "administration.notFound.title"),
		"Administration page unavailable",
	);
});

test("verrouille le socle technique frontend et ses deux applications", async () => {
	const [rootSource, siteSource, administrationSource, stylesSource, siteConfig, adminConfig] =
		await Promise.all([
			readFile(new URL("../package.json", import.meta.url), "utf8"),
			readFile(new URL("../frontend/site/package.json", import.meta.url), "utf8"),
			readFile(new URL("../frontend/administration/package.json", import.meta.url), "utf8"),
			readFile(new URL("../frontend/styles/package.json", import.meta.url), "utf8"),
			readFile(new URL("../frontend/site/vite.config.ts", import.meta.url), "utf8"),
			readFile(new URL("../frontend/administration/vite.config.ts", import.meta.url), "utf8"),
		]);
	const root = JSON.parse(rootSource);
	const site = JSON.parse(siteSource);
	const administration = JSON.parse(administrationSource);
	const styles = JSON.parse(stylesSource);

	assert.ok(root.workspaces.includes("frontend/*"));
	assert.match(root.devDependencies.typescript, /^6\./);
	assert.equal(site.name, "@compendlore/site");
	assert.equal(administration.name, "@compendlore/administration");
	assert.equal(site.dependencies.react, administration.dependencies.react);
	assert.equal(site.dependencies["react-dom"], administration.dependencies["react-dom"]);
	assert.equal(site.devDependencies.vite, administration.devDependencies.vite);
	assert.equal(
		site.devDependencies["sass-embedded"],
		administration.devDependencies["sass-embedded"],
	);
	assert.equal(site.dependencies["@compendlore/styles"], "0.0.0");
	assert.equal(administration.dependencies["@compendlore/styles"], "0.0.0");
	assert.equal(styles.exports["."].sass, "./src/index.scss");
	assert.equal(site.scripts.dev, "vite --port 5173");
	assert.equal(administration.scripts.dev, "npm run dev --workspace @compendlore/site");
	assert.match(siteConfig, /administrationDevelopmentHost/);
	assert.match(siteConfig, /manifest:\s*true/);
	assert.match(siteConfig, /sourcemap:\s*false/);
	assert.match(adminConfig, /base:\s*"\/admin\/"/);
	assert.match(adminConfig, /manifest:\s*true/);
	assert.match(adminConfig, /sourcemap:\s*false/);
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
	assert.equal(asset.cacheControl, "no-store, private");
	assert.match(asset.contentSecurityPolicy, /default-src 'none'/);
	assert.match(asset.contentSecurityPolicy, /frame-ancestors 'none'/);
	assert.equal(reads, 1);
	await assert.rejects(
		() =>
			delivery.deliver(
				{ userId: "user-1", isAdministrator: true, secondFactorVerified: true },
				"/assets/admin.js.map",
			),
		{ code: "administration.asset_not_found" },
	);
	await assert.rejects(
		() =>
			delivery.deliver(
				{ userId: "user-1", isAdministrator: true, secondFactorVerified: true },
				"assets/..",
			),
		{ code: "administration.asset_not_found" },
	);
	await assert.rejects(
		() =>
			delivery.deliver(
				{
					userId: "user-1",
					isAdministrator: true,
					secondFactorVerified: true,
					sessionActive: false,
				},
				"index.html",
			),
		{ code: "authorization.denied" },
	);
	await assert.rejects(
		() =>
			delivery.deliver(
				{
					userId: "user-1",
					isAdministrator: true,
					secondFactorVerified: true,
					secondFactorExpiresAt: new Date("2026-10-14T12:00:00.000Z"),
				},
				"index.html",
			),
		{ code: "administration.second_factor_required" },
	);
});

test("révoque immédiatement le shell administratif et purge son état sensible", () => {
	const active = parseAdministrationSessionSnapshot({
		status: "authenticated",
		subjectIdentifier: "user-1",
		roles: ["administrator"],
		capabilities: ["core.administration.access"],
		secondFactorVerified: true,
		secondFactorExpiresAt: Date.parse("2026-10-14T14:00:00.000Z"),
		revision: "revision-1",
	});
	let purges = 0;
	let redirects = 0;
	const guard = new AdministrationSessionGuard({
		purgeSensitiveState() {
			purges += 1;
		},
		leaveAdministration() {
			redirects += 1;
		},
	});
	assert.equal(hasAdministrationShellAccess(active, Date.parse("2026-10-14T13:00:00.000Z")), true);
	assert.equal(guard.revalidate(active, Date.parse("2026-10-14T13:00:00.000Z")), true);
	assert.equal(guard.revalidate(active, Date.parse("2026-10-14T15:00:00.000Z")), false);
	guard.revoke();
	assert.equal(purges, 1);
	assert.equal(redirects, 1);
});

test("synchronise la révocation du shell entre les onglets", async () => {
	const application = await readFile(
		new URL("../frontend/administration/src/App.tsx", import.meta.url),
		"utf8",
	);
	assert.match(application, /BroadcastChannel\("compendlore-administration-security"\)/);
	assert.match(application, /event\.data === "revoked"[\s\S]*guard\.revoke\(\)/);
	assert.match(application, /postMessage\("revoked"\)/);
});

test("pagine le centre de notifications sans dépendre du temps réel", () => {
	const items = ["one", "two", "three"].map((id) =>
		parseNativeNotification({
			id,
			title: `Notification ${id}`,
			message: "Plain localized content",
			presentation: "inbox",
			tone: "information",
			occurredAt: "2026-10-14T12:00:00.000Z",
			read: false,
			displayDurationMs: 5_000,
		}),
	);
	const first = paginateNotifications(items, undefined, 2);
	const second = paginateNotifications(items, first.nextCursor, 2);
	assert.deepEqual(
		first.items.map((item) => item.id),
		["one", "two"],
	);
	assert.equal(first.nextCursor, "two");
	assert.deepEqual(
		second.items.map((item) => item.id),
		["three"],
	);
	assert.equal(second.nextCursor, undefined);
	const markup = renderToStaticMarkup(
		createElement(NotificationCenter, {
			page: first,
			locale: "en-GB",
			nextPageLabel: "Next notifications",
			onNextPage() {},
		}),
	);
	assert.match(markup, /aria-label="Notifications"/);
	assert.match(markup, /Next notifications/);
});

test("limite les notifications aux présentations natives et au texte sûr", () => {
	assert.throws(
		() =>
			parseNativeNotification({
				id: "unsafe",
				title: "Unsafe",
				message: "<script>alert(1)</script>",
				presentation: "popup",
				tone: "danger",
				occurredAt: "2026-10-14T12:00:00.000Z",
				read: false,
			}),
		/Safe plain text|safe plain text/i,
	);
	assert.throws(
		() =>
			parseNativeNotification({
				id: "custom",
				title: "Custom",
				message: "No arbitrary component",
				presentation: "custom-component",
				tone: "information",
				occurredAt: "2026-10-14T12:00:00.000Z",
				read: false,
			}),
		/not supported/i,
	);
	assert.throws(
		() =>
			parseNativeNotification({
				id: "duration",
				title: "Invalid duration",
				message: "Duration is bounded",
				presentation: "toast",
				tone: "information",
				occurredAt: "2026-10-14T12:00:00.000Z",
				read: false,
				displayDurationMs: 120_001,
			}),
		/display duration is invalid/i,
	);
});

test("présente le temps récent des notifications relativement et le temps ancien localement", () => {
	const now = Date.parse("2026-10-14T20:00:00.000Z");
	const olderNotification = "2026-10-14T17:00:00.000Z";
	assert.equal(
		formatNotificationTime("2026-10-14T19:59:42.000Z", "fr-FR", now),
		"Il y a 18 secondes",
	);
	assert.equal(
		formatNotificationTime("2026-10-14T19:48:00.000Z", "fr-FR", now),
		"Il y a 12 minutes",
	);
	assert.equal(
		formatNotificationTime(olderNotification, "fr-FR", now),
		new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(
			new Date(olderNotification),
		),
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
		/already exists/i,
	);
	assert.throws(
		() =>
			registry.register({
				identifier: "example.route-collision",
				kind: "route",
				path: "/example",
				component,
			}),
		/route \/example already exists/i,
	);
	const fallback = renderToStaticMarkup(
		createElement(ModuleOutlet, {
			context: {
				capabilities: new Set(),
				locale: "fr-FR",
				session: { status: "anonymous", roles: [], capabilities: new Set() },
			},
		}),
	);
	assert.match(fallback, /données locales sont conservées/i);
});

test("isole les modules défaillants et conserve leur état externe", async () => {
	const [moduleHost, siteApplication] = await Promise.all([
		readFile(new URL("../frontend/ui/src/module-host.tsx", import.meta.url), "utf8"),
		readFile(new URL("../frontend/site/src/App.tsx", import.meta.url), "utf8"),
	]);
	const registry = new FrontendModuleRegistry();
	const component = ({ state }) => createElement("p", null, String(state));
	for (const kind of ["action", "component", "form", "menu", "page"]) {
		registry.register({
			identifier: `example.${kind}`,
			kind,
			requiredCapability: "example.use",
			component,
		});
	}
	assert.deepEqual(registry.list("menu", new Set()), []);
	assert.equal(registry.list("menu", new Set(["example.use"]))[0]?.identifier, "example.menu");
	const rendered = renderToStaticMarkup(
		createElement(ModuleOutlet, {
			contribution: registry.resolve("example.component", new Set(["example.use"])),
			context: {
				capabilities: new Set(["example.use"]),
				locale: "en-US",
				session: { status: "authenticated", roles: ["member"], capabilities: new Set() },
			},
			state: "Preserved draft",
		}),
	);
	assert.match(rendered, /Preserved draft/);
	assert.match(moduleHost, /class ModuleErrorBoundary/);
	assert.match(moduleHost, /componentDidCatch/);
	assert.match(moduleHost, /Frontend module rendering failed/);
	assert.match(moduleHost, /key=\{contribution\.identifier\}/);
	assert.match(
		siteApplication,
		/new URLSearchParams\(window\.location\.search\)\.has\("module-host"\)/,
	);
	assert.match(siteApplication, /state=\{draft\}/);
	assert.match(siteApplication, /setDraft\(String\(nextState\)\)/);
	assert.match(siteApplication, /Retirer la capacité/);
	assert.match(siteApplication, /Restaurer la capacité/);
});

test("préserve le shell public, la session et les replis du site", async () => {
	const [siteApplication, moduleHost, shell] = await Promise.all([
		readFile(new URL("../frontend/site/src/App.tsx", import.meta.url), "utf8"),
		readFile(new URL("../frontend/ui/src/module-host.tsx", import.meta.url), "utf8"),
		readFile(new URL("../frontend/ui/src/shell.tsx", import.meta.url), "utf8"),
	]);

	assert.match(siteApplication, /status:\s*"anonymous"/);
	assert.match(siteApplication, /roles:\s*Object\.freeze\(\[\]\)/);
	assert.match(siteApplication, /capabilities:\s*new Set<string>\(\["core\.site\.view"\]\)/);
	assert.match(siteApplication, /session:\s*publicSession/);
	assert.match(siteApplication, /addEventListener\("popstate"/);
	assert.match(siteApplication, /history\.pushState/);
	assert.match(siteApplication, /usePageProjection\(/);
	assert.match(siteApplication, /registry\.resolve\(page\.component, capabilities\)/);
	assert.match(siteApplication, /fallback=\{/);
	assert.match(siteApplication, /site\.notFound\.title/);
	assert.equal(siteMessage("fr-FR", "site.notFound.title"), "Erreur page inconnue");
	assert.equal(
		siteMessage("fr-CA", "site.notFound.description"),
		"La page que vous avez essayé d’ouvrir n’existe pas.",
	);
	assert.equal(siteMessage("de-DE", "site.notFound.code"), "Error 404");
	assert.match(moduleHost, /status:\s*"anonymous"\s*\|\s*"authenticated"/);
	assert.match(moduleHost, /title:\s*"Module indisponible"/);
	assert.match(moduleHost, /Vos données locales sont conservées/);
	assert.match(shell, /aria-label="Navigation principale"/);
	assert.match(shell, /aria-current=\{item\.active \? "page" : undefined\}/);

	const unavailable = renderToStaticMarkup(
		createElement(ModuleOutlet, {
			context: {
				capabilities: new Set(["core.site.view"]),
				locale: "fr-FR",
				session: {
					status: "anonymous",
					roles: [],
					capabilities: new Set(["core.site.view"]),
				},
			},
		}),
	);
	assert.match(unavailable, /Module indisponible/);
	assert.match(unavailable, /données locales sont conservées/);

	const notFound = renderToStaticMarkup(
		createElement(
			Notice,
			{
				tone: "danger",
				title: siteMessage("fr-FR", "site.notFound.title"),
				badge: siteMessage("fr-FR", "site.notFound.code"),
			},
			siteMessage("fr-FR", "site.notFound.description"),
		),
	);
	assert.match(notFound, /Erreur page inconnue/);
	assert.match(notFound, /La page que vous avez essayé d’ouvrir n’existe pas/);
	assert.match(notFound, /class="notice__badge">Erreur 404/);
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
		identifier: "site.worlds.separator",
		kind: "separator",
		label: "Gestion",
		order: 20,
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
	assert.equal(worlds.sidebar?.items[1].kind, "separator");
	elements.register("site.worlds.sidebar", {
		identifier: "site.worlds.create.deep",
		kind: "link",
		label: "Niveau interdit",
		href: "/worlds/new/deep",
		parentIdentifier: "site.worlds.create",
		order: 10,
	});
	assert.throws(() => resolver.resolve("/worlds", new Set()), /only one nested link level/i);
	assert.throws(
		() =>
			mainNavigation.register({
				identifier: "other.home",
				label: "Autre accueil",
				href: "/",
				visibility: "hidden",
				systemRole: "home",
			}),
		/already exists/i,
	);
});

test("consomme une projection de navigation API sans définition métier React", async () => {
	const projection = parseNavigationProjection({
		brand: {
			identifier: "core.home",
			type: "brand",
			label: "Compendlore CMS",
			target: { kind: "route", value: "/" },
			active: true,
		},
		primary: [
			{
				identifier: "site.worlds",
				type: "primary",
				label: "Univers",
				target: { kind: "route", value: "/worlds" },
				active: false,
			},
		],
		actions: [
			{
				identifier: "core.logout",
				type: "action",
				label: "Déconnexion",
				target: { kind: "action", value: "core.logout" },
				active: false,
			},
		],
		sidebar: {
			identifier: "site.worlds.sidebar",
			title: "Univers",
			items: [
				{
					identifier: "site.worlds.collection",
					kind: "category",
					label: "Collection",
					initiallyExpanded: true,
					children: [
						{
							identifier: "site.worlds.recent",
							kind: "link",
							label: "Ajouts récents",
							target: { kind: "route", value: "/worlds/recent" },
							active: false,
							children: [],
						},
					],
				},
			],
		},
	});
	assert.equal(projection.brand.href, "/");
	assert.equal(projection.primary[0].href, "/worlds");
	assert.equal(projection.actions[0].command, "core.logout");
	assert.equal(projection.sidebar?.items[0].children[0].id, "site.worlds.recent");
	assert.throws(
		() =>
			parseNavigationProjection({
				brand: {
					identifier: "core.home",
					type: "brand",
					label: "Compendlore CMS",
					target: { kind: "route", value: "javascript:alert(1)" },
					active: true,
				},
				primary: [],
				actions: [],
			}),
		/invalid/i,
	);

	const [site, administration] = await Promise.all([
		readFile(new URL("../frontend/site/src/App.tsx", import.meta.url), "utf8"),
		readFile(new URL("../frontend/administration/src/App.tsx", import.meta.url), "utf8"),
	]);
	assert.doesNotMatch(site, /new MainNavigationRegistry|navigationResolver\.resolve/);
	assert.doesNotMatch(
		administration,
		/new SidebarRegistry|administrationSidebarElements\.register/,
	);
	assert.match(site, /useNavigationProjection/);
	assert.match(administration, /useNavigationProjection/);
});

test("rend les menus compacts sans dupliquer navigation, actions ou sidebar", () => {
	const markup = renderToStaticMarkup(
		createElement(ApplicationShell, {
			primaryNavigation: [{ id: "worlds", label: "Univers", href: "/worlds", active: true }],
			sidebar: {
				id: "worlds-sidebar",
				title: "Univers",
				items: [
					{
						kind: "category",
						id: "collection",
						label: "Collection",
						initiallyExpanded: true,
						children: [
							{
								kind: "link",
								id: "recent",
								label: "Ajouts récents",
								href: "/worlds/recent",
								active: false,
								children: [],
							},
						],
					},
					{ kind: "separator", id: "tools", label: "Outils" },
				],
			},
			actions: createElement(Button, null, "Créer"),
			children: createElement("p", null, "Contenu"),
		}),
	);
	assert.equal((markup.match(/aria-label="Navigation principale"/g) ?? []).length, 1);
	assert.equal((markup.match(/>Créer</g) ?? []).length, 1);
	assert.equal((markup.match(/aria-label="Navigation du site"/g) ?? []).length, 1);
	assert.match(markup, /aria-label="Ouvrir le menu principal"/);
	assert.match(markup, /aria-label="Ouvrir le menu latéral"/);
	assert.match(markup, /aria-expanded="false"/);
	assert.match(markup, /role="separator" aria-label="Outils"/);
	assert.match(markup, /Ajouts récents/);
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

test("couvre les primitives partagées et leur contrat accessible", async () => {
	const markup = renderToStaticMarkup(
		createElement(
			"main",
			null,
			createElement(Button, { tone: "secondary", disabled: true }, "Enregistrer"),
			createElement(Field, {
				id: "display-name",
				label: "Nom affiché",
				error: "Champ requis",
			}),
			createElement(SelectField, {
				id: "locale",
				label: "Langue",
				hint: "Langue de l’interface",
				options: [{ value: "fr", label: "Français" }],
			}),
			createElement(Switch, { checked: false, label: "Notifications", onChange() {} }),
			createElement(Tabs, {
				tabs: [
					{ id: "general", label: "Général", content: "Contenu général" },
					{ id: "security", label: "Sécurité", content: "Contenu sécurité" },
				],
				activeId: "general",
				onChange() {},
			}),
			createElement(
				Modal,
				{ open: true, title: "Confirmation", onClose() {} },
				createElement(Button, null, "Confirmer"),
			),
			createElement(Table, {
				caption: "Utilisateurs",
				columns: [{ key: "name", title: "Nom", render: (row) => row.name }],
				rows: [],
				rowKey: (row) => row.name,
				emptyLabel: "Aucun utilisateur",
			}),
			createElement(List, { ordered: true }, createElement(ListItem, null, "Première étape")),
			createElement(Notice, { tone: "danger", title: "Erreur" }, "Action impossible"),
			createElement(LoadingScreen, { message: "Préparation" }),
		),
	);

	assert.match(markup, /button--secondary/);
	assert.match(markup, /disabled=""/);
	assert.match(markup, /aria-describedby="display-name-description"/);
	assert.match(markup, /aria-invalid="true"/);
	assert.match(markup, /aria-describedby="locale-description"/);
	assert.match(markup, /role="switch"/);
	assert.match(markup, /role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"/);
	assert.match(markup, /role="tab"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
	assert.match(markup, /role="tabpanel"[^>]*tabindex="0"/);
	assert.match(markup, /role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby=/);
	assert.match(markup, /<th scope="col"/);
	assert.match(markup, /<ol class="list"><li class="list__item">/);
	assert.match(markup, /role="alert"/);
	assert.match(markup, /role="status" aria-live="polite"/);

	const primitives = await readFile(
		new URL("../frontend/ui/src/primitives.tsx", import.meta.url),
		"utf8",
	);
	const siteApplication = await readFile(
		new URL("../frontend/site/src/App.tsx", import.meta.url),
		"utf8",
	);
	for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "Escape", "Tab"]) {
		assert.ok(primitives.includes(`"${key}"`), `Missing keyboard support for ${key}.`);
	}
	assert.match(primitives, /previouslyFocused\?\.focus\(\)/);
	assert.match(primitives, /querySelectorAll<HTMLElement>/);
	assert.match(siteApplication, /import\.meta\.env\.DEV/);
	assert.match(siteApplication, /URLSearchParams[\s\S]*design-system/);
	assert.match(siteApplication, /DevelopmentDesignSystemPage/);
});

test("préserve la récupération visuelle historique sans ressource distante", async () => {
	const [tokens, foundation, components, icons] = await Promise.all([
		readFile(new URL("../frontend/styles/src/_tokens.scss", import.meta.url), "utf8"),
		readFile(new URL("../frontend/styles/src/_foundation.scss", import.meta.url), "utf8"),
		readFile(new URL("../frontend/styles/src/_components.scss", import.meta.url), "utf8"),
		readFile(new URL("../frontend/ui/src/icons.tsx", import.meta.url), "utf8"),
	]);

	for (const token of [
		"color-background",
		"color-background-soft",
		"color-field",
		"color-surface",
		"color-surface-raised",
		"color-border",
		"color-border-strong",
		"color-text",
		"color-text-strong",
		"color-text-muted",
		"color-text-dim",
		"color-accent",
		"color-accent-soft",
		"color-danger",
		"color-success",
		"font-display",
		"font-interface",
		"content-width",
		"topbar-height",
		"sidebar-width",
		"space-unit",
		"transition",
	]) {
		assert.match(tokens, new RegExp(`\\$${token}:`));
	}
	assert.match(tokens, /"Cinzel"/);
	assert.match(tokens, /"DM Sans"/);
	assert.match(tokens, /system-ui/);
	assert.match(foundation, /radial-gradient/);
	assert.match(foundation, /tokens\.\$font-display/);

	for (const selector of [
		"button",
		"field",
		"switch",
		"topbar",
		"brand",
		"sidebar",
		"page-header",
		"card",
		"tabs",
		"table",
		"notice",
		"modal",
		"date-time-picker",
		"calendar",
		"loading-screen",
		"error-page",
	]) {
		assert.match(components, new RegExp(`\\.${selector}(?:[\\s_{:.>-]|$)`));
	}
	for (const state of [":hover", ":active", ":disabled", ":focus-visible", "aria-selected"]) {
		assert.ok(components.includes(state), `Missing recovered interactive state: ${state}`);
	}
	assert.match(components, /@keyframes cms-spin/);
	assert.match(components, /@media \(prefers-reduced-motion: reduce\)/);
	assert.doesNotMatch(`${tokens}\n${foundation}\n${components}`, /https?:|@import|url\s*\(/i);

	for (const icon of [
		"account",
		"administration",
		"alert",
		"brand",
		"chevron",
		"logout",
		"menu",
		"settings",
	]) {
		assert.match(icons, new RegExp(`(?:"${icon}"|${icon}:)`));
	}
});
