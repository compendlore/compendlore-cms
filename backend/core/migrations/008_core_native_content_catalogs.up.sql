CREATE TABLE core.localized_text_resources (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	namespace TEXT NOT NULL,
	resource_key TEXT NOT NULL,
	format TEXT NOT NULL,
	allow_instance_override BOOLEAN NOT NULL DEFAULT true,
	required BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT localized_text_resources_format_check CHECK (format IN ('plain', 'multiline')),
	CONSTRAINT localized_text_resources_identity_unique UNIQUE (contribution_key, namespace, resource_key)
);

CREATE INDEX localized_text_resources_contribution_idx
	ON core.localized_text_resources (contribution_key);

CREATE TABLE core.localized_text_values (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	resource_id UUID NOT NULL REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	locale_tag TEXT NOT NULL,
	source_layer TEXT NOT NULL,
	source_contribution_key TEXT NOT NULL,
	value TEXT NOT NULL,
	revision BIGINT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	created_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT localized_text_values_layer_check CHECK (source_layer IN ('owner', 'translation', 'instance')),
	CONSTRAINT localized_text_values_revision_check CHECK (revision > 0),
	CONSTRAINT localized_text_values_value_check CHECK (length(value) > 0),
	CONSTRAINT localized_text_values_revision_unique UNIQUE (
		resource_id,
		locale_tag,
		source_layer,
		source_contribution_key,
		revision
	)
);

CREATE UNIQUE INDEX localized_text_values_active_idx
	ON core.localized_text_values (
		resource_id,
		locale_tag,
		source_layer,
		source_contribution_key
	)
	WHERE active;

CREATE INDEX localized_text_values_resolution_idx
	ON core.localized_text_values (resource_id, locale_tag, active, revision DESC);

CREATE TABLE core.instance_locales (
	instance_id UUID NOT NULL REFERENCES core.instances (id) ON DELETE CASCADE,
	locale_tag TEXT NOT NULL,
	enabled BOOLEAN NOT NULL DEFAULT true,
	display_order INTEGER NOT NULL DEFAULT 0,
	fallback_locale_tag TEXT,
	flag_media_id UUID,
	PRIMARY KEY (instance_id, locale_tag),
	FOREIGN KEY (instance_id, fallback_locale_tag)
		REFERENCES core.instance_locales (instance_id, locale_tag)
		DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE core.translation_source_selections (
	instance_id UUID NOT NULL REFERENCES core.instances (id) ON DELETE CASCADE,
	target_contribution_key TEXT NOT NULL,
	locale_tag TEXT NOT NULL,
	source_contribution_key TEXT NOT NULL,
	priority INTEGER NOT NULL DEFAULT 0,
	enabled BOOLEAN NOT NULL DEFAULT true,
	updated_by UUID NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (instance_id, target_contribution_key, locale_tag, source_contribution_key)
);

CREATE TABLE core.native_content_contributions (
	contribution_key TEXT PRIMARY KEY,
	owner_kind TEXT NOT NULL,
	owner_identifier TEXT NOT NULL,
	version TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'active',
	last_error TEXT,
	registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT native_content_owner_kind_check CHECK (
		owner_kind IN ('core', 'native-module', 'addon', 'instance')
	),
	CONSTRAINT native_content_state_check CHECK (
		state IN ('active', 'disabled', 'failed', 'withdrawn')
	)
);

CREATE TABLE core.native_content_dependencies (
	contribution_key TEXT NOT NULL REFERENCES core.native_content_contributions (contribution_key) ON DELETE CASCADE,
	required_contribution_key TEXT NOT NULL REFERENCES core.native_content_contributions (contribution_key) ON DELETE RESTRICT,
	PRIMARY KEY (contribution_key, required_contribution_key),
	CONSTRAINT native_content_dependency_self_check CHECK (contribution_key <> required_contribution_key)
);

CREATE TABLE core.entity_field_types (
	identifier TEXT PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	version TEXT NOT NULL,
	configuration_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE core.entity_types (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	parent_id UUID REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	name_text_id UUID NOT NULL REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	description_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	is_abstract BOOLEAN NOT NULL DEFAULT false,
	is_required BOOLEAN NOT NULL DEFAULT false,
	allows_extensions BOOLEAN NOT NULL DEFAULT true,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT entity_types_root_check CHECK (
		(identifier = 'entity' AND parent_id IS NULL) OR identifier <> 'entity'
	)
);

CREATE INDEX entity_types_parent_idx ON core.entity_types (parent_id);
CREATE INDEX entity_types_contribution_idx ON core.entity_types (contribution_key);

CREATE TABLE core.entity_type_versions (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	entity_type_id UUID NOT NULL REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	version TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT entity_type_versions_status_check CHECK (status IN ('draft', 'active', 'archived')),
	UNIQUE (entity_type_id, version)
);

CREATE TABLE core.entity_fields (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	entity_type_id UUID NOT NULL REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	contribution_key TEXT NOT NULL,
	identifier TEXT NOT NULL,
	field_type_identifier TEXT NOT NULL REFERENCES core.entity_field_types (identifier) ON DELETE RESTRICT,
	label_text_id UUID NOT NULL REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	description_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	is_required BOOLEAN NOT NULL DEFAULT false,
	is_localized BOOLEAN NOT NULL DEFAULT false,
	is_collection BOOLEAN NOT NULL DEFAULT false,
	is_immutable BOOLEAN NOT NULL DEFAULT false,
	configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	UNIQUE (entity_type_id, identifier)
);

CREATE INDEX entity_fields_type_idx ON core.entity_fields (entity_type_id, active);

CREATE TABLE core.entity_relations (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	source_type_id UUID NOT NULL REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	target_type_id UUID NOT NULL REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	source_cardinality TEXT NOT NULL,
	target_cardinality TEXT NOT NULL,
	on_target_removal TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT entity_relations_source_cardinality_check CHECK (source_cardinality IN ('one', 'many')),
	CONSTRAINT entity_relations_target_cardinality_check CHECK (target_cardinality IN ('one', 'many')),
	CONSTRAINT entity_relations_removal_check CHECK (on_target_removal IN ('block', 'nullify', 'preserve'))
);

CREATE TABLE core.entity_interfaces (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	entity_type_id UUID NOT NULL REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	purpose TEXT NOT NULL,
	field_identifiers TEXT[] NOT NULL,
	conditional_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT entity_interfaces_purpose_check CHECK (
		purpose IN ('create', 'edit', 'detail', 'summary', 'list', 'select')
	)
);

CREATE TABLE core.entity_records (
	record_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	entity_type_id UUID NOT NULL REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	public_id TEXT NOT NULL,
	workflow_state TEXT NOT NULL DEFAULT 'draft',
	author_id UUID NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
	owner_kind TEXT NOT NULL,
	owner_identifier TEXT NOT NULL,
	revision BIGINT NOT NULL DEFAULT 1,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT entity_records_workflow_check CHECK (
		workflow_state IN ('draft', 'review', 'published', 'archived')
	),
	CONSTRAINT entity_records_owner_kind_check CHECK (owner_kind IN ('user', 'group')),
	CONSTRAINT entity_records_revision_check CHECK (revision > 0),
	UNIQUE (entity_type_id, public_id)
);

CREATE INDEX entity_records_type_state_idx
	ON core.entity_records (entity_type_id, workflow_state, updated_at DESC);
CREATE INDEX entity_records_owner_idx
	ON core.entity_records (owner_kind, owner_identifier, updated_at DESC);

CREATE TABLE core.entity_record_values (
	record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE CASCADE,
	field_id UUID NOT NULL REFERENCES core.entity_fields (id) ON DELETE RESTRICT,
	locale_tag TEXT NOT NULL DEFAULT '',
	collection_index INTEGER NOT NULL DEFAULT 0,
	value JSONB NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (record_id, field_id, locale_tag, collection_index),
	CONSTRAINT entity_record_values_index_check CHECK (collection_index >= 0)
);

CREATE INDEX entity_record_values_field_idx ON core.entity_record_values (field_id);

CREATE TABLE core.entity_revisions (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE CASCADE,
	revision BIGINT NOT NULL,
	workflow_state TEXT NOT NULL,
	snapshot JSONB NOT NULL,
	created_by UUID NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	UNIQUE (record_id, revision)
);

CREATE TABLE core.entity_relation_values (
	relation_id UUID NOT NULL REFERENCES core.entity_relations (id) ON DELETE RESTRICT,
	source_record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE CASCADE,
	target_record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE RESTRICT,
	position INTEGER NOT NULL DEFAULT 0,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (relation_id, source_record_id, target_record_id)
);

CREATE INDEX entity_relation_values_target_idx
	ON core.entity_relation_values (relation_id, target_record_id);

CREATE TABLE core.measurement_dimensions (
	identifier TEXT PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	name_text_id UUID NOT NULL REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE core.measurement_units (
	identifier TEXT PRIMARY KEY,
	dimension_identifier TEXT NOT NULL REFERENCES core.measurement_dimensions (identifier) ON DELETE RESTRICT,
	contribution_key TEXT NOT NULL,
	symbol TEXT NOT NULL,
	scale NUMERIC NOT NULL,
	offset NUMERIC NOT NULL DEFAULT 0,
	version TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	CONSTRAINT measurement_units_scale_check CHECK (scale <> 0)
);

CREATE TABLE core.taxonomy_vocabularies (
	identifier TEXT PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	name_text_id UUID NOT NULL REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	allows_extensions BOOLEAN NOT NULL DEFAULT true,
	active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE core.taxonomy_terms (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	identifier TEXT NOT NULL,
	vocabulary_identifier TEXT NOT NULL REFERENCES core.taxonomy_vocabularies (identifier) ON DELETE RESTRICT,
	contribution_key TEXT NOT NULL,
	label_text_id UUID NOT NULL REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	aliases TEXT[] NOT NULL DEFAULT '{}',
	active BOOLEAN NOT NULL DEFAULT true,
	UNIQUE (vocabulary_identifier, identifier)
);

CREATE TABLE core.entity_taxonomy_assignments (
	record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE CASCADE,
	term_id UUID NOT NULL REFERENCES core.taxonomy_terms (id) ON DELETE RESTRICT,
	field_id UUID NOT NULL REFERENCES core.entity_fields (id) ON DELETE RESTRICT,
	PRIMARY KEY (record_id, term_id, field_id)
);

CREATE TABLE core.entity_shares (
	record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE CASCADE,
	grantee_kind TEXT NOT NULL,
	grantee_identifier TEXT NOT NULL,
	capability_identifier TEXT NOT NULL,
	created_by UUID NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (record_id, grantee_kind, grantee_identifier, capability_identifier),
	CONSTRAINT entity_shares_grantee_kind_check CHECK (grantee_kind IN ('user', 'group', 'role'))
);

CREATE TABLE core.entity_search_documents (
	record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE CASCADE,
	locale_tag TEXT NOT NULL,
	audience_key TEXT NOT NULL,
	document TSVECTOR NOT NULL,
	revision BIGINT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (record_id, locale_tag, audience_key)
);

CREATE INDEX entity_search_documents_document_idx
	ON core.entity_search_documents USING GIN (document);

CREATE TABLE core.rich_content_anchors (
	record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE CASCADE,
	field_id UUID NOT NULL REFERENCES core.entity_fields (id) ON DELETE RESTRICT,
	locale_tag TEXT NOT NULL,
	anchor_identifier TEXT NOT NULL,
	revision BIGINT NOT NULL,
	PRIMARY KEY (record_id, field_id, locale_tag, anchor_identifier)
);

CREATE TABLE core.navigation_links (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	mode TEXT NOT NULL,
	target TEXT NOT NULL,
	title_text_id UUID NOT NULL REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	tooltip_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	icon_identifier TEXT,
	required_capabilities TEXT[] NOT NULL DEFAULT '{}',
	definition_fingerprint TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE core.sidebars (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	version TEXT NOT NULL,
	title_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	subtitle_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	icon_identifier TEXT,
	allows_extensions BOOLEAN NOT NULL DEFAULT true,
	override_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
	lifecycle_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
	definition_fingerprint TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE core.sidebar_states (
	sidebar_id UUID PRIMARY KEY REFERENCES core.sidebars (id) ON DELETE CASCADE,
	enabled BOOLEAN NOT NULL DEFAULT true,
	revision BIGINT NOT NULL DEFAULT 1,
	updated_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE core.navigation_items (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	position TEXT NOT NULL,
	link_id UUID NOT NULL REFERENCES core.navigation_links (id) ON DELETE RESTRICT,
	subtitle_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	sidebar_id UUID REFERENCES core.sidebars (id) ON DELETE RESTRICT,
	color_token TEXT,
	conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
	override_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
	lifecycle_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
	definition_fingerprint TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT navigation_items_position_check CHECK (position IN ('brand', 'primary', 'action'))
);

CREATE TABLE core.navigation_item_states (
	item_id UUID PRIMARY KEY REFERENCES core.navigation_items (id) ON DELETE CASCADE,
	enabled BOOLEAN NOT NULL DEFAULT true,
	display_order INTEGER NOT NULL DEFAULT 0,
	revision BIGINT NOT NULL DEFAULT 1,
	updated_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX navigation_items_position_idx ON core.navigation_items (position);

CREATE TABLE core.sidebar_items (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	sidebar_id UUID NOT NULL REFERENCES core.sidebars (id) ON DELETE CASCADE,
	contribution_key TEXT NOT NULL,
	identifier TEXT NOT NULL,
	kind TEXT NOT NULL,
	parent_item_id UUID REFERENCES core.sidebar_items (id) ON DELETE RESTRICT,
	section_separator_id UUID REFERENCES core.sidebar_items (id) ON DELETE RESTRICT,
	catalog_link_id UUID REFERENCES core.navigation_links (id) ON DELETE RESTRICT,
	text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	accessible_label_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	tooltip_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	icon_identifier TEXT,
	initially_expanded BOOLEAN NOT NULL DEFAULT false,
	allows_children BOOLEAN NOT NULL DEFAULT true,
	override_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
	lifecycle_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
	definition_fingerprint TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT sidebar_items_kind_check CHECK (kind IN ('category', 'link', 'separator')),
	CONSTRAINT sidebar_items_visual_check CHECK (text_id IS NOT NULL OR icon_identifier IS NOT NULL),
	CONSTRAINT sidebar_items_accessibility_check CHECK (
		text_id IS NOT NULL OR accessible_label_text_id IS NOT NULL
	),
	CONSTRAINT sidebar_items_shape_check CHECK (
		(kind = 'category' AND parent_item_id IS NULL AND catalog_link_id IS NULL)
		OR (kind = 'link' AND catalog_link_id IS NOT NULL)
		OR (
			kind = 'separator'
			AND parent_item_id IS NULL
			AND section_separator_id IS NULL
			AND catalog_link_id IS NULL
		)
	),
	UNIQUE (sidebar_id, identifier)
);

CREATE INDEX sidebar_items_parent_idx ON core.sidebar_items (sidebar_id, parent_item_id);
CREATE INDEX sidebar_items_section_idx ON core.sidebar_items (sidebar_id, section_separator_id);

CREATE TABLE core.sidebar_item_states (
	item_id UUID PRIMARY KEY REFERENCES core.sidebar_items (id) ON DELETE CASCADE,
	enabled BOOLEAN NOT NULL DEFAULT true,
	display_order INTEGER NOT NULL DEFAULT 0,
	revision BIGINT NOT NULL DEFAULT 1,
	updated_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE core.navigation_overrides (
	resource_kind TEXT NOT NULL,
	resource_id UUID NOT NULL,
	payload JSONB NOT NULL,
	schema_version TEXT NOT NULL,
	revision BIGINT NOT NULL,
	updated_by UUID NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (resource_kind, resource_id),
	CONSTRAINT navigation_overrides_kind_check CHECK (
		resource_kind IN ('navigation-item', 'sidebar', 'sidebar-item')
	)
);

CREATE TABLE core.pages (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	route TEXT NOT NULL UNIQUE,
	surface TEXT NOT NULL,
	title_text_id UUID NOT NULL REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	description_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	required_capabilities TEXT[] NOT NULL DEFAULT '{}',
	is_editable BOOLEAN NOT NULL DEFAULT false,
	is_removable BOOLEAN NOT NULL DEFAULT false,
	definition_fingerprint TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT pages_surface_check CHECK (surface IN ('site', 'account', 'administration'))
);

CREATE TABLE core.page_states (
	page_id UUID PRIMARY KEY REFERENCES core.pages (id) ON DELETE CASCADE,
	published BOOLEAN NOT NULL DEFAULT true,
	revision BIGINT NOT NULL DEFAULT 1,
	updated_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
