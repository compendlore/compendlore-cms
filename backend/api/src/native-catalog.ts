import type { IncomingMessage } from "node:http";
import type {
	NativeContentInspection,
	NativeContentRegistry,
} from "../../cms-registry/src/index.js";

export interface NativeCatalogIdentity {
	readonly authenticated: boolean;
	readonly capabilities: ReadonlySet<string>;
	readonly permissions: ReadonlySet<string>;
	readonly roles: ReadonlySet<string>;
}

export interface NativeCatalogIdentityResolver {
	resolve(request: IncomingMessage): Promise<NativeCatalogIdentity>;
}

export interface NativeCatalogResponse {
	readonly revision: string;
	readonly locale: string;
	readonly navigation: ReturnType<NativeContentRegistry["navigation"]["resolve"]>;
	readonly routeParameterTypes: ReturnType<NativeContentRegistry["pages"]["listParameterTypes"]>;
	readonly pages: readonly {
		readonly identifier: string;
		readonly route: string;
		readonly surface: "account" | "administration" | "site" | "system";
		readonly routes: ReturnType<NativeContentRegistry["pages"]["list"]>[number]["routes"];
		readonly title: string;
		readonly description?: string;
		readonly contributionKey: string;
		readonly editable: boolean;
		readonly removable: boolean;
		readonly context: ReturnType<NativeContentRegistry["pages"]["list"]>[number]["context"];
		readonly revision: number;
		readonly document: ReturnType<NativeContentRegistry["pages"]["history"]>[number]["document"];
	}[];
	readonly contributions?: readonly NativeContentInspection[];
}

export class NativeCatalogApi {
	constructor(private readonly registry: NativeContentRegistry) {}

	read(input: {
		readonly surface: "administration" | "site";
		readonly requestedLocales: readonly string[];
		readonly defaultLocale: string;
		readonly identity: NativeCatalogIdentity;
	}): NativeCatalogResponse {
		if (
			input.surface === "administration" &&
			!input.identity.capabilities.has("core.administration.access")
		) {
			throw new NativeCatalogAccessError();
		}
		const localization = {
			requestedLocales: input.requestedLocales,
			defaultLocale: input.defaultLocale,
		};
		const navigation = resolveNavigationRoutes(
			this.registry.navigation.resolve(
				{
					...input.identity,
					features: new Set(),
					events: new Set(),
					now: new Date(),
				},
				localization,
			),
			this.registry,
		);
		const pages = this.registry.pages
			.list()
			.filter((page) =>
				input.surface === "site"
					? page.surface === "site" || page.surface === "account" || page.surface === "system"
					: page.surface === "administration" || page.surface === "system",
			)
			.map((page) =>
				this.registry.pages.describe(page.identifier, input.identity.capabilities, localization),
			)
			.filter((page): page is NonNullable<typeof page> => Boolean(page))
			.map((page) => ({
				...page,
				route:
					page.routes.find((route) => route.canonical)?.pattern ?? page.routes[0]?.pattern ?? "/",
			}));
		return {
			revision: navigation.revision,
			locale: navigation.locale,
			navigation,
			routeParameterTypes: this.registry.pages.listParameterTypes(),
			pages,
			...(input.surface === "administration" ? { contributions: this.registry.list() } : {}),
		};
	}
}

function resolveNavigationRoutes(
	navigation: ReturnType<NativeContentRegistry["navigation"]["resolve"]>,
	registry: NativeContentRegistry,
): ReturnType<NativeContentRegistry["navigation"]["resolve"]> {
	const resolveLink = <
		T extends {
			readonly mode: string;
			readonly target: string;
			readonly routeParameters?: Readonly<Record<string, string | number>>;
		},
	>(
		link: T,
	): T =>
		link.mode === "route"
			? {
					...link,
					target: registry.pages.buildRoute(link.target, link.routeParameters ?? {}),
				}
			: link;
	const resolveSidebarItem = (
		item: (typeof navigation.sidebars)[number]["items"][number],
	): (typeof navigation.sidebars)[number]["items"][number] => {
		if (item.kind === "separator") return item;
		return {
			...item,
			...(item.link ? { link: resolveLink(item.link) } : {}),
			children: item.children.map(resolveSidebarItem),
		};
	};
	return {
		...navigation,
		brand: resolveLink(navigation.brand),
		primary: navigation.primary.map(resolveLink),
		actions: navigation.actions.map(resolveLink),
		sidebars: navigation.sidebars.map((sidebar) => ({
			...sidebar,
			items: sidebar.items.map(resolveSidebarItem),
		})),
	};
}

export class NativeCatalogAccessError extends Error {
	readonly code = "authorization.denied";
	readonly httpStatus = 403;

	constructor() {
		super("L’accès au catalogue administratif est interdit.");
		this.name = "NativeCatalogAccessError";
	}
}

let configuredCatalog: NativeCatalogApi | undefined;
let configuredIdentities: NativeCatalogIdentityResolver | undefined;

export function configureNativeCatalogApi(
	catalog: NativeCatalogApi,
	identities: NativeCatalogIdentityResolver,
): void {
	if (configuredCatalog || configuredIdentities)
		throw new Error("Le catalogue natif est déjà configuré.");
	configuredCatalog = catalog;
	configuredIdentities = identities;
}

export async function readConfiguredNativeCatalog(
	request: IncomingMessage,
	surface: "administration" | "site",
): Promise<NativeCatalogResponse> {
	if (!configuredCatalog || !configuredIdentities) {
		throw new NativeCatalogUnavailableError();
	}
	const identity = await configuredIdentities.resolve(request);
	const requestedLocales = String(request.headers["accept-language"] ?? "")
		.split(",")
		.map((entry) => entry.split(";", 1)[0]!.trim())
		.filter(Boolean);
	return configuredCatalog.read({
		surface,
		requestedLocales,
		defaultLocale: "en",
		identity,
	});
}

export class NativeCatalogUnavailableError extends Error {
	readonly code = "catalog.unavailable";
	readonly httpStatus = 503;

	constructor() {
		super("Le catalogue natif n’est pas configuré.");
		this.name = "NativeCatalogUnavailableError";
	}
}
