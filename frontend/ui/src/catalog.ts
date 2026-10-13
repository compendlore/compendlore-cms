import { useEffect, useState } from "react";
import type { IconName } from "./icons.js";
import type { NavigationLinkView, SidebarElementView, SidebarView } from "./navigation.js";
import type { CatalogPage } from "./page-host.js";

export interface CatalogNavigationLink {
	readonly identifier: string;
	readonly position: "action" | "brand" | "primary";
	readonly title: string;
	readonly subtitle?: string;
	readonly tooltip?: string;
	readonly iconIdentifier?: string;
	readonly mode: string;
	readonly target: string;
	readonly sidebarIdentifier?: string;
	readonly colorToken?: string;
	readonly order: number;
}

export type CatalogSidebarItem =
	| {
			readonly identifier: string;
			readonly kind: "separator";
			readonly text?: string;
			readonly iconIdentifier?: string;
			readonly order: number;
	  }
	| {
			readonly identifier: string;
			readonly kind: "category" | "link";
			readonly text?: string;
			readonly tooltip?: string;
			readonly iconIdentifier?: string;
			readonly accessibleLabel?: string;
			readonly initiallyExpanded: boolean;
			readonly link?: Omit<CatalogNavigationLink, "position" | "sidebarIdentifier">;
			readonly children: readonly CatalogSidebarItem[];
			readonly order: number;
	  };

export interface NativeCatalogDocument {
	readonly revision: string;
	readonly locale: string;
	readonly navigation: {
		readonly brand: CatalogNavigationLink;
		readonly primary: readonly CatalogNavigationLink[];
		readonly actions: readonly CatalogNavigationLink[];
		readonly sidebars: readonly {
			readonly identifier: string;
			readonly title?: string;
			readonly subtitle?: string;
			readonly iconIdentifier?: string;
			readonly items: readonly CatalogSidebarItem[];
		}[];
	};
	readonly routeParameterTypes: readonly {
		readonly identifier: string;
		readonly base: "integer" | "locale" | "slug" | "string" | "uuid";
		readonly maximumLength?: number;
		readonly allowedValues?: readonly string[];
	}[];
	readonly pages: readonly (CatalogPage & { readonly route: string })[];
	readonly contributions?: readonly {
		readonly contributionKey: string;
		readonly owner: { readonly kind: string; readonly identifier: string };
		readonly version: string;
		readonly state: "active" | "disabled" | "withdrawn";
		readonly dependencies: readonly string[];
		readonly counts: Readonly<Record<string, number>>;
		readonly locked: boolean;
	}[];
}

export type CatalogLoadState =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly catalog: NativeCatalogDocument }
	| { readonly status: "unavailable" };

export function useNativeCatalog(surface: "administration" | "site"): CatalogLoadState {
	const [state, setState] = useState<CatalogLoadState>({ status: "loading" });
	useEffect(() => {
		const controller = new AbortController();
		void fetch(`/api/catalog/${surface}`, {
			headers: { accept: "application/json", "accept-language": navigator.language || "en" },
			credentials: "same-origin",
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok) throw new Error("catalog-unavailable");
				return (await response.json()) as NativeCatalogDocument;
			})
			.then((catalog) => setState({ status: "ready", catalog }))
			.catch((error: unknown) => {
				if (!(error instanceof DOMException && error.name === "AbortError")) {
					setState({ status: "unavailable" });
				}
			});
		return () => controller.abort();
	}, [surface]);
	return state;
}

export function navigationFromCatalog(
	catalog: NativeCatalogDocument,
	path: string,
): {
	readonly brand: NavigationLinkView;
	readonly primary: readonly NavigationLinkView[];
	readonly actions: readonly CatalogNavigationLink[];
	readonly sidebar?: SidebarView;
} {
	const active = [...catalog.navigation.primary, ...catalog.navigation.actions].find(
		(item) => item.mode === "route" && (item.target === path || path.startsWith(`${item.target}/`)),
	);
	const sidebar = active?.sidebarIdentifier
		? catalog.navigation.sidebars.find(
				(candidate) => candidate.identifier === active.sidebarIdentifier,
			)
		: undefined;
	const sidebarIcon = icon(sidebar?.iconIdentifier);
	return {
		brand: linkView(catalog.navigation.brand, path),
		primary: catalog.navigation.primary.map((item) => linkView(item, path)),
		actions: catalog.navigation.actions,
		...(sidebar
			? {
					sidebar: {
						id: sidebar.identifier,
						title: sidebar.title ?? "",
						...(sidebar.subtitle ? { subtitle: sidebar.subtitle } : {}),
						...(sidebarIcon ? { icon: sidebarIcon } : {}),
						items: sidebar.items.map((item) => sidebarItem(item, path)),
					},
				}
			: {}),
	};
}

function linkView(item: CatalogNavigationLink, path: string): NavigationLinkView {
	const itemIcon = icon(item.iconIdentifier);
	return {
		id: item.identifier,
		label: item.title,
		href: item.mode === "route" ? item.target : `#${item.target}`,
		...(itemIcon ? { icon: itemIcon } : {}),
		...(item.subtitle || item.tooltip ? { description: item.subtitle ?? item.tooltip } : {}),
		active: item.mode === "route" && item.target === path,
	};
}

function sidebarItem(item: CatalogSidebarItem, path: string): SidebarElementView {
	const itemIcon = icon(item.iconIdentifier);
	if (item.kind === "separator") {
		return {
			kind: "separator",
			id: item.identifier,
			label: item.text ?? "",
			...(itemIcon ? { icon: itemIcon } : {}),
		};
	}
	if (item.kind === "category") {
		return {
			kind: "category",
			id: item.identifier,
			label: item.text ?? item.accessibleLabel ?? "",
			...(itemIcon ? { icon: itemIcon } : {}),
			...(item.tooltip ? { description: item.tooltip } : {}),
			initiallyExpanded: item.initiallyExpanded,
			children: item.children.map((child) => sidebarItem(child, path)),
		};
	}
	const link = item.link;
	const linkIcon = icon(item.iconIdentifier ?? link?.iconIdentifier);
	const description = item.tooltip ?? link?.tooltip;
	return {
		kind: "link",
		id: item.identifier,
		label: item.text ?? link?.title ?? item.accessibleLabel ?? "",
		href: link?.mode === "route" ? link.target : `#${link?.target ?? "unavailable"}`,
		...(linkIcon ? { icon: linkIcon } : {}),
		...(description ? { description } : {}),
		active: link?.mode === "route" && link.target === path,
		children: item.children.map((child) => sidebarItem(child, path)),
	};
}

function icon(identifier: string | undefined): IconName | undefined {
	return identifier &&
		[
			"account",
			"administration",
			"alert",
			"brand",
			"chevron",
			"logout",
			"menu",
			"settings",
		].includes(identifier)
		? (identifier as IconName)
		: undefined;
}
