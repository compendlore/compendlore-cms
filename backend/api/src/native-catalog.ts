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
	readonly pages: readonly {
		readonly identifier: string;
		readonly route: string;
		readonly surface: "account" | "administration" | "site";
		readonly title: string;
		readonly description?: string;
		readonly contributionKey: string;
		readonly editable: boolean;
		readonly removable: boolean;
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
		const navigation = this.registry.navigation.resolve(
			{
				...input.identity,
				features: new Set(),
				events: new Set(),
				now: new Date(),
			},
			localization,
		);
		const pages = this.registry.pages
			.list()
			.filter((page) => page.surface === input.surface)
			.map((page) =>
				this.registry.pages.resolve(page.route, input.identity.capabilities, localization),
			)
			.filter((page): page is NonNullable<typeof page> => Boolean(page));
		return {
			revision: navigation.revision,
			locale: navigation.locale,
			navigation,
			pages,
			...(input.surface === "administration" ? { contributions: this.registry.list() } : {}),
		};
	}
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
