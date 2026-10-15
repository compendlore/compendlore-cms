import { useEffect, useState } from "react";
import type { IconName } from "./icons.js";
import type { NavigationLinkView, SidebarElementView, SidebarView } from "./navigation.js";

export interface NavigationActionView {
	readonly id: string;
	readonly label: string;
	readonly icon?: IconName;
	readonly href?: string;
	readonly command?: string;
	readonly appearance?: string;
}

export interface NavigationProjectionView {
	readonly brand: { readonly label: string; readonly href: string };
	readonly primary: readonly NavigationLinkView[];
	readonly actions: readonly NavigationActionView[];
	readonly sidebar?: SidebarView;
}

export interface NavigationProjectionRequest {
	readonly path: string;
	readonly surface: "administration" | "site";
	readonly locale: string;
	readonly signal?: AbortSignal;
}

export class NavigationProjectionClient {
	constructor(private readonly endpoint = "/backend/api/site/v1/navigation") {}

	async load(request: NavigationProjectionRequest): Promise<NavigationProjectionView> {
		const url = new URL(this.endpoint, window.location.origin);
		url.searchParams.set("path", request.path);
		url.searchParams.set("surface", request.surface);
		const response = await fetch(url, {
			headers: { accept: "application/json", "accept-language": request.locale },
			credentials: "same-origin",
			...(request.signal ? { signal: request.signal } : {}),
		});
		if (!response.ok) throw new Error("The navigation projection is unavailable.");
		return parseNavigationProjection(await response.json());
	}
}

export function parseNavigationProjection(value: unknown): NavigationProjectionView {
	const projection = record(value, "navigation projection");
	const brand = navigationItem(projection.brand, "brand");
	if (brand.target.kind !== "route") throw invalid();
	const primary = array(projection.primary, "navigation primary items").map((item) => {
		const resolved = navigationItem(item, "primary");
		if (resolved.target.kind !== "route") throw invalid();
		return {
			id: resolved.identifier,
			label: resolved.label,
			href: resolved.target.value,
			...(resolved.icon ? { icon: resolved.icon } : {}),
			...(resolved.subtitle ? { description: resolved.subtitle } : {}),
			active: resolved.active,
		};
	});
	const actions = array(projection.actions, "navigation actions").map((item) => {
		const resolved = navigationItem(item, "action");
		return {
			id: resolved.identifier,
			label: resolved.label,
			...(resolved.icon ? { icon: resolved.icon } : {}),
			...(resolved.target.kind === "route"
				? { href: resolved.target.value }
				: { command: resolved.target.value }),
			...(resolved.appearance ? { appearance: resolved.appearance } : {}),
		};
	});
	return {
		brand: { label: brand.label, href: brand.target.value },
		primary,
		actions,
		...(projection.sidebar === undefined ? {} : { sidebar: sidebarView(projection.sidebar) }),
	};
}

export const emptyNavigationProjection: NavigationProjectionView = Object.freeze({
	brand: Object.freeze({ label: "Compendlore CMS", href: "/" }),
	primary: Object.freeze([]),
	actions: Object.freeze([]),
});

const navigationProjectionClient = new NavigationProjectionClient();

export function useNavigationProjection(
	request: Omit<NavigationProjectionRequest, "signal">,
	fallback: NavigationProjectionView = emptyNavigationProjection,
	enabled = true,
): NavigationProjectionView {
	const [projection, setProjection] = useState(fallback);
	useEffect(() => {
		if (!enabled) {
			setProjection(fallback);
			return;
		}
		const controller = new AbortController();
		void navigationProjectionClient
			.load({ ...request, signal: controller.signal })
			.then(setProjection)
			.catch((error: unknown) => {
				if (!(error instanceof DOMException && error.name === "AbortError"))
					setProjection(fallback);
			});
		return () => controller.abort();
	}, [request.locale, request.path, request.surface, fallback, enabled]);
	return projection;
}

function sidebarView(value: unknown): SidebarView {
	const sidebar = record(value, "navigation sidebar");
	return {
		id: text(sidebar.identifier),
		title: optionalText(sidebar.title) ?? "Navigation",
		...(optionalText(sidebar.subtitle) ? { subtitle: text(sidebar.subtitle) } : {}),
		...(optionalIcon(sidebar.icon) ? { icon: icon(sidebar.icon) } : {}),
		items: array(sidebar.items, "sidebar items").map(sidebarItem),
	};
}

function sidebarItem(value: unknown): SidebarElementView {
	const item = record(value, "sidebar item");
	const kind = text(item.kind);
	const id = text(item.identifier);
	const label = text(item.label);
	if (kind === "separator") return { kind, id, label };
	const children = array(item.children, "sidebar children").map(sidebarItem);
	if (kind === "category") {
		return {
			kind,
			id,
			label,
			...(optionalIcon(item.icon) ? { icon: icon(item.icon) } : {}),
			initiallyExpanded: item.initiallyExpanded === true,
			children,
		};
	}
	if (kind !== "link") throw invalid();
	const target = targetValue(item.target);
	if (target.kind !== "route") throw invalid();
	return {
		kind,
		id,
		label,
		href: target.value,
		...(optionalIcon(item.icon) ? { icon: icon(item.icon) } : {}),
		active: item.active === true,
		children,
	};
}

function navigationItem(value: unknown, expectedType: "action" | "brand" | "primary") {
	const item = record(value, "navigation item");
	if (item.type !== expectedType) throw invalid();
	return {
		identifier: text(item.identifier),
		label: text(item.label),
		target: targetValue(item.target),
		active: item.active === true,
		icon: optionalIcon(item.icon) ? icon(item.icon) : undefined,
		subtitle: optionalText(item.subtitle),
		appearance: optionalText(item.appearance),
	};
}

function targetValue(value: unknown): {
	readonly kind: "action" | "route";
	readonly value: string;
} {
	const target = record(value, "navigation target");
	if (target.kind !== "action" && target.kind !== "route") throw invalid();
	const targetValue = text(target.value);
	if (target.kind === "route" && !targetValue.startsWith("/")) throw invalid();
	if (target.kind === "action" && !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(targetValue)) {
		throw invalid();
	}
	return { kind: target.kind, value: targetValue };
}

function record(value: unknown, _label: string): Record<string, unknown> {
	void _label;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	return value as Record<string, unknown>;
}

function array(value: unknown, _label: string): readonly unknown[] {
	void _label;
	if (!Array.isArray(value)) throw invalid();
	return value;
}

function text(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 500) throw invalid();
	return value;
}

function optionalText(value: unknown): string | undefined {
	return value === undefined ? undefined : text(value);
}

function optionalIcon(value: unknown): value is IconName {
	return (
		typeof value === "string" &&
		[
			"account",
			"administration",
			"brand",
			"calendar",
			"chevron",
			"close",
			"logout",
			"menu",
			"settings",
		].includes(value)
	);
}

function icon(value: unknown): IconName {
	if (!optionalIcon(value) || value === undefined) throw invalid();
	return value;
}

function invalid(): Error {
	return new Error("The navigation projection is invalid.");
}
