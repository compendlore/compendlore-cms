import { createHash } from "node:crypto";
import { CoreError } from "./errors.js";
import type { CoreJsonValue } from "./store.js";

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const MAXIMUM_VISIBILITY_DEPTH = 16;

export type NavigationItemType = "action" | "brand" | "primary";
export type NavigationPresentation = "icon" | "icon-text" | "text";

export type NavigationVisibilityExpression =
	| { readonly kind: "always" }
	| { readonly kind: "authenticated"; readonly value: boolean }
	| { readonly kind: "capability"; readonly identifier: string }
	| { readonly kind: "role"; readonly identifier: string }
	| { readonly kind: "feature"; readonly identifier: string }
	| { readonly kind: "event"; readonly identifier: string }
	| { readonly kind: "date-window"; readonly startsAt?: string; readonly endsAt?: string }
	| {
			readonly kind: "all" | "any";
			readonly expressions: readonly NavigationVisibilityExpression[];
	  }
	| { readonly kind: "not"; readonly expression: NavigationVisibilityExpression };

export interface NavigationParameterField {
	readonly type: "boolean" | "identifier" | "integer" | "path" | "string";
	readonly required: boolean;
	readonly allowedValues?: readonly CoreJsonValue[];
}

export type NavigationParameterSchema = Readonly<Record<string, NavigationParameterField>>;

export interface NavigationModeDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly version: string;
	readonly parameters: NavigationParameterSchema;
	readonly allowedItemTypes: readonly NavigationItemType[];
	readonly active: boolean;
}

export interface NavigationTargetTypeDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly version: string;
	readonly parameters: NavigationParameterSchema;
	readonly requiredCapability?: string;
	readonly active: boolean;
}

export interface NavigationActionDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly execution: "backend-method" | "frontend";
	readonly handlerIdentifier: string;
	readonly parameters: NavigationParameterSchema;
	readonly requiredCapability?: string;
	readonly active: boolean;
}

export interface NavigationTargetDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly mode: string;
	readonly targetType: string;
	readonly parameters: Readonly<Record<string, CoreJsonValue>>;
	readonly requiredCapability?: string;
	readonly audience: "administration" | "authenticated" | "public";
	readonly active: boolean;
}

export interface NavigationLinkDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly titleResource: string;
	readonly tooltipResource?: string;
	readonly target: string;
	readonly icon?: string;
	readonly visibility: NavigationVisibilityExpression;
	readonly requiredCapabilities: readonly string[];
	readonly active: boolean;
}

export interface NavigationLifecyclePolicy {
	readonly canDisable: boolean;
	readonly canArchive: boolean;
	readonly canDelete: boolean;
}

interface NavigationBarItemBase {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly version: string;
	readonly enabledByDefault: boolean;
	readonly target: string;
	readonly sidebar?: string;
	readonly tooltipResource?: string;
	readonly visibility: NavigationVisibilityExpression;
	readonly requiredCapabilities: readonly string[];
	readonly overrideFields: readonly string[];
	readonly lifecycle: NavigationLifecyclePolicy;
}

export type NavigationBarItemDefinition =
	| (NavigationBarItemBase & {
			readonly type: "brand";
			readonly accessibleLabelResource?: string;
	  })
	| (NavigationBarItemBase & {
			readonly type: "primary";
			readonly titleResource: string;
			readonly subtitleResource?: string;
			readonly icon?: string;
	  })
	| (NavigationBarItemBase & {
			readonly type: "action";
			readonly labelResource: string;
			readonly icon?: string;
			readonly presentation: NavigationPresentation;
			readonly appearance: string;
	  });

export interface SidebarDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly version: string;
	readonly titleResource?: string;
	readonly subtitleResource?: string;
	readonly icon?: string;
	readonly visibility: NavigationVisibilityExpression;
	readonly allowsExtensions: boolean;
	readonly overrideFields: readonly string[];
	readonly lifecycle: NavigationLifecyclePolicy;
	readonly enabledByDefault: boolean;
}

export interface SidebarItemDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly sidebar: string;
	readonly kind: "category" | "link" | "separator";
	readonly parent?: string;
	readonly section?: string;
	readonly link?: string;
	readonly textResource?: string;
	readonly accessibleLabelResource?: string;
	readonly tooltipResource?: string;
	readonly icon?: string;
	readonly visibility: NavigationVisibilityExpression;
	readonly requiredCapabilities: readonly string[];
	readonly initiallyExpanded?: boolean;
	readonly allowsChildren: boolean;
	readonly overrideFields: readonly string[];
	readonly lifecycle: NavigationLifecyclePolicy;
	readonly enabledByDefault: boolean;
}

export interface NavigationBundle {
	readonly sourceContributionKey: string;
	readonly modes?: readonly NavigationModeDefinition[];
	readonly targetTypes?: readonly NavigationTargetTypeDefinition[];
	readonly actions?: readonly NavigationActionDefinition[];
	readonly targets?: readonly NavigationTargetDefinition[];
	readonly links?: readonly NavigationLinkDefinition[];
	readonly sidebars?: readonly SidebarDefinition[];
	readonly sidebarItems?: readonly SidebarItemDefinition[];
	readonly navigationItems?: readonly NavigationBarItemDefinition[];
}

export interface NavigationItemState {
	readonly identifier: string;
	readonly enabled: boolean;
	readonly position?: number;
	readonly revision: number;
}

export interface NavigationSnapshot {
	readonly bundles: readonly NavigationBundle[];
	readonly navigationStates: readonly NavigationItemState[];
	readonly sidebarStates: readonly NavigationItemState[];
	readonly sidebarItemStates: readonly NavigationItemState[];
	readonly activeBrand: string;
}

export interface NavigationRepository {
	materialize(bundle: NavigationBundle): Promise<void>;
	snapshot(): Promise<NavigationSnapshot>;
	replaceStates(input: {
		readonly navigationStates?: readonly NavigationItemState[];
		readonly sidebarStates?: readonly NavigationItemState[];
		readonly sidebarItemStates?: readonly NavigationItemState[];
		readonly activeBrand?: string;
	}): Promise<void>;
	withdraw(sourceContributionKey: string): Promise<void>;
}

export interface NavigationMaterializationPort {
	materializeNavigation(bundle: NavigationBundle): Promise<void>;
}

export interface NavigationPrincipal {
	readonly authenticated: boolean;
	readonly capabilities: ReadonlySet<string>;
	readonly roles: ReadonlySet<string>;
	readonly multiFactorVerified: boolean;
	readonly activeFeatures?: ReadonlySet<string>;
	readonly activeEvents?: ReadonlySet<string>;
}

export interface NavigationResolutionContext {
	readonly path: string;
	readonly now: Date;
	readonly principal: NavigationPrincipal;
	readonly resolveText: (resourceIdentifier: string) => Promise<string>;
}

export interface ResolvedNavigationTarget {
	readonly kind: "action" | "route";
	readonly value: string;
}

export interface ResolvedNavigationItem {
	readonly identifier: string;
	readonly type: NavigationItemType;
	readonly label: string;
	readonly target: ResolvedNavigationTarget;
	readonly icon?: string;
	readonly subtitle?: string;
	readonly presentation?: NavigationPresentation;
	readonly appearance?: string;
	readonly active: boolean;
}

export type ResolvedSidebarItem =
	| {
			readonly identifier: string;
			readonly kind: "separator";
			readonly label: string;
	  }
	| {
			readonly identifier: string;
			readonly kind: "category";
			readonly label: string;
			readonly icon?: string;
			readonly initiallyExpanded: boolean;
			readonly children: readonly ResolvedSidebarItem[];
	  }
	| {
			readonly identifier: string;
			readonly kind: "link";
			readonly label: string;
			readonly icon?: string;
			readonly target: ResolvedNavigationTarget;
			readonly active: boolean;
			readonly children: readonly ResolvedSidebarItem[];
	  };

export interface ResolvedSidebar {
	readonly identifier: string;
	readonly title?: string;
	readonly subtitle?: string;
	readonly icon?: string;
	readonly items: readonly ResolvedSidebarItem[];
}

export interface ResolvedNavigation {
	readonly brand: ResolvedNavigationItem;
	readonly primary: readonly ResolvedNavigationItem[];
	readonly actions: readonly ResolvedNavigationItem[];
	readonly sidebar?: ResolvedSidebar;
}

export class NavigationService implements NavigationMaterializationPort {
	constructor(private readonly repository: NavigationRepository) {}

	async materializeNavigation(bundle: NavigationBundle): Promise<void> {
		validateBundle(bundle, await this.repository.snapshot());
		await this.repository.materialize(bundle);
	}

	async setEnabled(identifier: string, enabled: boolean, expectedRevision: number): Promise<void> {
		const snapshot = await this.repository.snapshot();
		const definitions = flatten(snapshot.bundles, "navigationItems");
		const definition = definitions.find((item) => item.identifier === identifier);
		if (!definition) throw invalid("The navigation item is unknown.");
		if (!definition.lifecycle.canDisable) throw denied("The navigation item cannot be disabled.");
		const states = snapshot.navigationStates.map((state) => {
			const linkedToLogin =
				identifier === "core.login" && ["core.profile", "core.logout"].includes(state.identifier);
			if (state.identifier !== identifier && !linkedToLogin) return state;
			if (state.identifier === identifier && state.revision !== expectedRevision) {
				throw conflict("The navigation item revision is stale.");
			}
			return {
				...state,
				enabled: linkedToLogin && !enabled ? false : enabled,
				revision: state.revision + 1,
			};
		});
		if (definition.type === "brand" && !enabled) {
			throw denied("The active brand cannot be disabled.");
		}
		await this.repository.replaceStates({ navigationStates: states });
	}

	async reorder(type: "action" | "primary", identifiers: readonly string[]): Promise<void> {
		const snapshot = await this.repository.snapshot();
		const definitions = flatten(snapshot.bundles, "navigationItems").filter(
			(item) => item.type === type,
		);
		const active = snapshot.navigationStates.filter(
			(state) => state.enabled && definitions.some((item) => item.identifier === state.identifier),
		);
		if (
			new Set(identifiers).size !== active.length ||
			identifiers.some((id) => !active.some((state) => state.identifier === id))
		) {
			throw invalid("The navigation order must contain every active item exactly once.");
		}
		const positions = new Map(identifiers.map((identifier, position) => [identifier, position]));
		await this.repository.replaceStates({
			navigationStates: snapshot.navigationStates.map((state) =>
				positions.has(state.identifier)
					? {
							...state,
							position: positions.get(state.identifier)!,
							revision: state.revision + 1,
						}
					: state,
			),
		});
	}

	async replaceBrand(identifier: string): Promise<void> {
		const snapshot = await this.repository.snapshot();
		const item = flatten(snapshot.bundles, "navigationItems").find(
			(candidate) => candidate.identifier === identifier && candidate.type === "brand",
		);
		if (!item) throw invalid("The brand navigation item is invalid.");
		const target = findTarget(snapshot.bundles, item.target);
		if (!isPublicBrand(item, target)) {
			throw denied("The brand target must remain public.");
		}
		await this.repository.replaceStates({ activeBrand: identifier });
	}

	async authorizeTarget(identifier: string, principal: NavigationPrincipal): Promise<boolean> {
		const target = findTarget((await this.repository.snapshot()).bundles, identifier);
		if (!target.active || !hasCapability(principal, target.requiredCapability)) return false;
		if (target.audience === "authenticated" && !principal.authenticated) return false;
		if (target.audience === "administration") {
			return (
				principal.authenticated &&
				principal.multiFactorVerified &&
				principal.capabilities.has("core.administration.access")
			);
		}
		return true;
	}

	async resolve(context: NavigationResolutionContext): Promise<ResolvedNavigation> {
		const snapshot = await this.repository.snapshot();
		const items = flatten(snapshot.bundles, "navigationItems");
		const states = new Map(snapshot.navigationStates.map((state) => [state.identifier, state]));
		const visible = items.filter((item) => {
			const state = states.get(item.identifier);
			return (
				state?.enabled === true &&
				item.requiredCapabilities.every((capability) =>
					hasCapability(context.principal, capability),
				) &&
				evaluateVisibility(item.visibility, context, 0)
			);
		});
		const brandDefinition = visible.find(
			(item) => item.type === "brand" && item.identifier === snapshot.activeBrand,
		);
		if (!brandDefinition) throw conflict("The navigation has no active brand.");
		const brand = await resolveNavigationItem(brandDefinition, snapshot.bundles, context);
		const primary = await resolveOrderedItems(
			"primary",
			visible,
			states,
			snapshot.bundles,
			context,
		);
		const actions = await resolveOrderedItems("action", visible, states, snapshot.bundles, context);
		const activeItem = [...primary, ...actions, brand].find((item) => item.active);
		const activeDefinition = activeItem
			? items.find((item) => item.identifier === activeItem.identifier)
			: undefined;
		const sidebar = activeDefinition?.sidebar
			? await this.resolveSidebar(activeDefinition.sidebar, context, snapshot)
			: undefined;
		return { brand, primary, actions, ...(sidebar ? { sidebar } : {}) };
	}

	async resolveSidebar(
		identifier: string,
		context: NavigationResolutionContext,
		providedSnapshot?: NavigationSnapshot,
	): Promise<ResolvedSidebar | undefined> {
		const snapshot = providedSnapshot ?? (await this.repository.snapshot());
		const sidebar = flatten(snapshot.bundles, "sidebars").find(
			(candidate) => candidate.identifier === identifier,
		);
		const sidebarState = snapshot.sidebarStates.find((state) => state.identifier === identifier);
		if (!sidebar || !sidebarState?.enabled || !evaluateVisibility(sidebar.visibility, context, 0)) {
			return undefined;
		}
		const allItems = flatten(snapshot.bundles, "sidebarItems").filter(
			(item) => item.sidebar === identifier,
		);
		const itemStates = new Map(
			snapshot.sidebarItemStates.map((state) => [state.identifier, state]),
		);
		const visible = allItems.filter(
			(item) =>
				itemStates.get(item.identifier)?.enabled === true &&
				item.requiredCapabilities.every((capability) =>
					hasCapability(context.principal, capability),
				) &&
				evaluateVisibility(item.visibility, context, 0),
		);
		const roots = await resolveSidebarLevel(
			undefined,
			visible,
			itemStates,
			snapshot.bundles,
			context,
		);
		const populatedSections = new Set(
			visible
				.filter((item) => item.kind !== "separator" && !item.parent)
				.map((item) => item.section),
		);
		return {
			identifier,
			...(sidebar.titleResource ? { title: await context.resolveText(sidebar.titleResource) } : {}),
			...(sidebar.subtitleResource
				? { subtitle: await context.resolveText(sidebar.subtitleResource) }
				: {}),
			...(sidebar.icon ? { icon: sidebar.icon } : {}),
			items: roots.filter(
				(item) => item.kind !== "separator" || populatedSections.has(item.identifier),
			),
		};
	}

	async withdraw(sourceContributionKey: string): Promise<void> {
		const snapshot = await this.repository.snapshot();
		if (sourceContributionKey === "module.site") {
			throw denied("The native navigation contribution cannot be withdrawn.");
		}
		const ownedItems = flatten(snapshot.bundles, "navigationItems").filter(
			(item) => item.ownerContributionKey === sourceContributionKey,
		);
		if (ownedItems.some((item) => item.identifier === snapshot.activeBrand)) {
			throw conflict("The active brand blocks contribution withdrawal.");
		}
		const ownedTargetIds = new Set(
			flatten(snapshot.bundles, "targets")
				.filter((target) => target.ownerContributionKey === sourceContributionKey)
				.map((target) => target.identifier),
		);
		const ownedLinkIds = new Set(
			flatten(snapshot.bundles, "links")
				.filter((link) => link.ownerContributionKey === sourceContributionKey)
				.map((link) => link.identifier),
		);
		const ownedSidebarIds = new Set(
			flatten(snapshot.bundles, "sidebars")
				.filter((sidebar) => sidebar.ownerContributionKey === sourceContributionKey)
				.map((sidebar) => sidebar.identifier),
		);
		const externalBundles = snapshot.bundles.filter(
			(bundle) => bundle.sourceContributionKey !== sourceContributionKey,
		);
		const hasExternalDependency =
			flatten(externalBundles, "links").some((link) => ownedTargetIds.has(link.target)) ||
			flatten(externalBundles, "navigationItems").some(
				(item) =>
					ownedTargetIds.has(item.target) || (item.sidebar && ownedSidebarIds.has(item.sidebar)),
			) ||
			flatten(externalBundles, "sidebarItems").some(
				(item) => ownedSidebarIds.has(item.sidebar) || (item.link && ownedLinkIds.has(item.link)),
			);
		if (hasExternalDependency) {
			throw conflict("Dependent navigation definitions block contribution withdrawal.");
		}
		await this.repository.withdraw(sourceContributionKey);
	}
}

export class InMemoryNavigationRepository implements NavigationRepository {
	private bundles: NavigationBundle[] = [];
	private navigationStates: NavigationItemState[] = [];
	private sidebarStates: NavigationItemState[] = [];
	private sidebarItemStates: NavigationItemState[] = [];
	private activeBrand = "core.home";

	async materialize(bundle: NavigationBundle): Promise<void> {
		const nextBundles = this.bundles.filter(
			(candidate) => candidate.sourceContributionKey !== bundle.sourceContributionKey,
		);
		nextBundles.push(clone(bundle));
		this.bundles = nextBundles;
		this.navigationStates = reconcileStates(
			this.navigationStates,
			flatten(this.bundles, "navigationItems"),
		);
		this.sidebarStates = reconcileStates(this.sidebarStates, flatten(this.bundles, "sidebars"));
		this.sidebarItemStates = reconcileStates(
			this.sidebarItemStates,
			flatten(this.bundles, "sidebarItems"),
		);
		if (
			!flatten(this.bundles, "navigationItems").some((item) => item.identifier === this.activeBrand)
		) {
			this.activeBrand = "core.home";
		}
	}

	async snapshot(): Promise<NavigationSnapshot> {
		return clone({
			bundles: this.bundles,
			navigationStates: this.navigationStates,
			sidebarStates: this.sidebarStates,
			sidebarItemStates: this.sidebarItemStates,
			activeBrand: this.activeBrand,
		});
	}

	async replaceStates(input: {
		readonly navigationStates?: readonly NavigationItemState[];
		readonly sidebarStates?: readonly NavigationItemState[];
		readonly sidebarItemStates?: readonly NavigationItemState[];
		readonly activeBrand?: string;
	}): Promise<void> {
		if (input.navigationStates) this.navigationStates = [...clone(input.navigationStates)];
		if (input.sidebarStates) this.sidebarStates = [...clone(input.sidebarStates)];
		if (input.sidebarItemStates) this.sidebarItemStates = [...clone(input.sidebarItemStates)];
		if (input.activeBrand) this.activeBrand = input.activeBrand;
	}

	async withdraw(sourceContributionKey: string): Promise<void> {
		this.bundles = this.bundles.filter(
			(bundle) => bundle.sourceContributionKey !== sourceContributionKey,
		);
		this.navigationStates = reconcileStates(
			this.navigationStates,
			flatten(this.bundles, "navigationItems"),
		);
		this.sidebarStates = reconcileStates(this.sidebarStates, flatten(this.bundles, "sidebars"));
		this.sidebarItemStates = reconcileStates(
			this.sidebarItemStates,
			flatten(this.bundles, "sidebarItems"),
		);
	}
}

export function nativeNavigationFoundation(): NavigationBundle {
	const ownerContributionKey = "module.site";
	const locked: NavigationLifecyclePolicy = {
		canDisable: true,
		canArchive: false,
		canDelete: false,
	};
	const always: NavigationVisibilityExpression = { kind: "always" };
	const authenticated: NavigationVisibilityExpression = { kind: "authenticated", value: true };
	const anonymous: NavigationVisibilityExpression = { kind: "authenticated", value: false };
	const navigationItems: NavigationBarItemDefinition[] = [
		{
			identifier: "core.home",
			ownerContributionKey,
			type: "brand",
			version: "1.0.0",
			enabledByDefault: true,
			target: "core.home",
			visibility: always,
			requiredCapabilities: [],
			overrideFields: [],
			lifecycle: { ...locked, canDisable: false },
			accessibleLabelResource: "module.site.navigation.home.accessible-label",
		},
		...[
			["core.login", "module.site.navigation.login", "icon-text", "secondary", anonymous],
			[
				"core.administration",
				"module.site.navigation.administration",
				"icon-text",
				"secondary",
				{ kind: "capability", identifier: "core.administration.access" },
			],
			["core.profile", "module.site.navigation.profile", "icon", "secondary", authenticated],
			["core.logout", "module.site.navigation.logout", "icon", "danger", authenticated],
		].map(([identifier, labelResource, presentation, appearance, visibility]) => ({
			identifier: identifier as string,
			ownerContributionKey,
			type: "action" as const,
			version: "1.0.0",
			enabledByDefault: true,
			target: identifier as string,
			...(identifier === "core.administration" ? { sidebar: "core.administration" } : {}),
			visibility: visibility as NavigationVisibilityExpression,
			requiredCapabilities:
				identifier === "core.administration" ? ["core.administration.access"] : [],
			overrideFields: ["enabled", "position"],
			lifecycle: locked,
			labelResource: labelResource as string,
			icon:
				identifier === "core.administration"
					? "administration"
					: identifier === "core.profile"
						? "account"
						: identifier === "core.logout"
							? "logout"
							: "account",
			presentation: presentation as NavigationPresentation,
			appearance: appearance as string,
		})),
	];
	return {
		sourceContributionKey: ownerContributionKey,
		modes: [
			{
				identifier: "navigation",
				ownerContributionKey,
				version: "1.0.0",
				parameters: {},
				allowedItemTypes: ["brand", "primary", "action"],
				active: true,
			},
			{
				identifier: "action",
				ownerContributionKey,
				version: "1.0.0",
				parameters: {},
				allowedItemTypes: ["action"],
				active: true,
			},
		],
		targetTypes: [
			{
				identifier: "route",
				ownerContributionKey,
				version: "1.0.0",
				parameters: { path: { type: "path", required: true } },
				active: true,
			},
			{
				identifier: "action",
				ownerContributionKey,
				version: "1.0.0",
				parameters: { action: { type: "identifier", required: true } },
				active: true,
			},
		],
		actions: [
			...(
				[
					["core.login", "frontend", "core.login"],
					["core.logout", "backend-method", "core.logout"],
				] as const
			).map(([identifier, execution, handlerIdentifier]) => ({
				identifier,
				ownerContributionKey,
				execution: execution as "backend-method" | "frontend",
				handlerIdentifier,
				parameters: {},
				active: true,
			})),
		],
		targets: [
			{
				identifier: "core.home",
				ownerContributionKey,
				mode: "navigation",
				targetType: "route",
				parameters: { path: "/" },
				audience: "public",
				active: true,
			},
			{
				identifier: "core.login",
				ownerContributionKey,
				mode: "action",
				targetType: "action",
				parameters: { action: "core.login" },
				audience: "public",
				active: true,
			},
			{
				identifier: "core.administration",
				ownerContributionKey,
				mode: "navigation",
				targetType: "route",
				parameters: { path: "/admin" },
				requiredCapability: "core.administration.access",
				audience: "administration",
				active: true,
			},
			{
				identifier: "core.profile",
				ownerContributionKey,
				mode: "navigation",
				targetType: "route",
				parameters: { path: "/account" },
				audience: "authenticated",
				active: true,
			},
			{
				identifier: "core.admin.modules",
				ownerContributionKey,
				mode: "navigation",
				targetType: "route",
				parameters: { path: "/admin/modules" },
				requiredCapability: "core.administration.access",
				audience: "administration",
				active: true,
			},
			{
				identifier: "core.admin.interface",
				ownerContributionKey,
				mode: "navigation",
				targetType: "route",
				parameters: { path: "/admin/interface" },
				requiredCapability: "core.administration.access",
				audience: "administration",
				active: true,
			},
			{
				identifier: "core.logout",
				ownerContributionKey,
				mode: "action",
				targetType: "action",
				parameters: { action: "core.logout" },
				audience: "authenticated",
				active: true,
			},
		],
		links: [
			...(
				[
					["core.admin.dashboard", "module.site.navigation.admin.dashboard", "core.administration"],
					["core.admin.modules", "module.site.navigation.admin.modules", "core.admin.modules"],
					[
						"core.admin.interface",
						"module.site.navigation.admin.interface",
						"core.admin.interface",
					],
				] as const
			).map(([identifier, titleResource, target]) => ({
				identifier,
				ownerContributionKey,
				titleResource,
				target,
				visibility: { kind: "capability", identifier: "core.administration.access" } as const,
				requiredCapabilities: ["core.administration.access"],
				active: true,
			})),
		],
		sidebars: [
			{
				identifier: "core.administration",
				ownerContributionKey,
				version: "1.0.0",
				titleResource: "module.site.navigation.admin.title",
				subtitleResource: "module.site.navigation.admin.subtitle",
				icon: "administration",
				visibility: { kind: "capability", identifier: "core.administration.access" },
				allowsExtensions: true,
				overrideFields: ["enabled"],
				lifecycle: locked,
				enabledByDefault: true,
			},
		],
		sidebarItems: [
			...[
				["core.administration.dashboard", "core.admin.dashboard", "administration", 0],
				["core.administration.modules", "core.admin.modules", "menu", 1],
				["core.administration.interface", "core.admin.interface", "settings", 2],
			].map(([identifier, link, icon], position) => ({
				identifier: identifier as string,
				ownerContributionKey,
				sidebar: "core.administration",
				kind: "link" as const,
				link: link as string,
				textResource: `module.site.navigation.admin.item-${position}`,
				icon: icon as string,
				visibility: { kind: "capability", identifier: "core.administration.access" } as const,
				requiredCapabilities: ["core.administration.access"],
				allowsChildren: true,
				overrideFields: ["enabled", "position"],
				lifecycle: locked,
				enabledByDefault: true,
			})),
		],
		navigationItems,
	};
}

function validateBundle(bundle: NavigationBundle, snapshot: NavigationSnapshot): void {
	assertIdentifier(bundle.sourceContributionKey, "navigation contribution");
	const bundles = [
		...snapshot.bundles.filter(
			(candidate) => candidate.sourceContributionKey !== bundle.sourceContributionKey,
		),
		bundle,
	];
	for (const key of [
		"modes",
		"targetTypes",
		"actions",
		"targets",
		"links",
		"sidebars",
		"sidebarItems",
		"navigationItems",
	] as const) {
		const identifiers = new Set<string>();
		for (const definition of flatten(bundles, key)) {
			assertIdentifier(definition.identifier, key);
			if (identifiers.has(definition.identifier)) throw conflict(`Duplicate ${key} identifier.`);
			identifiers.add(definition.identifier);
			if (
				definition.ownerContributionKey !== bundle.sourceContributionKey &&
				flatten([bundle], key).some((candidate) => candidate.identifier === definition.identifier)
			) {
				throw denied("A navigation contribution can only own its definitions.");
			}
		}
	}
	const modes = flatten(bundles, "modes");
	const targetTypes = flatten(bundles, "targetTypes");
	const actions = flatten(bundles, "actions");
	const targets = flatten(bundles, "targets");
	const links = flatten(bundles, "links");
	const sidebars = flatten(bundles, "sidebars");
	for (const mode of modes) validateCatalogDefinition(mode);
	for (const type of targetTypes) validateCatalogDefinition(type);
	for (const action of actions) {
		assertIdentifier(action.handlerIdentifier, "navigation action handler");
		validateParameterSchema(action.parameters);
	}
	for (const target of targets) {
		const mode = modes.find(
			(candidate) => candidate.identifier === target.mode && candidate.active,
		);
		const type = targetTypes.find(
			(candidate) => candidate.identifier === target.targetType && candidate.active,
		);
		if (!mode || !type) throw invalid("The navigation target references an inactive catalog.");
		validateParameters(target.parameters, { ...mode.parameters, ...type.parameters });
		if (target.targetType === "action") {
			const action = target.parameters.action;
			if (
				typeof action !== "string" ||
				!actions.some((candidate) => candidate.identifier === action && candidate.active)
			) {
				throw invalid("The navigation target references an unknown action.");
			}
		}
		if (target.targetType === "route") validatePath(target.parameters.path);
	}
	for (const link of links) {
		if (!targets.some((target) => target.identifier === link.target && target.active)) {
			throw invalid("The navigation link target is unavailable.");
		}
		validateVisibility(link.visibility, 0);
	}
	for (const sidebar of sidebars) {
		if (!SEMVER_PATTERN.test(sidebar.version)) throw invalid("The sidebar version is invalid.");
		validateVisibility(sidebar.visibility, 0);
	}
	const sidebarItems = flatten(bundles, "sidebarItems");
	validateSidebarHierarchy(sidebarItems, sidebars, links);
	const navigationItems = flatten(bundles, "navigationItems");
	for (const item of navigationItems) {
		if (!SEMVER_PATTERN.test(item.version)) throw invalid("The navigation version is invalid.");
		const target = targets.find(
			(candidate) => candidate.identifier === item.target && candidate.active,
		);
		const mode = target && modes.find((candidate) => candidate.identifier === target.mode);
		if (!target || !mode?.allowedItemTypes.includes(item.type)) {
			throw invalid("The navigation item target is incompatible.");
		}
		if (item.sidebar && !sidebars.some((sidebar) => sidebar.identifier === item.sidebar)) {
			throw invalid("The navigation item sidebar is unavailable.");
		}
		if (item.type === "brand" && !isPublicBrand(item, target)) {
			throw invalid("A brand must target a public route.");
		}
		if (item.type === "action") {
			if (item.presentation === "icon" && !item.icon)
				throw invalid("An icon action needs an icon.");
			if (target.targetType === "action" && item.sidebar) {
				throw invalid("An action target cannot open a sidebar.");
			}
		}
		validateVisibility(item.visibility, 0);
	}
	if (!navigationItems.some((item) => item.identifier === "core.home" && item.type === "brand")) {
		throw invalid("The system home brand is required.");
	}
	const brands = navigationItems.filter((item) => item.type === "brand");
	if (new Set(brands.map((item) => item.identifier)).size !== brands.length) {
		throw conflict("The brand identifiers must be unique.");
	}
}

function validateSidebarHierarchy(
	items: readonly SidebarItemDefinition[],
	sidebars: readonly SidebarDefinition[],
	links: readonly NavigationLinkDefinition[],
): void {
	const byIdentifier = new Map(items.map((item) => [item.identifier, item]));
	for (const item of items) {
		const sidebar = sidebars.find((candidate) => candidate.identifier === item.sidebar);
		if (!sidebar) {
			throw invalid("The sidebar item references an unknown sidebar.");
		}
		if (item.ownerContributionKey !== sidebar.ownerContributionKey && !sidebar.allowsExtensions) {
			throw denied("The sidebar does not accept external items.");
		}
		if (!item.textResource && !item.icon) throw invalid("A sidebar item needs text or an icon.");
		if (!item.textResource && !item.accessibleLabelResource) {
			throw invalid("An icon-only sidebar item needs an accessible label.");
		}
		if (
			item.kind === "link" &&
			(!item.link || !links.some((link) => link.identifier === item.link))
		) {
			throw invalid("A sidebar link needs a registered catalog link.");
		}
		if (item.kind !== "link" && item.link) throw invalid("Only sidebar links have a target.");
		if (item.kind === "category" && item.parent)
			throw invalid("A category must remain at the root.");
		if (
			item.kind === "separator" &&
			(item.parent || item.section || item.link || item.allowsChildren)
		) {
			throw invalid("A sidebar separator cannot have structural children or targets.");
		}
		if (item.parent) {
			const parent = byIdentifier.get(item.parent);
			if (
				!parent ||
				parent.sidebar !== item.sidebar ||
				parent.kind === "separator" ||
				!parent.allowsChildren
			) {
				throw invalid("The sidebar parent is invalid.");
			}
			if (item.kind !== "link" || parent.parent) {
				throw invalid("A sidebar supports exactly one nested link level.");
			}
			if (item.section) throw invalid("A nested sidebar link inherits its section.");
		}
		if (item.section) {
			const section = byIdentifier.get(item.section);
			if (!section || section.sidebar !== item.sidebar || section.kind !== "separator") {
				throw invalid("The sidebar section is invalid.");
			}
		}
		validateVisibility(item.visibility, 0);
	}
}

function validateCatalogDefinition(
	definition: NavigationModeDefinition | NavigationTargetTypeDefinition,
): void {
	if (!SEMVER_PATTERN.test(definition.version))
		throw invalid("The navigation catalog version is invalid.");
	validateParameterSchema(definition.parameters);
}

function validateParameterSchema(schema: NavigationParameterSchema): void {
	for (const [key, field] of Object.entries(schema)) {
		assertIdentifier(key, "navigation parameter");
		if (field.allowedValues?.length === 0) throw invalid("An allowed value list cannot be empty.");
	}
}

function validateParameters(
	parameters: Readonly<Record<string, CoreJsonValue>>,
	schema: NavigationParameterSchema,
): void {
	for (const key of Object.keys(parameters)) {
		if (!schema[key]) throw invalid("The navigation target contains an unknown parameter.");
	}
	for (const [key, field] of Object.entries(schema)) {
		const value = parameters[key];
		if (value === undefined) {
			if (field.required) throw invalid("A navigation target parameter is missing.");
			continue;
		}
		const valid =
			(field.type === "boolean" && typeof value === "boolean") ||
			(field.type === "integer" && Number.isInteger(value)) ||
			((field.type === "identifier" || field.type === "path" || field.type === "string") &&
				typeof value === "string");
		if (!valid) throw invalid("A navigation target parameter has an invalid type.");
		if (field.type === "identifier") assertIdentifier(String(value), "navigation parameter value");
		if (field.type === "path") validatePath(value);
		if (
			field.allowedValues &&
			!field.allowedValues.some((allowed) => stableJson(allowed) === stableJson(value))
		) {
			throw invalid("A navigation target parameter value is not allowed.");
		}
	}
}

function validateVisibility(expression: NavigationVisibilityExpression, depth: number): void {
	if (depth > MAXIMUM_VISIBILITY_DEPTH) throw invalid("The visibility expression is too deep.");
	if (expression.kind === "all" || expression.kind === "any") {
		if (expression.expressions.length === 0) throw invalid("A visibility group cannot be empty.");
		for (const child of expression.expressions) validateVisibility(child, depth + 1);
	} else if (expression.kind === "not") {
		validateVisibility(expression.expression, depth + 1);
	} else if (["capability", "role", "feature", "event"].includes(expression.kind)) {
		assertIdentifier(
			(expression as { readonly identifier: string }).identifier,
			"visibility predicate",
		);
	} else if (expression.kind === "date-window") {
		const start = expression.startsAt ? Date.parse(expression.startsAt) : undefined;
		const end = expression.endsAt ? Date.parse(expression.endsAt) : undefined;
		if (
			(start !== undefined && !Number.isFinite(start)) ||
			(end !== undefined && !Number.isFinite(end)) ||
			(start !== undefined && end !== undefined && start >= end)
		) {
			throw invalid("The navigation visibility window is invalid.");
		}
	}
}

function evaluateVisibility(
	expression: NavigationVisibilityExpression,
	context: NavigationResolutionContext,
	depth: number,
): boolean {
	if (depth > MAXIMUM_VISIBILITY_DEPTH) return false;
	switch (expression.kind) {
		case "always":
			return true;
		case "authenticated":
			return context.principal.authenticated === expression.value;
		case "capability":
			return hasCapability(context.principal, expression.identifier);
		case "role":
			return context.principal.roles.has(expression.identifier);
		case "feature":
			return context.principal.activeFeatures?.has(expression.identifier) ?? false;
		case "event":
			return context.principal.activeEvents?.has(expression.identifier) ?? false;
		case "date-window": {
			const timestamp = context.now.getTime();
			return (
				(!expression.startsAt || timestamp >= Date.parse(expression.startsAt)) &&
				(!expression.endsAt || timestamp < Date.parse(expression.endsAt))
			);
		}
		case "all":
			return expression.expressions.every((child) => evaluateVisibility(child, context, depth + 1));
		case "any":
			return expression.expressions.some((child) => evaluateVisibility(child, context, depth + 1));
		case "not":
			return !evaluateVisibility(expression.expression, context, depth + 1);
	}
}

async function resolveOrderedItems(
	type: "action" | "primary",
	items: readonly NavigationBarItemDefinition[],
	states: ReadonlyMap<string, NavigationItemState>,
	bundles: readonly NavigationBundle[],
	context: NavigationResolutionContext,
): Promise<readonly ResolvedNavigationItem[]> {
	const definitions = items
		.filter((item) => item.type === type)
		.sort((left, right) => {
			const position =
				(states.get(left.identifier)?.position ?? 0) -
				(states.get(right.identifier)?.position ?? 0);
			return position || left.identifier.localeCompare(right.identifier);
		});
	return Promise.all(definitions.map((item) => resolveNavigationItem(item, bundles, context)));
}

async function resolveNavigationItem(
	item: NavigationBarItemDefinition,
	bundles: readonly NavigationBundle[],
	context: NavigationResolutionContext,
): Promise<ResolvedNavigationItem> {
	const target = resolvedTarget(findTarget(bundles, item.target));
	const active = target.kind === "route" && target.value === context.path;
	if (item.type === "brand") {
		return {
			identifier: item.identifier,
			type: item.type,
			label: item.accessibleLabelResource
				? await context.resolveText(item.accessibleLabelResource)
				: "Compendlore CMS",
			target,
			active,
		};
	}
	if (item.type === "primary") {
		return {
			identifier: item.identifier,
			type: item.type,
			label: await context.resolveText(item.titleResource),
			...(item.subtitleResource
				? { subtitle: await context.resolveText(item.subtitleResource) }
				: {}),
			...(item.icon ? { icon: item.icon } : {}),
			target,
			active,
		};
	}
	return {
		identifier: item.identifier,
		type: item.type,
		label: await context.resolveText(item.labelResource),
		...(item.icon ? { icon: item.icon } : {}),
		presentation: item.presentation,
		appearance: item.appearance,
		target,
		active,
	};
}

async function resolveSidebarLevel(
	parent: string | undefined,
	items: readonly SidebarItemDefinition[],
	states: ReadonlyMap<string, NavigationItemState>,
	bundles: readonly NavigationBundle[],
	context: NavigationResolutionContext,
): Promise<readonly ResolvedSidebarItem[]> {
	const level = items
		.filter((item) => item.parent === parent)
		.sort((left, right) => {
			const position =
				(states.get(left.identifier)?.position ?? 0) -
				(states.get(right.identifier)?.position ?? 0);
			return position || left.identifier.localeCompare(right.identifier);
		});
	const resolved: ResolvedSidebarItem[] = [];
	for (const item of level) {
		const label = await context.resolveText(
			item.textResource ?? item.accessibleLabelResource ?? "",
		);
		if (item.kind === "separator") {
			resolved.push({ identifier: item.identifier, kind: "separator", label });
			continue;
		}
		const children = await resolveSidebarLevel(item.identifier, items, states, bundles, context);
		if (item.kind === "category") {
			if (children.length > 0) {
				resolved.push({
					identifier: item.identifier,
					kind: "category",
					label,
					...(item.icon ? { icon: item.icon } : {}),
					initiallyExpanded: item.initiallyExpanded ?? true,
					children,
				});
			}
			continue;
		}
		const link = flatten(bundles, "links").find((candidate) => candidate.identifier === item.link);
		if (!link) continue;
		const target = resolvedTarget(findTarget(bundles, link.target));
		resolved.push({
			identifier: item.identifier,
			kind: "link",
			label,
			...(item.icon ? { icon: item.icon } : {}),
			target,
			active: target.kind === "route" && target.value === context.path,
			children,
		});
	}
	return resolved;
}

function resolvedTarget(target: NavigationTargetDefinition): ResolvedNavigationTarget {
	if (target.targetType === "route")
		return { kind: "route", value: String(target.parameters.path) };
	return { kind: "action", value: String(target.parameters.action) };
}

function findTarget(
	bundles: readonly NavigationBundle[],
	identifier: string,
): NavigationTargetDefinition {
	const target = flatten(bundles, "targets").find(
		(candidate) => candidate.identifier === identifier,
	);
	if (!target) throw invalid("The navigation target is unknown.");
	return target;
}

function isPublicRoute(target: NavigationTargetDefinition): boolean {
	return (
		target.active &&
		target.audience === "public" &&
		target.targetType === "route" &&
		!target.requiredCapability
	);
}

function isPublicBrand(
	item: NavigationBarItemDefinition,
	target: NavigationTargetDefinition,
): boolean {
	return (
		item.type === "brand" &&
		isPublicRoute(target) &&
		item.requiredCapabilities.length === 0 &&
		item.visibility.kind === "always"
	);
}

function hasCapability(principal: NavigationPrincipal, capability?: string): boolean {
	return !capability || principal.capabilities.has("*") || principal.capabilities.has(capability);
}

function reconcileStates<
	T extends { readonly identifier: string; readonly enabledByDefault?: boolean },
>(states: readonly NavigationItemState[], definitions: readonly T[]): NavigationItemState[] {
	const existing = new Map(states.map((state) => [state.identifier, state]));
	let nextPosition =
		states.reduce((maximum, state) => Math.max(maximum, state.position ?? -1), -1) + 1;
	return definitions.map((definition) => {
		const current = existing.get(definition.identifier);
		if (current) return current;
		return {
			identifier: definition.identifier,
			enabled: definition.enabledByDefault ?? true,
			position: nextPosition++,
			revision: 1,
		};
	});
}

type NavigationBundleArrayKey = keyof Omit<NavigationBundle, "sourceContributionKey">;
type NavigationBundleItem<K extends NavigationBundleArrayKey> =
	NonNullable<NavigationBundle[K]> extends readonly (infer Item)[] ? Item : never;

function flatten<K extends NavigationBundleArrayKey>(
	bundles: readonly NavigationBundle[],
	key: K,
): readonly NavigationBundleItem<K>[] {
	const output: NavigationBundleItem<K>[] = [];
	for (const bundle of bundles) {
		const values = bundle[key] as readonly NavigationBundleItem<K>[] | undefined;
		if (values) output.push(...values);
	}
	return output;
}

function validatePath(value: CoreJsonValue | undefined): void {
	if (typeof value !== "string" || !/^\/(?!\/)[^\s?#]*(?:\?[^\s#]*)?(?:#[^\s]*)?$/.test(value)) {
		throw invalid("The navigation route is invalid.");
	}
}

function assertIdentifier(value: string, label: string): void {
	if (!IDENTIFIER_PATTERN.test(value) || value.length > 160)
		throw invalid(`The ${label} is invalid.`);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function navigationFingerprint(bundle: NavigationBundle): string {
	return createHash("sha256").update(stableJson(bundle)).digest("hex");
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function invalid(message: string): CoreError {
	return new CoreError("configuration.invalid", message);
}

function conflict(message: string): CoreError {
	return new CoreError("infrastructure.conflict", message);
}

function denied(message: string): CoreError {
	return new CoreError("authorization.denied", message);
}
