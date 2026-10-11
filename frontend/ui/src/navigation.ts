import type { IconName } from "./icons.js";

export interface MainNavigationLinkDefinition {
	readonly identifier: string;
	readonly label: string;
	readonly href: string;
	readonly icon?: IconName;
	readonly description?: string;
	readonly sidebarIdentifier?: string;
	readonly requiredCapability?: string;
	readonly visibility?: "hidden" | "visible";
	readonly systemRole?: "home";
}

export interface SidebarDefinition {
	readonly identifier: string;
	readonly eyebrow?: string;
	readonly title: string;
	readonly subtitle?: string;
	readonly icon?: IconName;
	readonly requiredCapability?: string;
}

interface SidebarElementBase {
	readonly identifier: string;
	readonly label: string;
	readonly icon?: IconName;
	readonly description?: string;
	readonly requiredCapability?: string;
	readonly parentIdentifier?: string;
	readonly order?: number;
}

export interface SidebarCategoryDefinition extends SidebarElementBase {
	readonly kind: "category";
	readonly initiallyExpanded?: boolean;
}

export interface SidebarLinkDefinition extends SidebarElementBase {
	readonly kind: "link";
	readonly href: string;
}

export type SidebarElementDefinition = SidebarCategoryDefinition | SidebarLinkDefinition;

export interface NavigationLinkView {
	readonly id: string;
	readonly label: string;
	readonly href: string;
	readonly icon?: IconName;
	readonly description?: string;
	readonly active: boolean;
}

export interface SidebarCategoryView {
	readonly kind: "category";
	readonly id: string;
	readonly label: string;
	readonly icon?: IconName;
	readonly description?: string;
	readonly initiallyExpanded: boolean;
	readonly children: readonly SidebarElementView[];
}

export interface SidebarLinkView extends NavigationLinkView {
	readonly kind: "link";
	readonly children: readonly SidebarElementView[];
}

export type SidebarElementView = SidebarCategoryView | SidebarLinkView;

export interface SidebarView {
	readonly id: string;
	readonly eyebrow?: string;
	readonly title: string;
	readonly subtitle?: string;
	readonly icon?: IconName;
	readonly items: readonly SidebarElementView[];
}

export interface ResolvedNavigation {
	readonly mainLinks: readonly NavigationLinkView[];
	readonly sidebar?: SidebarView | undefined;
}

export class MainNavigationRegistry {
	private readonly links = new Map<string, MainNavigationLinkDefinition>();

	register(link: MainNavigationLinkDefinition): void {
		validateIdentifier(link.identifier);
		validateHref(link.href);
		if (this.links.has(link.identifier)) throw new Error(`Le lien ${link.identifier} existe déjà.`);
		if (link.systemRole === "home") {
			if (link.href !== "/" || link.visibility !== "hidden")
				throw new Error("Le lien système d’accueil doit cibler / et rester masqué.");
			if ([...this.links.values()].some((candidate) => candidate.systemRole === "home"))
				throw new Error("Le lien système d’accueil existe déjà.");
		}
		this.links.set(link.identifier, Object.freeze({ ...link }));
	}

	list(capabilities: ReadonlySet<string>): readonly MainNavigationLinkDefinition[] {
		return [...this.links.values()].filter((link) =>
			hasCapability(capabilities, link.requiredCapability),
		);
	}
}

export class SidebarRegistry {
	private readonly sidebars = new Map<string, SidebarDefinition>();

	register(sidebar: SidebarDefinition): void {
		validateIdentifier(sidebar.identifier);
		if (this.sidebars.has(sidebar.identifier))
			throw new Error(`Le menu latéral ${sidebar.identifier} existe déjà.`);
		this.sidebars.set(sidebar.identifier, Object.freeze({ ...sidebar }));
	}

	resolve(identifier: string, capabilities: ReadonlySet<string>): SidebarDefinition | undefined {
		const sidebar = this.sidebars.get(identifier);
		return sidebar && hasCapability(capabilities, sidebar.requiredCapability) ? sidebar : undefined;
	}
}

export class SidebarElementRegistry {
	private readonly elements = new Map<string, Map<string, SidebarElementDefinition>>();

	register(sidebarIdentifier: string, element: SidebarElementDefinition): void {
		validateIdentifier(sidebarIdentifier);
		validateIdentifier(element.identifier);
		if (element.parentIdentifier) validateIdentifier(element.parentIdentifier);
		if (element.kind === "link") validateHref(element.href);
		const sidebarElements = this.elements.get(sidebarIdentifier) ?? new Map();
		if (sidebarElements.has(element.identifier))
			throw new Error(`L’élément ${element.identifier} existe déjà dans ce menu latéral.`);
		sidebarElements.set(element.identifier, Object.freeze({ ...element }));
		this.elements.set(sidebarIdentifier, sidebarElements);
	}

	list(sidebarIdentifier: string): readonly SidebarElementDefinition[] {
		return [...(this.elements.get(sidebarIdentifier)?.values() ?? [])];
	}
}

export class NavigationResolver {
	constructor(
		private readonly mainNavigation: MainNavigationRegistry,
		private readonly sidebars: SidebarRegistry,
		private readonly sidebarElements: SidebarElementRegistry,
	) {}

	resolve(path: string, capabilities: ReadonlySet<string>): ResolvedNavigation {
		const definitions = this.mainNavigation.list(capabilities);
		const active = definitions.find((link) => link.href === path);
		const sidebar = active?.sidebarIdentifier
			? this.resolveSidebar(active.sidebarIdentifier, path, capabilities)
			: undefined;
		return {
			mainLinks: definitions
				.filter((link) => link.visibility !== "hidden")
				.map((link) => navigationLinkView(link, path)),
			...(sidebar ? { sidebar } : {}),
		};
	}

	resolveSidebar(
		identifier: string,
		path: string,
		capabilities: ReadonlySet<string>,
	): SidebarView | undefined {
		const sidebar = this.sidebars.resolve(identifier, capabilities);
		if (!sidebar) return undefined;
		const definitions = this.sidebarElements
			.list(identifier)
			.filter((element) => hasCapability(capabilities, element.requiredCapability));
		return {
			id: sidebar.identifier,
			...(sidebar.eyebrow ? { eyebrow: sidebar.eyebrow } : {}),
			title: sidebar.title,
			...(sidebar.subtitle ? { subtitle: sidebar.subtitle } : {}),
			...(sidebar.icon ? { icon: sidebar.icon } : {}),
			items: buildSidebarTree(definitions, path),
		};
	}
}

function buildSidebarTree(
	definitions: readonly SidebarElementDefinition[],
	path: string,
	parentIdentifier?: string,
): readonly SidebarElementView[] {
	return definitions
		.filter((element) => element.parentIdentifier === parentIdentifier)
		.sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
		.map((element): SidebarElementView => {
			const children = buildSidebarTree(definitions, path, element.identifier);
			if (element.kind === "category") {
				return {
					kind: "category",
					id: element.identifier,
					label: element.label,
					...(element.icon ? { icon: element.icon } : {}),
					...(element.description ? { description: element.description } : {}),
					initiallyExpanded: element.initiallyExpanded ?? true,
					children,
				};
			}
			return {
				kind: "link",
				id: element.identifier,
				label: element.label,
				href: element.href,
				...(element.icon ? { icon: element.icon } : {}),
				...(element.description ? { description: element.description } : {}),
				active: element.href === path,
				children,
			};
		});
}

function navigationLinkView(link: MainNavigationLinkDefinition, path: string): NavigationLinkView {
	return {
		id: link.identifier,
		label: link.label,
		href: link.href,
		...(link.icon ? { icon: link.icon } : {}),
		...(link.description ? { description: link.description } : {}),
		active: link.href === path,
	};
}

function validateIdentifier(identifier: string): void {
	if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(identifier))
		throw new Error(`L’identifiant ${identifier} est invalide.`);
}

function validateHref(href: string): void {
	if (!href.startsWith("/"))
		throw new Error("Un lien de navigation doit utiliser un chemin absolu.");
}

function hasCapability(capabilities: ReadonlySet<string>, required?: string): boolean {
	return !required || capabilities.has("*") || capabilities.has(required);
}
