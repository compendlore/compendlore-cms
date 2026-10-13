import { createHash } from "node:crypto";
import { sql, type CoreDatabase, type TransactionContext } from "./database-contracts.js";
import type {
	EntityInterfaceDefinition,
	EntityRelationDefinition,
	EntityTypeDefinition,
} from "./entities.js";
import type {
	LocalizedTextResourceDefinition,
	LocalizedTextValueDefinition,
} from "./localization.js";
import type {
	MainNavigationItemDefinition,
	NavigationLinkDefinition,
	SidebarDefinition,
	SidebarItemDefinition,
} from "./navigation.js";
import type {
	PageActionContractDefinition,
	PageComponentContractDefinition,
	PageContextTypeDefinition,
	PageDataProviderContractDefinition,
	PageDefinition,
	RouteParameterTypeDefinition,
} from "./pages.js";

export interface NativeContentMaterialization {
	readonly contributionKey: string;
	readonly ownerKind: "addon" | "core" | "instance" | "native-module";
	readonly ownerIdentifier: string;
	readonly version: string;
	readonly dependencies: readonly string[];
	readonly localizedResources: readonly LocalizedTextResourceDefinition[];
	readonly localizedValues: readonly LocalizedTextValueDefinition[];
	readonly entityTypes: readonly EntityTypeDefinition[];
	readonly entityRelations: readonly EntityRelationDefinition[];
	readonly entityInterfaces: readonly EntityInterfaceDefinition[];
	readonly navigationLinks: readonly NavigationLinkDefinition[];
	readonly navigationItems: readonly MainNavigationItemDefinition[];
	readonly sidebars: readonly SidebarDefinition[];
	readonly sidebarItems: readonly SidebarItemDefinition[];
	readonly routeParameterTypes: readonly RouteParameterTypeDefinition[];
	readonly pageComponentContracts: readonly PageComponentContractDefinition[];
	readonly pageDataProviderContracts: readonly PageDataProviderContractDefinition[];
	readonly pageActionContracts: readonly PageActionContractDefinition[];
	readonly pageContextTypes: readonly PageContextTypeDefinition[];
	readonly pages: readonly PageDefinition[];
}

export interface NativeContentPersistence {
	replace(materialization: NativeContentMaterialization): Promise<void>;
}

export class PostgresNativeContentPersistence implements NativeContentPersistence {
	constructor(private readonly database: CoreDatabase) {}

	async replace(materialization: NativeContentMaterialization): Promise<void> {
		const fingerprint = hash(materialization);
		await this.database.transaction(async (transaction) => {
			await this.persistContribution(transaction, materialization, fingerprint);
			await this.persistDependencies(transaction, materialization);
			await this.persistLocalization(transaction, materialization);
			await this.persistEntities(transaction, materialization);
			await this.persistNavigation(transaction, materialization);
			await this.persistPages(transaction, materialization);
		});
	}

	private async persistDependencies(
		transaction: TransactionContext,
		materialization: NativeContentMaterialization,
	): Promise<void> {
		await transaction.query(/* pgsql */ sql`
			DELETE FROM core.native_content_dependencies
			WHERE contribution_key = ${materialization.contributionKey}
		`);
		for (const dependency of materialization.dependencies) {
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.native_content_dependencies (
					contribution_key,
					required_contribution_key
				)
				VALUES (${materialization.contributionKey}, ${dependency})
			`);
		}
	}

	private async persistContribution(
		transaction: TransactionContext,
		materialization: NativeContentMaterialization,
		fingerprint: string,
	): Promise<void> {
		await transaction.query(/* pgsql */ sql`
			INSERT INTO core.native_content_contributions (
				contribution_key,
				owner_kind,
				owner_identifier,
				version,
				fingerprint,
				state
			)
			VALUES (
				${materialization.contributionKey},
				${materialization.ownerKind},
				${materialization.ownerIdentifier},
				${materialization.version},
				${fingerprint},
				'active'
			)
			ON CONFLICT (contribution_key) DO UPDATE
			SET
				owner_kind = EXCLUDED.owner_kind,
				owner_identifier = EXCLUDED.owner_identifier,
				version = EXCLUDED.version,
				fingerprint = EXCLUDED.fingerprint,
				state = 'active',
				last_error = NULL,
				updated_at = now()
		`);
	}

	private async persistLocalization(
		transaction: TransactionContext,
		materialization: NativeContentMaterialization,
	): Promise<void> {
		for (const resource of materialization.localizedResources) {
			const resourceKey = resource.identifier.split(".").at(-1) ?? resource.identifier;
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.localized_text_resources (
					identifier,
					contribution_key,
					namespace,
					resource_key,
					format,
					allow_instance_override,
					required
				)
				VALUES (
					${resource.identifier},
					${resource.contributionKey},
					${resource.namespace},
					${resourceKey},
					${resource.format},
					${resource.allowInstanceOverride},
					${resource.required}
				)
				ON CONFLICT (identifier) DO UPDATE
				SET
					format = EXCLUDED.format,
					allow_instance_override = EXCLUDED.allow_instance_override,
					required = EXCLUDED.required,
					updated_at = now()
			`);
		}
		for (const value of materialization.localizedValues) {
			await transaction.query(/* pgsql */ sql`
				UPDATE core.localized_text_values
				SET active = false
				WHERE resource_id = (
					SELECT id
					FROM core.localized_text_resources
					WHERE identifier = ${value.resourceIdentifier}
				)
				AND locale_tag = ${value.locale}
				AND source_layer = ${value.sourceLayer}
				AND source_contribution_key = ${value.sourceContributionKey}
			`);
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.localized_text_values (
					resource_id,
					locale_tag,
					source_layer,
					source_contribution_key,
					value,
					revision,
					active
				)
				SELECT
					id,
					${value.locale},
					${value.sourceLayer},
					${value.sourceContributionKey},
					${value.value},
					${value.revision},
					true
				FROM core.localized_text_resources
				WHERE identifier = ${value.resourceIdentifier}
				ON CONFLICT (
					resource_id,
					locale_tag,
					source_layer,
					source_contribution_key,
					revision
				) DO UPDATE
				SET
					value = EXCLUDED.value,
					active = true
			`);
		}
	}

	private async persistEntities(
		transaction: TransactionContext,
		materialization: NativeContentMaterialization,
	): Promise<void> {
		for (const type of materialization.entityTypes) {
			for (const field of type.fields) {
				await transaction.query(/* pgsql */ sql`
					INSERT INTO core.entity_field_types (
						identifier,
						contribution_key,
						version,
						configuration_schema
					)
					VALUES (${field.family}, 'core.entity-field-types', '1.0.0', '{}'::jsonb)
					ON CONFLICT (identifier) DO NOTHING
				`);
			}
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.entity_types (
					identifier,
					contribution_key,
					parent_id,
					name_text_id,
					description_text_id,
					is_abstract,
					is_required,
					allows_extensions
				)
				VALUES (
					${type.identifier},
					${type.contributionKey},
					(SELECT id FROM core.entity_types WHERE identifier = ${type.parentIdentifier ?? ""}),
					(SELECT id FROM core.localized_text_resources WHERE identifier = ${type.nameTextIdentifier}),
					(SELECT id FROM core.localized_text_resources WHERE identifier = ${type.descriptionTextIdentifier ?? ""}),
					${type.abstract},
					${type.required},
					${type.allowsExtensions}
				)
				ON CONFLICT (identifier) DO UPDATE
				SET
					is_abstract = EXCLUDED.is_abstract,
					is_required = EXCLUDED.is_required,
					allows_extensions = EXCLUDED.allows_extensions,
					active = true,
					updated_at = now()
			`);
			for (const field of type.fields) {
				await transaction.query(/* pgsql */ sql`
					INSERT INTO core.entity_fields (
						entity_type_id,
						contribution_key,
						identifier,
						field_type_identifier,
						label_text_id,
						description_text_id,
						is_required,
						is_localized,
						is_collection,
						is_immutable,
						configuration
					)
					VALUES (
						(SELECT id FROM core.entity_types WHERE identifier = ${type.identifier}),
						${type.contributionKey},
						${field.identifier},
						${field.family},
						(SELECT id FROM core.localized_text_resources WHERE identifier = ${field.labelTextIdentifier}),
						(SELECT id FROM core.localized_text_resources WHERE identifier = ${field.descriptionTextIdentifier ?? ""}),
						${field.required},
						${field.localized},
						${field.collection},
						${field.immutable},
						${JSON.stringify(field.configuration)}::jsonb
					)
					ON CONFLICT (entity_type_id, identifier) DO UPDATE
					SET
						field_type_identifier = EXCLUDED.field_type_identifier,
						is_required = EXCLUDED.is_required,
						is_localized = EXCLUDED.is_localized,
						is_collection = EXCLUDED.is_collection,
						is_immutable = EXCLUDED.is_immutable,
						configuration = EXCLUDED.configuration,
						active = true,
						updated_at = now()
				`);
			}
		}
		for (const relation of materialization.entityRelations) {
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.entity_relations (
					identifier,
					contribution_key,
					source_type_id,
					target_type_id,
					source_cardinality,
					target_cardinality,
					on_target_removal
				)
				VALUES (
					${relation.identifier},
					${relation.contributionKey},
					(SELECT id FROM core.entity_types WHERE identifier = ${relation.sourceTypeIdentifier}),
					(SELECT id FROM core.entity_types WHERE identifier = ${relation.targetTypeIdentifier}),
					${relation.sourceCardinality},
					${relation.targetCardinality},
					${relation.onTargetRemoval}
				)
				ON CONFLICT (identifier) DO UPDATE
				SET active = true
			`);
		}
		for (const entityInterface of materialization.entityInterfaces) {
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.entity_interfaces (
					identifier,
					contribution_key,
					entity_type_id,
					purpose,
					field_identifiers
				)
				VALUES (
					${entityInterface.identifier},
					${entityInterface.contributionKey},
					(SELECT id FROM core.entity_types WHERE identifier = ${entityInterface.entityTypeIdentifier}),
					${entityInterface.purpose},
					${[...entityInterface.fieldIdentifiers]}
				)
				ON CONFLICT (identifier) DO UPDATE
				SET
					purpose = EXCLUDED.purpose,
					field_identifiers = EXCLUDED.field_identifiers,
					active = true
			`);
		}
	}

	private async persistNavigation(
		transaction: TransactionContext,
		materialization: NativeContentMaterialization,
	): Promise<void> {
		for (const link of materialization.navigationLinks) {
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.navigation_links (
					identifier,
					contribution_key,
					mode,
					target,
					route_parameters,
					title_text_id,
					tooltip_text_id,
					icon_identifier,
					required_capabilities,
					definition_fingerprint
				)
				VALUES (
					${link.identifier},
					${link.contributionKey},
					${link.mode},
					${link.target},
					${JSON.stringify(link.routeParameters ?? {})}::jsonb,
					(SELECT id FROM core.localized_text_resources WHERE identifier = ${link.titleTextIdentifier}),
					(SELECT id FROM core.localized_text_resources WHERE identifier = ${link.tooltipTextIdentifier ?? ""}),
					${link.iconIdentifier ?? null},
					${[...link.requiredCapabilities]},
					${hash(link)}
				)
				ON CONFLICT (identifier) DO UPDATE
				SET
					mode = EXCLUDED.mode,
					target = EXCLUDED.target,
					route_parameters = EXCLUDED.route_parameters,
					icon_identifier = EXCLUDED.icon_identifier,
					required_capabilities = EXCLUDED.required_capabilities,
					definition_fingerprint = EXCLUDED.definition_fingerprint,
					updated_at = now()
			`);
		}
		for (const sidebar of materialization.sidebars) {
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.sidebars (
					identifier,
					contribution_key,
					version,
					title_text_id,
					subtitle_text_id,
					icon_identifier,
					allows_extensions,
					definition_fingerprint
				)
				VALUES (
					${sidebar.identifier},
					${sidebar.contributionKey},
					${materialization.version},
					(SELECT id FROM core.localized_text_resources WHERE identifier = ${sidebar.titleTextIdentifier ?? ""}),
					(SELECT id FROM core.localized_text_resources WHERE identifier = ${sidebar.subtitleTextIdentifier ?? ""}),
					${sidebar.iconIdentifier ?? null},
					${sidebar.allowsExtensions},
					${hash(sidebar)}
				)
				ON CONFLICT (identifier) DO UPDATE
				SET
					version = EXCLUDED.version,
					icon_identifier = EXCLUDED.icon_identifier,
					allows_extensions = EXCLUDED.allows_extensions,
					definition_fingerprint = EXCLUDED.definition_fingerprint,
					updated_at = now()
			`);
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.sidebar_states (sidebar_id, enabled)
				SELECT id, ${sidebar.enabled}
				FROM core.sidebars
				WHERE identifier = ${sidebar.identifier}
				ON CONFLICT (sidebar_id) DO NOTHING
			`);
		}
		for (const item of materialization.navigationItems) {
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.navigation_items (
					identifier,
					contribution_key,
					position,
					link_id,
					subtitle_text_id,
					sidebar_id,
					color_token,
					conditions,
					definition_fingerprint
				)
				VALUES (
					${item.identifier},
					${item.contributionKey},
					${item.position},
					(SELECT id FROM core.navigation_links WHERE identifier = ${item.linkIdentifier}),
					(SELECT id FROM core.localized_text_resources WHERE identifier = ${item.subtitleTextIdentifier ?? ""}),
					(SELECT id FROM core.sidebars WHERE identifier = ${item.sidebarIdentifier ?? ""}),
					${item.colorToken ?? null},
					${JSON.stringify(item.conditions)}::jsonb,
					${hash(item)}
				)
				ON CONFLICT (identifier) DO UPDATE
				SET
					color_token = EXCLUDED.color_token,
					conditions = EXCLUDED.conditions,
					definition_fingerprint = EXCLUDED.definition_fingerprint,
					updated_at = now()
			`);
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.navigation_item_states (item_id, enabled, display_order)
				SELECT id, ${item.enabled}, ${item.order}
				FROM core.navigation_items
				WHERE identifier = ${item.identifier}
				ON CONFLICT (item_id) DO NOTHING
			`);
		}
		for (const item of materialization.sidebarItems) {
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.sidebar_items (
					sidebar_id,
					contribution_key,
					identifier,
					kind,
					parent_item_id,
					section_separator_id,
					catalog_link_id,
					text_id,
					accessible_label_text_id,
					tooltip_text_id,
					icon_identifier,
					initially_expanded,
					allows_children,
					definition_fingerprint
				)
				VALUES (
					(SELECT id FROM core.sidebars WHERE identifier = ${item.sidebarIdentifier}),
					${item.contributionKey},
					${item.identifier},
					${item.kind},
					(SELECT id FROM core.sidebar_items WHERE identifier = ${item.parentIdentifier ?? ""}),
					(SELECT id FROM core.sidebar_items WHERE identifier = ${item.sectionSeparatorIdentifier ?? ""}),
					(SELECT id FROM core.navigation_links WHERE identifier = ${item.linkIdentifier ?? ""}),
					(SELECT id FROM core.localized_text_resources WHERE identifier = ${item.textIdentifier ?? ""}),
					(SELECT id FROM core.localized_text_resources WHERE identifier = ${item.accessibleLabelTextIdentifier ?? ""}),
					(SELECT id FROM core.localized_text_resources WHERE identifier = ${item.tooltipTextIdentifier ?? ""}),
					${item.iconIdentifier ?? null},
					${item.initiallyExpanded},
					${item.allowsChildren},
					${hash(item)}
				)
				ON CONFLICT (sidebar_id, identifier) DO UPDATE
				SET
					icon_identifier = EXCLUDED.icon_identifier,
					initially_expanded = EXCLUDED.initially_expanded,
					allows_children = EXCLUDED.allows_children,
					definition_fingerprint = EXCLUDED.definition_fingerprint,
					updated_at = now()
			`);
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.sidebar_item_states (item_id, enabled, display_order)
				SELECT id, ${item.enabled}, ${item.order}
				FROM core.sidebar_items
				WHERE identifier = ${item.identifier}
				ON CONFLICT (item_id) DO NOTHING
			`);
		}
	}

	private async persistPages(
		transaction: TransactionContext,
		materialization: NativeContentMaterialization,
	): Promise<void> {
		for (const parameterType of materialization.routeParameterTypes) {
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.page_route_parameter_types (
					identifier,
					contribution_key,
					base_type,
					maximum_length,
					allowed_values
				)
				VALUES (
					${parameterType.identifier},
					${materialization.contributionKey},
					${parameterType.base},
					${parameterType.maximumLength ?? null},
					${JSON.stringify(parameterType.allowedValues ?? [])}::jsonb
				)
				ON CONFLICT (identifier) DO UPDATE
				SET
					base_type = EXCLUDED.base_type,
					maximum_length = EXCLUDED.maximum_length,
					allowed_values = EXCLUDED.allowed_values,
					updated_at = now()
			`);
		}
		for (const contract of materialization.pageComponentContracts) {
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.page_component_contracts (
					identifier,
					contribution_key,
					contract_version,
					frontend_module_identifier,
					allowed_properties,
					slots,
					events,
					required_capabilities,
					definition_fingerprint
				)
				VALUES (
					${contract.identifier},
					${materialization.contributionKey},
					${contract.contractVersion},
					${contract.frontendModuleIdentifier},
					${JSON.stringify(contract.allowedProperties ?? [])}::jsonb,
					${JSON.stringify(contract.slots ?? [])}::jsonb,
					${JSON.stringify(contract.events ?? [])}::jsonb,
					${[...(contract.requiredCapabilities ?? [])]},
					${hash(contract)}
				)
				ON CONFLICT (identifier) DO UPDATE
				SET
					contract_version = EXCLUDED.contract_version,
					frontend_module_identifier = EXCLUDED.frontend_module_identifier,
					allowed_properties = EXCLUDED.allowed_properties,
					slots = EXCLUDED.slots,
					events = EXCLUDED.events,
					required_capabilities = EXCLUDED.required_capabilities,
					definition_fingerprint = EXCLUDED.definition_fingerprint,
					updated_at = now()
			`);
		}
		for (const contract of materialization.pageDataProviderContracts) {
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.page_data_provider_contracts (
					identifier,
					contribution_key,
					contract_version,
					business_method_identifier,
					context_kinds,
					definition_fingerprint
				)
				VALUES (
					${contract.identifier},
					${materialization.contributionKey},
					${contract.contractVersion},
					${contract.businessMethodIdentifier},
					${[...contract.contextKinds]},
					${hash(contract)}
				)
				ON CONFLICT (identifier) DO UPDATE
				SET
					contract_version = EXCLUDED.contract_version,
					business_method_identifier = EXCLUDED.business_method_identifier,
					context_kinds = EXCLUDED.context_kinds,
					definition_fingerprint = EXCLUDED.definition_fingerprint,
					updated_at = now()
			`);
		}
		for (const contract of materialization.pageActionContracts) {
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.page_action_contracts (
					identifier,
					contribution_key,
					contract_version,
					business_method_identifier,
					required_capability,
					definition_fingerprint
				)
				VALUES (
					${contract.identifier},
					${materialization.contributionKey},
					${contract.contractVersion},
					${contract.businessMethodIdentifier},
					${contract.requiredCapability ?? null},
					${hash(contract)}
				)
				ON CONFLICT (identifier) DO UPDATE
				SET
					contract_version = EXCLUDED.contract_version,
					business_method_identifier = EXCLUDED.business_method_identifier,
					required_capability = EXCLUDED.required_capability,
					definition_fingerprint = EXCLUDED.definition_fingerprint,
					updated_at = now()
			`);
		}
		for (const contextType of materialization.pageContextTypes) {
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.page_context_types (
					identifier,
					contribution_key,
					contract_version,
					resolver_method_identifier,
					parameter_types,
					definition_fingerprint
				)
				VALUES (
					${contextType.identifier},
					${materialization.contributionKey},
					${contextType.contractVersion},
					${contextType.resolverMethodIdentifier},
					${JSON.stringify(contextType.parameterTypes)}::jsonb,
					${hash(contextType)}
				)
				ON CONFLICT (identifier) DO UPDATE
				SET
					contract_version = EXCLUDED.contract_version,
					resolver_method_identifier = EXCLUDED.resolver_method_identifier,
					parameter_types = EXCLUDED.parameter_types,
					definition_fingerprint = EXCLUDED.definition_fingerprint,
					updated_at = now()
			`);
		}
		for (const page of materialization.pages) {
			const canonicalRoute = page.routes.find((route) => route.canonical) ?? page.routes[0]!;
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.pages (
					identifier,
					contribution_key,
					route,
					surface,
					owner_kind,
					title_text_id,
					description_text_id,
					required_capabilities,
					is_editable,
					is_removable,
					archived,
					context_definition,
					canonical_entity_type_identifier,
					canonical_usage,
					definition_fingerprint
				)
				VALUES (
					${page.identifier},
					${page.contributionKey},
					${canonicalRoute.pattern},
					${page.surface},
					${page.ownerKind},
					(SELECT id FROM core.localized_text_resources WHERE identifier = ${page.titleTextIdentifier}),
					(SELECT id FROM core.localized_text_resources WHERE identifier = ${page.descriptionTextIdentifier ?? ""}),
					${[...page.requiredCapabilities]},
					${page.editable},
					${page.removable},
					${page.archived ?? false},
					${JSON.stringify(page.context)}::jsonb,
					${page.canonicalFor?.entityTypeIdentifier ?? null},
					${page.canonicalFor?.usage ?? null},
					${hash(page)}
				)
				ON CONFLICT (identifier) DO UPDATE
				SET
					route = EXCLUDED.route,
					owner_kind = EXCLUDED.owner_kind,
					required_capabilities = EXCLUDED.required_capabilities,
					is_editable = EXCLUDED.is_editable,
					is_removable = EXCLUDED.is_removable,
					archived = EXCLUDED.archived,
					context_definition = EXCLUDED.context_definition,
					canonical_entity_type_identifier = EXCLUDED.canonical_entity_type_identifier,
					canonical_usage = EXCLUDED.canonical_usage,
					definition_fingerprint = EXCLUDED.definition_fingerprint,
					updated_at = now()
			`);
			for (const route of page.routes) {
				await transaction.query(/* pgsql */ sql`
					INSERT INTO core.page_routes (
						page_id,
						identifier,
						pattern,
						locale_tag,
						priority,
						canonical,
						active
					)
					SELECT
						id,
						${route.identifier},
						${route.pattern},
						${route.locale ?? null},
						${route.priority ?? 0},
						${route.canonical ?? false},
						${route.active ?? true}
					FROM core.pages
					WHERE identifier = ${page.identifier}
					ON CONFLICT (identifier) DO UPDATE
					SET
						pattern = EXCLUDED.pattern,
						locale_tag = EXCLUDED.locale_tag,
						priority = EXCLUDED.priority,
						canonical = EXCLUDED.canonical,
						active = EXCLUDED.active,
						updated_at = now()
				`);
				await transaction.query(/* pgsql */ sql`
					DELETE FROM core.page_route_aliases
					WHERE route_id = (
						SELECT id FROM core.page_routes WHERE identifier = ${route.identifier}
					)
				`);
				for (const alias of route.aliases ?? []) {
					await transaction.query(/* pgsql */ sql`
						INSERT INTO core.page_route_aliases (route_id, pattern)
						SELECT id, ${alias}
						FROM core.page_routes
						WHERE identifier = ${route.identifier}
					`);
				}
			}
			for (const route of page.routes) {
				if (!route.redirectToRouteIdentifier) continue;
				await transaction.query(/* pgsql */ sql`
					UPDATE core.page_routes
					SET redirect_to_route_id = (
						SELECT id
						FROM core.page_routes
						WHERE identifier = ${route.redirectToRouteIdentifier}
					)
					WHERE identifier = ${route.identifier}
				`);
			}
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.page_revisions (
					page_id,
					revision,
					state,
					document,
					validated_at,
					published_at
				)
				SELECT
					id,
					1,
					${page.published ? "published" : "draft"},
					${JSON.stringify(page.initialDocument)}::jsonb,
					${page.published ? new Date() : null},
					${page.published ? new Date() : null}
				FROM core.pages
				WHERE identifier = ${page.identifier}
				ON CONFLICT (page_id, revision) DO NOTHING
			`);
			if (page.published) {
				await transaction.query(/* pgsql */ sql`
					INSERT INTO core.page_publications (page_id, revision_id)
					SELECT pages.id, revisions.id
					FROM core.pages AS pages
					JOIN core.page_revisions AS revisions
						ON revisions.page_id = pages.id AND revisions.revision = 1
					WHERE pages.identifier = ${page.identifier}
					ON CONFLICT (page_id) DO NOTHING
				`);
			}
			for (const breakpoint of page.initialDocument.breakpoints) {
				await transaction.query(/* pgsql */ sql`
					INSERT INTO core.page_grid_breakpoints (
						revision_id,
						identifier,
						minimum_width,
						columns,
						row_height,
						gap,
						inherits_identifier
					)
					SELECT
						revisions.id,
						${breakpoint.identifier},
						${breakpoint.minimumWidth},
						${breakpoint.columns},
						${breakpoint.rowHeight},
						${breakpoint.gap},
						${breakpoint.inherits ?? null}
					FROM core.page_revisions AS revisions
					JOIN core.pages AS pages ON pages.id = revisions.page_id
					WHERE pages.identifier = ${page.identifier} AND revisions.revision = 1
					ON CONFLICT (revision_id, identifier) DO NOTHING
				`);
			}
			for (const region of page.initialDocument.regions) {
				await transaction.query(/* pgsql */ sql`
					INSERT INTO core.page_regions (revision_id, identifier, display_order)
					SELECT revisions.id, ${region.identifier}, ${region.order}
					FROM core.page_revisions AS revisions
					JOIN core.pages AS pages ON pages.id = revisions.page_id
					WHERE pages.identifier = ${page.identifier} AND revisions.revision = 1
					ON CONFLICT (revision_id, identifier) DO NOTHING
				`);
			}
			for (const container of page.initialDocument.containers) {
				await transaction.query(/* pgsql */ sql`
					INSERT INTO core.page_containers (
						revision_id,
						region_id,
						identifier,
						minimum_column_span,
						minimum_row_span
					)
					SELECT
						revisions.id,
						regions.id,
						${container.identifier},
						${container.minimumColumnSpan ?? 1},
						${container.minimumRowSpan ?? 1}
					FROM core.page_revisions AS revisions
					JOIN core.pages AS pages ON pages.id = revisions.page_id
					JOIN core.page_regions AS regions
						ON regions.revision_id = revisions.id
						AND regions.identifier = ${container.regionIdentifier}
					WHERE pages.identifier = ${page.identifier} AND revisions.revision = 1
					ON CONFLICT (revision_id, identifier) DO NOTHING
				`);
				for (const placement of container.placements) {
					await transaction.query(/* pgsql */ sql`
						INSERT INTO core.page_container_placements (
							container_id,
							breakpoint_id,
							grid_column,
							grid_row,
							column_span,
							row_span
						)
						SELECT
							containers.id,
							breakpoints.id,
							${placement.column},
							${placement.row},
							${placement.columnSpan},
							${placement.rowSpan}
						FROM core.page_containers AS containers
						JOIN core.page_revisions AS revisions ON revisions.id = containers.revision_id
						JOIN core.pages AS pages ON pages.id = revisions.page_id
						JOIN core.page_grid_breakpoints AS breakpoints
							ON breakpoints.revision_id = revisions.id
							AND breakpoints.identifier = ${placement.breakpoint}
						WHERE
							pages.identifier = ${page.identifier}
							AND revisions.revision = 1
							AND containers.identifier = ${container.identifier}
						ON CONFLICT (container_id, breakpoint_id) DO NOTHING
					`);
				}
			}
			for (const component of page.initialDocument.components) {
				await transaction.query(/* pgsql */ sql`
					INSERT INTO core.page_component_instances (
						revision_id,
						container_id,
						identifier,
						component_identifier,
						display_order,
						properties,
						sources,
						action_identifiers
					)
					SELECT
						revisions.id,
						containers.id,
						${component.identifier},
						${component.componentIdentifier},
						${component.order},
						${JSON.stringify(component.properties ?? {})}::jsonb,
						${JSON.stringify(component.sources ?? {})}::jsonb,
						${[...(component.actionIdentifiers ?? [])]}
					FROM core.page_revisions AS revisions
					JOIN core.pages AS pages ON pages.id = revisions.page_id
					JOIN core.page_containers AS containers
						ON containers.revision_id = revisions.id
						AND containers.identifier = ${component.containerIdentifier}
					WHERE pages.identifier = ${page.identifier} AND revisions.revision = 1
					ON CONFLICT (revision_id, identifier) DO NOTHING
				`);
			}
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.page_states (page_id, published)
				SELECT id, ${page.published}
				FROM core.pages
				WHERE identifier = ${page.identifier}
				ON CONFLICT (page_id) DO NOTHING
			`);
		}
	}
}

function hash(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
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
