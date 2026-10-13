import type {
	EntityFieldDefinition,
	EntityInterfaceDefinition,
	EntityRelationDefinition,
	EntityTypeDefinition,
	LocalizedTextResourceDefinition,
	LocalizedTextValueDefinition,
	MainNavigationItemDefinition,
	NavigationLinkDefinition,
	PageDefinition,
	SidebarDefinition,
	SidebarItemDefinition,
} from "../../core/src/index.js";
import {
	EntityEngine,
	LocalizationEngine,
	NavigationEngine,
	PageCatalog,
	type NativeContentMaterialization,
	type NativeContentPersistence,
} from "../../core/src/index.js";
import type { ContributionOwner } from "./contracts.js";
import { RegistryError } from "./errors.js";
import { compareSemver } from "./validation.js";

export interface NativeLocalizedResourceDefinition {
	readonly identifier: string;
	readonly namespace: string;
	readonly format: "multiline" | "plain";
	readonly required?: boolean;
	readonly allowInstanceOverride?: boolean;
	readonly values: readonly { readonly locale: string; readonly value: string }[];
}

export type NativeEntityFieldDefinition = Omit<
	EntityFieldDefinition,
	"collection" | "configuration" | "immutable" | "localized" | "required"
> &
	Partial<Pick<EntityFieldDefinition, "collection" | "immutable" | "localized" | "required">> & {
		readonly configuration?: Readonly<Record<string, unknown>>;
	};

export type NativeEntityTypeDefinition = Omit<
	EntityTypeDefinition,
	"abstract" | "allowsExtensions" | "contributionKey" | "fields" | "required"
> & {
	readonly abstract?: boolean;
	readonly allowsExtensions?: boolean;
	readonly required?: boolean;
	readonly fields: readonly NativeEntityFieldDefinition[];
};

export type NativeEntityRelationDefinition = Omit<EntityRelationDefinition, "contributionKey">;
export type NativeEntityInterfaceDefinition = Omit<EntityInterfaceDefinition, "contributionKey">;
export type NativeNavigationLinkDefinition = Omit<
	NavigationLinkDefinition,
	"contributionKey" | "requiredCapabilities"
> & { readonly requiredCapabilities?: readonly string[] };
export type NativeNavigationItemDefinition = Omit<
	MainNavigationItemDefinition,
	"conditions" | "contributionKey" | "editableProperties" | "enabled" | "order" | "removable"
> &
	Partial<
		Pick<
			MainNavigationItemDefinition,
			"conditions" | "editableProperties" | "enabled" | "order" | "removable"
		>
	>;
export type NativeSidebarDefinition = Omit<
	SidebarDefinition,
	"allowsExtensions" | "contributionKey" | "enabled" | "removable"
> &
	Partial<Pick<SidebarDefinition, "allowsExtensions" | "enabled" | "removable">>;
export type NativeSidebarItemDefinition = Omit<
	SidebarItemDefinition,
	| "allowsChildren"
	| "contributionKey"
	| "enabled"
	| "initiallyExpanded"
	| "order"
	| "removable"
	| "requiredCapabilities"
> &
	Partial<
		Pick<
			SidebarItemDefinition,
			| "allowsChildren"
			| "enabled"
			| "initiallyExpanded"
			| "order"
			| "removable"
			| "requiredCapabilities"
		>
	>;
export type NativePageDefinition = Omit<
	PageDefinition,
	"contributionKey" | "editable" | "published" | "removable" | "requiredCapabilities"
> &
	Partial<Pick<PageDefinition, "editable" | "published" | "removable" | "requiredCapabilities">>;

export interface NativeContentContribution {
	readonly contributionKey: string;
	readonly owner: ContributionOwner;
	readonly version: string;
	readonly dependencies?: readonly string[];
	readonly localizedResources?: readonly NativeLocalizedResourceDefinition[];
	readonly entityTypes?: readonly NativeEntityTypeDefinition[];
	readonly entityRelations?: readonly NativeEntityRelationDefinition[];
	readonly entityInterfaces?: readonly NativeEntityInterfaceDefinition[];
	readonly navigationLinks?: readonly NativeNavigationLinkDefinition[];
	readonly navigationItems?: readonly NativeNavigationItemDefinition[];
	readonly sidebars?: readonly NativeSidebarDefinition[];
	readonly sidebarItems?: readonly NativeSidebarItemDefinition[];
	readonly pages?: readonly NativePageDefinition[];
}

export interface NativeContentInspection {
	readonly contributionKey: string;
	readonly owner: ContributionOwner;
	readonly version: string;
	readonly state: "active" | "disabled" | "withdrawn";
	readonly dependencies: readonly string[];
	readonly counts: Readonly<Record<string, number>>;
	readonly locked: boolean;
}

export class NativeContentRegistry {
	private readonly contributions = new Map<string, NativeContentContribution>();
	private readonly states = new Map<string, NativeContentInspection["state"]>();
	private localizationEngine = new LocalizationEngine();
	private entityEngine = new EntityEngine();
	private navigationEngine = new NavigationEngine(this.localizationEngine);
	private pageCatalog = new PageCatalog(this.localizationEngine);

	get localization(): LocalizationEngine {
		return this.localizationEngine;
	}

	get entities(): EntityEngine {
		return this.entityEngine;
	}

	get navigation(): NavigationEngine {
		return this.navigationEngine;
	}

	get pages(): PageCatalog {
		return this.pageCatalog;
	}

	register(definition: NativeContentContribution): NativeContentInspection {
		validateKey(definition.contributionKey);
		validateSemver(definition.version);
		const existing = this.contributions.get(definition.contributionKey);
		if (existing && !sameOwner(existing.owner, definition.owner)) {
			invalid(`La contribution ${definition.contributionKey} appartient à un autre propriétaire.`);
		}
		if (existing && compareSemver(definition.version, existing.version) < 0) {
			invalid("Une contribution native ne peut pas revenir à une version antérieure.");
		}
		this.applyMutation(() => {
			this.contributions.set(definition.contributionKey, structuredClone(definition));
			this.states.set(definition.contributionKey, "active");
		});
		return this.inspect(definition.contributionKey);
	}

	setState(
		contributionKey: string,
		state: Exclude<NativeContentInspection["state"], "withdrawn">,
	): NativeContentInspection {
		const definition = this.requireContribution(contributionKey);
		if (definition.owner.kind !== "addon" && state !== "active") {
			invalid("Une contribution native ou Core ne peut pas être désactivée.");
		}
		this.applyMutation(() => this.states.set(contributionKey, state));
		return this.inspect(contributionKey);
	}

	withdraw(contributionKey: string): NativeContentInspection {
		const definition = this.requireContribution(contributionKey);
		if (definition.owner.kind !== "addon") {
			invalid("Une contribution native ou Core ne peut pas être retirée.");
		}
		const dependent = [...this.contributions.values()].find(
			(candidate) =>
				this.states.get(candidate.contributionKey) === "active" &&
				candidate.dependencies?.includes(contributionKey),
		);
		if (dependent) {
			invalid(`La contribution ${dependent.contributionKey} dépend encore de ${contributionKey}.`);
		}
		this.applyMutation(() => this.states.set(contributionKey, "withdrawn"));
		return this.inspect(contributionKey);
	}

	async registerPersisted(
		definition: NativeContentContribution,
		persistence: NativeContentPersistence,
	): Promise<NativeContentInspection> {
		const inspection = this.register(definition);
		await persistence.replace(this.materializationFor(definition));
		return inspection;
	}

	inspect(contributionKey: string): NativeContentInspection {
		const definition = this.contributions.get(contributionKey);
		if (!definition) invalid(`La contribution ${contributionKey} est inconnue.`);
		return {
			contributionKey,
			owner: definition.owner,
			version: definition.version,
			state: this.states.get(contributionKey) ?? "active",
			dependencies: definition.dependencies ?? [],
			counts: {
				localizedResources: definition.localizedResources?.length ?? 0,
				entityTypes: definition.entityTypes?.length ?? 0,
				entityRelations: definition.entityRelations?.length ?? 0,
				entityInterfaces: definition.entityInterfaces?.length ?? 0,
				navigationLinks: definition.navigationLinks?.length ?? 0,
				navigationItems: definition.navigationItems?.length ?? 0,
				sidebars: definition.sidebars?.length ?? 0,
				sidebarItems: definition.sidebarItems?.length ?? 0,
				pages: definition.pages?.length ?? 0,
			},
			locked: definition.owner.kind === "core" || definition.owner.kind === "native-module",
		};
	}

	list(): readonly NativeContentInspection[] {
		return [...this.contributions.keys()].sort().map((key) => this.inspect(key));
	}

	private requireContribution(contributionKey: string): NativeContentContribution {
		const definition = this.contributions.get(contributionKey);
		if (!definition) invalid(`La contribution ${contributionKey} est inconnue.`);
		return definition;
	}

	private applyMutation(mutate: () => void): void {
		const previousContributions = new Map(this.contributions);
		const previousStates = new Map(this.states);
		try {
			mutate();
			this.rebuild();
		} catch (error) {
			this.contributions.clear();
			this.states.clear();
			for (const [key, contribution] of previousContributions) {
				this.contributions.set(key, contribution);
			}
			for (const [key, state] of previousStates) this.states.set(key, state);
			this.rebuild();
			throw error;
		}
	}

	private rebuild(): void {
		this.localizationEngine = new LocalizationEngine();
		this.entityEngine = new EntityEngine();
		this.navigationEngine = new NavigationEngine(this.localizationEngine);
		this.pageCatalog = new PageCatalog(this.localizationEngine);
		const active = [...this.contributions.values()]
			.filter((definition) => this.states.get(definition.contributionKey) === "active")
			.sort((first, second) => ownerOrder(first.owner) - ownerOrder(second.owner));
		for (const definition of active) {
			for (const dependency of definition.dependencies ?? []) {
				if (this.states.get(dependency) !== "active") {
					invalid(`La dépendance ${dependency} de ${definition.contributionKey} n’est pas active.`);
				}
			}
			this.materialize(definition);
		}
	}

	private materialize(definition: NativeContentContribution): void {
		for (const resource of definition.localizedResources ?? []) {
			const normalized: LocalizedTextResourceDefinition = {
				identifier: resource.identifier,
				contributionKey: definition.contributionKey,
				namespace: resource.namespace,
				format: resource.format,
				required: resource.required ?? true,
				allowInstanceOverride: resource.allowInstanceOverride ?? true,
			};
			this.localization.registerResource(normalized);
			for (const value of resource.values) {
				const normalizedValue: LocalizedTextValueDefinition = {
					resourceIdentifier: resource.identifier,
					locale: value.locale,
					sourceLayer: "owner",
					sourceContributionKey: definition.contributionKey,
					value: value.value,
					revision: 1,
				};
				this.localization.registerValue(normalizedValue);
			}
		}
		for (const type of definition.entityTypes ?? []) {
			this.entities.registerType({
				...type,
				contributionKey: definition.contributionKey,
				abstract: type.abstract ?? false,
				required: type.required ?? false,
				allowsExtensions: type.allowsExtensions ?? true,
				fields: type.fields.map((field) => ({
					...field,
					required: field.required ?? false,
					localized: field.localized ?? false,
					collection: field.collection ?? false,
					immutable: field.immutable ?? false,
					configuration: field.configuration ?? {},
				})),
			});
		}
		for (const relation of definition.entityRelations ?? []) {
			this.entities.registerRelation({ ...relation, contributionKey: definition.contributionKey });
		}
		for (const entityInterface of definition.entityInterfaces ?? []) {
			this.entities.registerInterface({
				...entityInterface,
				contributionKey: definition.contributionKey,
			});
		}
		for (const link of definition.navigationLinks ?? []) {
			this.navigation.registerLink({
				...link,
				contributionKey: definition.contributionKey,
				requiredCapabilities: link.requiredCapabilities ?? [],
			});
		}
		for (const sidebar of definition.sidebars ?? []) {
			this.navigation.registerSidebar({
				...sidebar,
				contributionKey: definition.contributionKey,
				allowsExtensions: sidebar.allowsExtensions ?? true,
				enabled: sidebar.enabled ?? true,
				removable: sidebar.removable ?? false,
			});
		}
		for (const item of definition.navigationItems ?? []) {
			this.navigation.registerItem({
				...item,
				contributionKey: definition.contributionKey,
				conditions: item.conditions ?? [],
				enabled: item.enabled ?? true,
				removable: item.removable ?? false,
				editableProperties: item.editableProperties ?? ["enabled", "order"],
				order: item.order ?? 0,
			});
		}
		for (const item of definition.sidebarItems ?? []) {
			this.navigation.registerSidebarItem({
				...item,
				contributionKey: definition.contributionKey,
				initiallyExpanded: item.initiallyExpanded ?? true,
				allowsChildren: item.allowsChildren ?? true,
				enabled: item.enabled ?? true,
				removable: item.removable ?? false,
				requiredCapabilities: item.requiredCapabilities ?? [],
				order: item.order ?? 0,
			});
		}
		for (const page of definition.pages ?? []) {
			this.pages.register({
				...page,
				contributionKey: definition.contributionKey,
				requiredCapabilities: page.requiredCapabilities ?? [],
				editable: page.editable ?? false,
				removable: page.removable ?? false,
				published: page.published ?? true,
			});
		}
	}

	private materializationFor(definition: NativeContentContribution): NativeContentMaterialization {
		return {
			contributionKey: definition.contributionKey,
			ownerKind: definition.owner.kind,
			ownerIdentifier: definition.owner.identifier,
			version: definition.version,
			dependencies: definition.dependencies ?? [],
			localizedResources: (definition.localizedResources ?? []).map((resource) => ({
				identifier: resource.identifier,
				contributionKey: definition.contributionKey,
				namespace: resource.namespace,
				format: resource.format,
				required: resource.required ?? true,
				allowInstanceOverride: resource.allowInstanceOverride ?? true,
			})),
			localizedValues: (definition.localizedResources ?? []).flatMap((resource) =>
				resource.values.map((value) => ({
					resourceIdentifier: resource.identifier,
					locale: value.locale,
					sourceLayer: "owner" as const,
					sourceContributionKey: definition.contributionKey,
					value: value.value,
					revision: 1,
				})),
			),
			entityTypes: (definition.entityTypes ?? []).map((type) => ({
				...type,
				contributionKey: definition.contributionKey,
				abstract: type.abstract ?? false,
				required: type.required ?? false,
				allowsExtensions: type.allowsExtensions ?? true,
				fields: type.fields.map((field) => ({
					...field,
					required: field.required ?? false,
					localized: field.localized ?? false,
					collection: field.collection ?? false,
					immutable: field.immutable ?? false,
					configuration: field.configuration ?? {},
				})),
			})),
			entityRelations: (definition.entityRelations ?? []).map((relation) => ({
				...relation,
				contributionKey: definition.contributionKey,
			})),
			entityInterfaces: (definition.entityInterfaces ?? []).map((entityInterface) => ({
				...entityInterface,
				contributionKey: definition.contributionKey,
			})),
			navigationLinks: (definition.navigationLinks ?? []).map((link) => ({
				...link,
				contributionKey: definition.contributionKey,
				requiredCapabilities: link.requiredCapabilities ?? [],
			})),
			navigationItems: (definition.navigationItems ?? []).map((item) => ({
				...item,
				contributionKey: definition.contributionKey,
				conditions: item.conditions ?? [],
				enabled: item.enabled ?? true,
				removable: item.removable ?? false,
				editableProperties: item.editableProperties ?? ["enabled", "order"],
				order: item.order ?? 0,
			})),
			sidebars: (definition.sidebars ?? []).map((sidebar) => ({
				...sidebar,
				contributionKey: definition.contributionKey,
				allowsExtensions: sidebar.allowsExtensions ?? true,
				enabled: sidebar.enabled ?? true,
				removable: sidebar.removable ?? false,
			})),
			sidebarItems: (definition.sidebarItems ?? []).map((item) => ({
				...item,
				contributionKey: definition.contributionKey,
				initiallyExpanded: item.initiallyExpanded ?? true,
				allowsChildren: item.allowsChildren ?? true,
				enabled: item.enabled ?? true,
				removable: item.removable ?? false,
				requiredCapabilities: item.requiredCapabilities ?? [],
				order: item.order ?? 0,
			})),
			pages: (definition.pages ?? []).map((page) => ({
				...page,
				contributionKey: definition.contributionKey,
				requiredCapabilities: page.requiredCapabilities ?? [],
				editable: page.editable ?? false,
				removable: page.removable ?? false,
				published: page.published ?? true,
			})),
		};
	}
}

function validateKey(value: string): void {
	if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value))
		invalid("La clé de contribution est invalide.");
}

function validateSemver(value: string): void {
	if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
		invalid("La version de contribution est invalide.");
	}
}

function sameOwner(first: ContributionOwner, second: ContributionOwner): boolean {
	return first.kind === second.kind && first.identifier === second.identifier;
}

function ownerOrder(owner: ContributionOwner): number {
	if (owner.kind === "core") return 0;
	if (owner.kind === "native-module") return 1;
	return 2;
}

function invalid(message: string): never {
	throw new RegistryError("registry.contract_invalid", message);
}
