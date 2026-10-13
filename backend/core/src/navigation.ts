import { CoreError } from "./errors.js";
import type { LocalizationContext, LocalizationEngine } from "./localization.js";

export type NavigationPosition = "action" | "brand" | "primary";

export type VisibilityCondition =
	| { readonly kind: "authenticated"; readonly expected: boolean }
	| { readonly kind: "capability" | "permission" | "role"; readonly identifier: string }
	| { readonly kind: "date-window"; readonly startsAt?: string; readonly endsAt?: string }
	| { readonly kind: "event" | "feature"; readonly identifier: string; readonly active: boolean };

export interface NavigationLinkDefinition {
	readonly identifier: string;
	readonly contributionKey: string;
	readonly mode: "action" | "route" | (string & {});
	readonly target: string;
	readonly routeParameters?: Readonly<Record<string, string | number>>;
	readonly titleTextIdentifier: string;
	readonly tooltipTextIdentifier?: string;
	readonly iconIdentifier?: string;
	readonly requiredCapabilities: readonly string[];
}

export interface MainNavigationItemDefinition {
	readonly identifier: string;
	readonly contributionKey: string;
	readonly position: NavigationPosition;
	readonly linkIdentifier: string;
	readonly subtitleTextIdentifier?: string;
	readonly sidebarIdentifier?: string;
	readonly colorToken?: string;
	readonly conditions: readonly VisibilityCondition[];
	readonly enabled: boolean;
	readonly removable: boolean;
	readonly editableProperties: readonly string[];
	readonly order: number;
}

export interface SidebarDefinition {
	readonly identifier: string;
	readonly contributionKey: string;
	readonly titleTextIdentifier?: string;
	readonly subtitleTextIdentifier?: string;
	readonly iconIdentifier?: string;
	readonly allowsExtensions: boolean;
	readonly enabled: boolean;
	readonly removable: boolean;
}

export interface SidebarItemDefinition {
	readonly identifier: string;
	readonly sidebarIdentifier: string;
	readonly contributionKey: string;
	readonly kind: "category" | "link" | "separator";
	readonly parentIdentifier?: string;
	readonly sectionSeparatorIdentifier?: string;
	readonly linkIdentifier?: string;
	readonly textIdentifier?: string;
	readonly accessibleLabelTextIdentifier?: string;
	readonly tooltipTextIdentifier?: string;
	readonly iconIdentifier?: string;
	readonly initiallyExpanded: boolean;
	readonly allowsChildren: boolean;
	readonly enabled: boolean;
	readonly removable: boolean;
	readonly requiredCapabilities: readonly string[];
	readonly order: number;
}

export interface NavigationAudience {
	readonly authenticated: boolean;
	readonly capabilities: ReadonlySet<string>;
	readonly permissions: ReadonlySet<string>;
	readonly roles: ReadonlySet<string>;
	readonly features: ReadonlySet<string>;
	readonly events: ReadonlySet<string>;
	readonly now: Date;
}

export interface ResolvedNavigationLink {
	readonly identifier: string;
	readonly position: NavigationPosition;
	readonly title: string;
	readonly subtitle?: string;
	readonly tooltip?: string;
	readonly iconIdentifier?: string;
	readonly mode: string;
	readonly target: string;
	readonly routeParameters?: Readonly<Record<string, string | number>>;
	readonly sidebarIdentifier?: string;
	readonly colorToken?: string;
	readonly order: number;
}

export type ResolvedSidebarItem =
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
			readonly link?: Omit<ResolvedNavigationLink, "position" | "sidebarIdentifier">;
			readonly children: readonly ResolvedSidebarItem[];
			readonly order: number;
	  };

export interface ResolvedSidebar {
	readonly identifier: string;
	readonly title?: string;
	readonly subtitle?: string;
	readonly iconIdentifier?: string;
	readonly items: readonly ResolvedSidebarItem[];
}

export interface ResolvedNavigationCatalog {
	readonly revision: string;
	readonly locale: string;
	readonly brand: ResolvedNavigationLink;
	readonly primary: readonly ResolvedNavigationLink[];
	readonly actions: readonly ResolvedNavigationLink[];
	readonly sidebars: readonly ResolvedSidebar[];
}

export class NavigationEngine {
	private readonly links = new Map<string, NavigationLinkDefinition>();
	private readonly items = new Map<string, MainNavigationItemDefinition>();
	private readonly sidebars = new Map<string, SidebarDefinition>();
	private readonly sidebarItems = new Map<string, SidebarItemDefinition>();
	private revision = 0;

	constructor(private readonly localization: LocalizationEngine) {}

	registerLink(definition: NavigationLinkDefinition): void {
		validateIdentifier(definition.identifier);
		if (
			definition.mode === "route" &&
			!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(definition.target)
		) {
			invalid("Une navigation interne doit référencer un identifiant de route stable.");
		}
		this.links.set(definition.identifier, Object.freeze({ ...definition }));
		this.revision += 1;
	}

	registerItem(definition: MainNavigationItemDefinition): void {
		validateIdentifier(definition.identifier);
		const link = this.links.get(definition.linkIdentifier);
		if (!link) invalid(`Le lien ${definition.linkIdentifier} est inconnu.`);
		if (definition.sidebarIdentifier && !this.sidebars.has(definition.sidebarIdentifier)) {
			invalid(`La sidebar ${definition.sidebarIdentifier} est inconnue.`);
		}
		if (definition.position === "brand") {
			if (
				link.requiredCapabilities.length > 0 ||
				definition.conditions.some(
					(condition) => condition.kind !== "authenticated" || condition.expected,
				)
			) {
				invalid("Le lien brand doit rester accessible aux personnes non connectées.");
			}
			const existing = [...this.items.values()].find(
				(item) =>
					item.position === "brand" && item.enabled && item.identifier !== definition.identifier,
			);
			if (existing) invalid("Un seul lien brand actif est autorisé.");
		}
		this.items.set(definition.identifier, Object.freeze({ ...definition }));
		this.assertActiveBrand();
		this.revision += 1;
	}

	registerSidebar(definition: SidebarDefinition): void {
		validateIdentifier(definition.identifier);
		this.sidebars.set(definition.identifier, Object.freeze({ ...definition }));
		this.revision += 1;
	}

	registerSidebarItem(definition: SidebarItemDefinition): void {
		validateIdentifier(definition.identifier);
		const sidebar = this.sidebars.get(definition.sidebarIdentifier);
		if (!sidebar) invalid(`La sidebar ${definition.sidebarIdentifier} est inconnue.`);
		if (definition.contributionKey !== sidebar.contributionKey && !sidebar.allowsExtensions) {
			invalid(`La sidebar ${definition.sidebarIdentifier} interdit les extensions.`);
		}
		if (!definition.textIdentifier && !definition.iconIdentifier) {
			invalid("Un élément de sidebar doit avoir un texte ou une icône.");
		}
		if (!definition.textIdentifier && !definition.accessibleLabelTextIdentifier) {
			invalid("Une icône seule exige un libellé accessible.");
		}
		if (
			definition.kind === "category" &&
			(definition.parentIdentifier || definition.linkIdentifier)
		) {
			invalid("Une catégorie doit être à la racine et ne possède aucune destination.");
		}
		if (definition.kind === "link" && !definition.linkIdentifier) {
			invalid("Un lien de sidebar exige un lien du catalogue.");
		}
		if (
			definition.kind === "separator" &&
			(definition.parentIdentifier || definition.linkIdentifier)
		) {
			invalid("Un séparateur ne possède ni parent ni destination.");
		}
		if (definition.parentIdentifier) {
			const parent = this.sidebarItems.get(definition.parentIdentifier);
			if (!parent || parent.sidebarIdentifier !== definition.sidebarIdentifier) {
				invalid("Le parent de sidebar est inconnu ou appartient à une autre sidebar.");
			}
			if (parent.kind === "separator" || parent.parentIdentifier || !parent.allowsChildren) {
				invalid("Ce parent ne peut pas recevoir de sous-liens.");
			}
			if (definition.kind !== "link") invalid("Seul un lien peut être un sous-item.");
			if (definition.sectionSeparatorIdentifier)
				invalid("Un sous-lien hérite de la section du parent.");
		}
		if (definition.sectionSeparatorIdentifier) {
			const separator = this.sidebarItems.get(definition.sectionSeparatorIdentifier);
			if (!separator || separator.kind !== "separator")
				invalid("La section référencée est invalide.");
		}
		this.sidebarItems.set(definition.identifier, Object.freeze({ ...definition }));
		this.revision += 1;
	}

	setItemEnabled(identifier: string, enabled: boolean): void {
		const item = this.items.get(identifier);
		if (!item) invalid(`L’élément ${identifier} est inconnu.`);
		if (item.position === "brand" && !enabled)
			invalid("Le lien brand actif ne peut pas être désactivé.");
		if ((identifier === "core.profile" || identifier === "core.logout") && enabled) {
			if (!this.items.get("core.login")?.enabled) {
				invalid("Le profil et la déconnexion nécessitent l’action de connexion active.");
			}
		}
		this.items.set(identifier, Object.freeze({ ...item, enabled }));
		if (identifier === "core.login" && !enabled) {
			for (const dependent of ["core.profile", "core.logout"]) {
				const definition = this.items.get(dependent);
				if (definition) this.items.set(dependent, Object.freeze({ ...definition, enabled: false }));
			}
		}
		this.assertActiveBrand();
		this.revision += 1;
	}

	setItemOrder(identifier: string, order: number): void {
		const item = this.items.get(identifier);
		if (!item) invalid(`L’élément ${identifier} est inconnu.`);
		if (!Number.isSafeInteger(order)) invalid("L’ordre doit être un entier.");
		this.items.set(identifier, Object.freeze({ ...item, order }));
		this.revision += 1;
	}

	resolve(
		audience: NavigationAudience,
		localization: LocalizationContext,
	): ResolvedNavigationCatalog {
		const resolved = [...this.items.values()]
			.filter((item) => {
				const link = this.links.get(item.linkIdentifier);
				return (
					item.enabled &&
					Boolean(link) &&
					link!.requiredCapabilities.every((capability) => audience.capabilities.has(capability)) &&
					item.conditions.every((condition) => visible(condition, audience))
				);
			})
			.map((item) => this.resolveNavigationItem(item, localization))
			.sort(
				(left, right) =>
					left.order - right.order || left.identifier.localeCompare(right.identifier),
			);
		const brand = resolved.find((item) => item.position === "brand");
		if (!brand) invalid("Aucun lien brand n’est disponible pour cette audience.");
		const visibleSidebarIdentifiers = new Set(
			resolved
				.map((item) => item.sidebarIdentifier)
				.filter((identifier): identifier is string => Boolean(identifier)),
		);
		const sidebars = [...this.sidebars.values()]
			.filter((sidebar) => sidebar.enabled && visibleSidebarIdentifiers.has(sidebar.identifier))
			.map((sidebar) => this.resolveSidebar(sidebar, audience, localization))
			.filter((sidebar) => sidebar.items.length > 0);
		const brandItem = this.items.get(brand.identifier)!;
		const brandLink = this.links.get(brandItem.linkIdentifier)!;
		return {
			revision: String(this.revision),
			locale: this.localization.resolve(brandLink.titleTextIdentifier, localization).locale,
			brand,
			primary: resolved.filter((item) => item.position === "primary"),
			actions: resolved.filter((item) => item.position === "action"),
			sidebars,
		};
	}

	private resolveNavigationItem(
		item: MainNavigationItemDefinition,
		localization: LocalizationContext,
	): ResolvedNavigationLink {
		const link = this.links.get(item.linkIdentifier)!;
		return {
			identifier: item.identifier,
			position: item.position,
			title: this.localization.resolve(link.titleTextIdentifier, localization).value,
			...(item.subtitleTextIdentifier
				? { subtitle: this.localization.resolve(item.subtitleTextIdentifier, localization).value }
				: {}),
			...(link.tooltipTextIdentifier
				? { tooltip: this.localization.resolve(link.tooltipTextIdentifier, localization).value }
				: {}),
			...(link.iconIdentifier ? { iconIdentifier: link.iconIdentifier } : {}),
			mode: link.mode,
			target: link.target,
			...(link.routeParameters ? { routeParameters: link.routeParameters } : {}),
			...(item.sidebarIdentifier ? { sidebarIdentifier: item.sidebarIdentifier } : {}),
			...(item.colorToken ? { colorToken: item.colorToken } : {}),
			order: item.order,
		};
	}

	private resolveSidebar(
		sidebar: SidebarDefinition,
		audience: NavigationAudience,
		localization: LocalizationContext,
	): ResolvedSidebar {
		const definitions = [...this.sidebarItems.values()].filter(
			(item) =>
				item.sidebarIdentifier === sidebar.identifier &&
				item.enabled &&
				item.requiredCapabilities.every((capability) => audience.capabilities.has(capability)),
		);
		const roots = definitions.filter((item) => !item.parentIdentifier);
		const resolvedRoots = roots
			.map((item) => this.resolveSidebarItem(item, definitions, localization))
			.filter(
				(item) => item.kind === "link" || item.kind === "separator" || item.children.length > 0,
			)
			.sort((left, right) => left.order - right.order);
		const populatedSeparators = new Set(
			roots
				.filter((item) => item.kind !== "separator")
				.filter((item) => resolvedRoots.some((resolved) => resolved.identifier === item.identifier))
				.map((item) => item.sectionSeparatorIdentifier)
				.filter((identifier): identifier is string => Boolean(identifier)),
		);
		return {
			identifier: sidebar.identifier,
			...(sidebar.titleTextIdentifier
				? { title: this.localization.resolve(sidebar.titleTextIdentifier, localization).value }
				: {}),
			...(sidebar.subtitleTextIdentifier
				? {
						subtitle: this.localization.resolve(sidebar.subtitleTextIdentifier, localization).value,
					}
				: {}),
			...(sidebar.iconIdentifier ? { iconIdentifier: sidebar.iconIdentifier } : {}),
			items: resolvedRoots.filter(
				(item) => item.kind !== "separator" || populatedSeparators.has(item.identifier),
			),
		};
	}

	private resolveSidebarItem(
		item: SidebarItemDefinition,
		definitions: readonly SidebarItemDefinition[],
		localization: LocalizationContext,
	): ResolvedSidebarItem {
		const common = {
			identifier: item.identifier,
			...(item.textIdentifier
				? { text: this.localization.resolve(item.textIdentifier, localization).value }
				: {}),
			...(item.iconIdentifier ? { iconIdentifier: item.iconIdentifier } : {}),
			order: item.order,
		};
		if (item.kind === "separator") return { ...common, kind: "separator" };
		const children = definitions
			.filter((candidate) => candidate.parentIdentifier === item.identifier)
			.map((candidate) => this.resolveSidebarItem(candidate, definitions, localization))
			.sort((left, right) => left.order - right.order);
		const link = item.linkIdentifier ? this.links.get(item.linkIdentifier) : undefined;
		return {
			...common,
			kind: item.kind,
			...(item.tooltipTextIdentifier
				? { tooltip: this.localization.resolve(item.tooltipTextIdentifier, localization).value }
				: {}),
			...(item.accessibleLabelTextIdentifier
				? {
						accessibleLabel: this.localization.resolve(
							item.accessibleLabelTextIdentifier,
							localization,
						).value,
					}
				: {}),
			initiallyExpanded: item.initiallyExpanded,
			...(link
				? {
						link: {
							identifier: link.identifier,
							title: this.localization.resolve(link.titleTextIdentifier, localization).value,
							...(link.tooltipTextIdentifier
								? {
										tooltip: this.localization.resolve(link.tooltipTextIdentifier, localization)
											.value,
									}
								: {}),
							...(link.iconIdentifier ? { iconIdentifier: link.iconIdentifier } : {}),
							mode: link.mode,
							target: link.target,
							...(link.routeParameters ? { routeParameters: link.routeParameters } : {}),
							order: item.order,
						},
					}
				: {}),
			children,
		};
	}

	private assertActiveBrand(): void {
		if (![...this.items.values()].some((item) => item.position === "brand" && item.enabled)) {
			invalid("La navigation doit toujours conserver un lien brand actif.");
		}
	}
}

function visible(condition: VisibilityCondition, audience: NavigationAudience): boolean {
	if (condition.kind === "authenticated") return audience.authenticated === condition.expected;
	if (condition.kind === "capability") return audience.capabilities.has(condition.identifier);
	if (condition.kind === "permission") return audience.permissions.has(condition.identifier);
	if (condition.kind === "role") return audience.roles.has(condition.identifier);
	if (condition.kind === "feature")
		return audience.features.has(condition.identifier) === condition.active;
	if (condition.kind === "event")
		return audience.events.has(condition.identifier) === condition.active;
	if (condition.kind === "date-window") {
		return (
			(!condition.startsAt || audience.now >= new Date(condition.startsAt)) &&
			(!condition.endsAt || audience.now < new Date(condition.endsAt))
		);
	}
	return false;
}

function validateIdentifier(identifier: string): void {
	if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(identifier)) {
		invalid(`L’identifiant ${identifier} est invalide.`);
	}
}

function invalid(message: string): never {
	throw new CoreError("configuration.invalid", message);
}
