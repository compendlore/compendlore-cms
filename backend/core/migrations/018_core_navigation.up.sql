CREATE TABLE IF NOT EXISTS core.navigation_modes (
	id TEXT PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	version TEXT NOT NULL,
	parameter_schema JSONB NOT NULL,
	allowed_item_types TEXT[] NOT NULL,
	state TEXT NOT NULL DEFAULT 'active',
	CONSTRAINT navigation_modes_state_check CHECK (state IN ('active', 'disabled', 'withdrawn')),
	CONSTRAINT navigation_modes_item_types_check CHECK (allowed_item_types <@ ARRAY['brand', 'primary', 'action']::TEXT[])
);

CREATE TABLE IF NOT EXISTS core.navigation_target_types (
	id TEXT PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	version TEXT NOT NULL,
	parameter_schema JSONB NOT NULL,
	required_capability TEXT REFERENCES core.capabilities (identifier) ON DELETE RESTRICT,
	state TEXT NOT NULL DEFAULT 'active',
	CONSTRAINT navigation_target_types_state_check CHECK (state IN ('active', 'disabled', 'withdrawn'))
);

CREATE TABLE IF NOT EXISTS core.navigation_mode_target_types (
	mode_id TEXT NOT NULL REFERENCES core.navigation_modes (id) ON DELETE RESTRICT,
	target_type_id TEXT NOT NULL REFERENCES core.navigation_target_types (id) ON DELETE RESTRICT,
	PRIMARY KEY (mode_id, target_type_id)
);

CREATE TABLE IF NOT EXISTS core.navigation_actions (
	id TEXT PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	execution_kind TEXT NOT NULL,
	handler_reference TEXT NOT NULL,
	input_schema JSONB NOT NULL,
	required_capability TEXT REFERENCES core.capabilities (identifier) ON DELETE RESTRICT,
	state TEXT NOT NULL DEFAULT 'active',
	CONSTRAINT navigation_actions_execution_check CHECK (execution_kind IN ('frontend', 'backend-method')),
	CONSTRAINT navigation_actions_state_check CHECK (state IN ('active', 'disabled', 'withdrawn'))
);

CREATE TABLE IF NOT EXISTS core.visibility_policies (
	id UUID PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	owner_expression JSONB NOT NULL,
	instance_expression JSONB,
	schema_version INTEGER NOT NULL DEFAULT 1,
	fingerprint TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT visibility_policies_schema_version_check CHECK (schema_version > 0)
);

CREATE TABLE IF NOT EXISTS core.frontend_icons (
	id TEXT PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	version TEXT NOT NULL,
	component_reference TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'active',
	CONSTRAINT frontend_icons_state_check CHECK (state IN ('active', 'disabled', 'withdrawn'))
);

CREATE TABLE IF NOT EXISTS core.button_appearances (
	id TEXT PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	design_token TEXT NOT NULL,
	contrast_policy JSONB NOT NULL,
	state TEXT NOT NULL DEFAULT 'active',
	CONSTRAINT button_appearances_state_check CHECK (state IN ('active', 'disabled', 'withdrawn'))
);

CREATE TABLE IF NOT EXISTS core.navigation_targets (
	id UUID PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	identifier TEXT NOT NULL UNIQUE,
	mode_id TEXT NOT NULL REFERENCES core.navigation_modes (id) ON DELETE RESTRICT,
	target_type_id TEXT NOT NULL REFERENCES core.navigation_target_types (id) ON DELETE RESTRICT,
	parameters JSONB NOT NULL,
	required_capability TEXT REFERENCES core.capabilities (identifier) ON DELETE RESTRICT,
	audience TEXT NOT NULL,
	definition_fingerprint TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'active',
	CONSTRAINT navigation_targets_owner_identifier_unique UNIQUE (contribution_key, identifier),
	CONSTRAINT navigation_targets_audience_check CHECK (audience IN ('public', 'authenticated', 'administration')),
	CONSTRAINT navigation_targets_state_check CHECK (state IN ('active', 'disabled', 'withdrawn'))
);

CREATE INDEX IF NOT EXISTS navigation_targets_mode_type_idx ON core.navigation_targets (mode_id, target_type_id) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS core.navigation_links (
	id UUID PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	identifier TEXT NOT NULL UNIQUE,
	title_text_id UUID NOT NULL REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	tooltip_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	target_id UUID NOT NULL REFERENCES core.navigation_targets (id) ON DELETE RESTRICT,
	icon_id TEXT REFERENCES core.frontend_icons (id) ON DELETE RESTRICT,
	visibility_policy_id UUID NOT NULL REFERENCES core.visibility_policies (id) ON DELETE RESTRICT,
	definition_fingerprint TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'active',
	CONSTRAINT navigation_links_owner_identifier_unique UNIQUE (contribution_key, identifier),
	CONSTRAINT navigation_links_state_check CHECK (state IN ('active', 'disabled', 'withdrawn'))
);

CREATE TABLE IF NOT EXISTS core.sidebars (
	id UUID PRIMARY KEY,
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	version TEXT NOT NULL,
	title_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	subtitle_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	icon_id TEXT REFERENCES core.frontend_icons (id) ON DELETE RESTRICT,
	visibility_policy_id UUID NOT NULL REFERENCES core.visibility_policies (id) ON DELETE RESTRICT,
	allows_extensions BOOLEAN NOT NULL DEFAULT true,
	override_policy JSONB NOT NULL,
	lifecycle_policy JSONB NOT NULL,
	definition_fingerprint TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.sidebar_states (
	sidebar_id UUID PRIMARY KEY REFERENCES core.sidebars (id) ON DELETE RESTRICT,
	enabled BOOLEAN NOT NULL,
	revision BIGINT NOT NULL DEFAULT 1,
	updated_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT sidebar_states_revision_check CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS core.sidebar_items (
	id UUID PRIMARY KEY,
	sidebar_id UUID NOT NULL REFERENCES core.sidebars (id) ON DELETE RESTRICT,
	contribution_key TEXT NOT NULL,
	identifier TEXT NOT NULL,
	kind TEXT NOT NULL,
	parent_item_id UUID REFERENCES core.sidebar_items (id) ON DELETE RESTRICT,
	section_separator_id UUID REFERENCES core.sidebar_items (id) ON DELETE RESTRICT,
	catalog_link_id UUID REFERENCES core.navigation_links (id) ON DELETE RESTRICT,
	text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	accessible_label_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	tooltip_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	icon_id TEXT REFERENCES core.frontend_icons (id) ON DELETE RESTRICT,
	visibility_policy_id UUID NOT NULL REFERENCES core.visibility_policies (id) ON DELETE RESTRICT,
	initially_expanded BOOLEAN,
	allows_children BOOLEAN NOT NULL DEFAULT false,
	override_policy JSONB NOT NULL,
	lifecycle_policy JSONB NOT NULL,
	definition_fingerprint TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT sidebar_items_unique UNIQUE (sidebar_id, identifier),
	CONSTRAINT sidebar_items_kind_check CHECK (kind IN ('category', 'link', 'separator')),
	CONSTRAINT sidebar_items_visual_check CHECK (text_id IS NOT NULL OR icon_id IS NOT NULL),
	CONSTRAINT sidebar_items_accessible_check CHECK (text_id IS NOT NULL OR accessible_label_text_id IS NOT NULL),
	CONSTRAINT sidebar_items_shape_check CHECK (
		(kind = 'category' AND parent_item_id IS NULL AND catalog_link_id IS NULL)
		OR (kind = 'link' AND catalog_link_id IS NOT NULL)
		OR (kind = 'separator' AND parent_item_id IS NULL AND section_separator_id IS NULL AND catalog_link_id IS NULL AND initially_expanded IS NULL AND NOT allows_children)
	),
	CONSTRAINT sidebar_items_child_section_check CHECK (parent_item_id IS NULL OR section_separator_id IS NULL)
);

CREATE INDEX IF NOT EXISTS sidebar_items_parent_idx ON core.sidebar_items (sidebar_id, parent_item_id);
CREATE INDEX IF NOT EXISTS sidebar_items_section_idx ON core.sidebar_items (sidebar_id, section_separator_id);

CREATE TABLE IF NOT EXISTS core.sidebar_item_states (
	item_id UUID PRIMARY KEY REFERENCES core.sidebar_items (id) ON DELETE RESTRICT,
	enabled BOOLEAN NOT NULL,
	position INTEGER NOT NULL,
	revision BIGINT NOT NULL DEFAULT 1,
	updated_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT sidebar_item_states_position_check CHECK (position >= 0),
	CONSTRAINT sidebar_item_states_revision_check CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS core.navigation_items (
	id UUID PRIMARY KEY,
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	type TEXT NOT NULL,
	version TEXT NOT NULL,
	enabled_by_default BOOLEAN NOT NULL,
	target_id UUID NOT NULL REFERENCES core.navigation_targets (id) ON DELETE RESTRICT,
	sidebar_id UUID REFERENCES core.sidebars (id) ON DELETE RESTRICT,
	tooltip_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	visibility_policy_id UUID NOT NULL REFERENCES core.visibility_policies (id) ON DELETE RESTRICT,
	override_policy JSONB NOT NULL,
	lifecycle_policy JSONB NOT NULL,
	definition_fingerprint TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT navigation_items_type_check CHECK (type IN ('brand', 'primary', 'action'))
);

CREATE INDEX IF NOT EXISTS navigation_items_owner_type_idx ON core.navigation_items (contribution_key, type);
CREATE INDEX IF NOT EXISTS navigation_items_target_idx ON core.navigation_items (target_id);
CREATE INDEX IF NOT EXISTS navigation_items_sidebar_idx ON core.navigation_items (sidebar_id) WHERE sidebar_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.navigation_item_states (
	item_id UUID PRIMARY KEY REFERENCES core.navigation_items (id) ON DELETE RESTRICT,
	enabled BOOLEAN NOT NULL,
	position INTEGER,
	revision BIGINT NOT NULL DEFAULT 1,
	updated_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT navigation_item_states_revision_check CHECK (revision > 0),
	CONSTRAINT navigation_item_states_position_check CHECK (position IS NULL OR position >= 0)
);

CREATE TABLE IF NOT EXISTS core.navigation_brand_items (
	item_id UUID PRIMARY KEY REFERENCES core.navigation_items (id) ON DELETE RESTRICT,
	accessible_label_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS core.navigation_primary_items (
	item_id UUID PRIMARY KEY REFERENCES core.navigation_items (id) ON DELETE RESTRICT,
	title_text_id UUID NOT NULL REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	subtitle_text_id UUID REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	icon_id TEXT REFERENCES core.frontend_icons (id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS core.navigation_action_items (
	item_id UUID PRIMARY KEY REFERENCES core.navigation_items (id) ON DELETE RESTRICT,
	label_text_id UUID NOT NULL REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	icon_id TEXT REFERENCES core.frontend_icons (id) ON DELETE RESTRICT,
	presentation TEXT NOT NULL,
	appearance_id TEXT NOT NULL REFERENCES core.button_appearances (id) ON DELETE RESTRICT,
	CONSTRAINT navigation_action_items_presentation_check CHECK (presentation IN ('text', 'icon', 'icon-text')),
	CONSTRAINT navigation_action_items_icon_check CHECK (presentation <> 'icon' OR icon_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS core.navigation_brand_assignments (
	instance_id UUID PRIMARY KEY REFERENCES core.instances (id) ON DELETE RESTRICT,
	item_id UUID NOT NULL UNIQUE REFERENCES core.navigation_brand_items (item_id) ON DELETE RESTRICT,
	revision BIGINT NOT NULL DEFAULT 1,
	changed_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT navigation_brand_assignments_revision_check CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS core.navigation_item_capabilities (
	item_id UUID NOT NULL REFERENCES core.navigation_items (id) ON DELETE RESTRICT,
	capability_id TEXT NOT NULL REFERENCES core.capabilities (identifier) ON DELETE RESTRICT,
	source_layer TEXT NOT NULL,
	PRIMARY KEY (item_id, capability_id, source_layer),
	CONSTRAINT navigation_item_capabilities_layer_check CHECK (source_layer IN ('owner', 'instance'))
);

CREATE TABLE IF NOT EXISTS core.navigation_item_overrides (
	item_id UUID PRIMARY KEY REFERENCES core.navigation_items (id) ON DELETE RESTRICT,
	payload JSONB NOT NULL,
	schema_version INTEGER NOT NULL,
	revision BIGINT NOT NULL DEFAULT 1,
	updated_by UUID NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT navigation_item_overrides_schema_check CHECK (schema_version > 0),
	CONSTRAINT navigation_item_overrides_revision_check CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS core.sidebar_item_capabilities (
	item_id UUID NOT NULL REFERENCES core.sidebar_items (id) ON DELETE RESTRICT,
	capability_id TEXT NOT NULL REFERENCES core.capabilities (identifier) ON DELETE RESTRICT,
	source_layer TEXT NOT NULL,
	PRIMARY KEY (item_id, capability_id, source_layer),
	CONSTRAINT sidebar_item_capabilities_layer_check CHECK (source_layer IN ('owner', 'instance'))
);

CREATE TABLE IF NOT EXISTS core.sidebar_item_overrides (
	item_id UUID PRIMARY KEY REFERENCES core.sidebar_items (id) ON DELETE RESTRICT,
	payload JSONB NOT NULL,
	schema_version INTEGER NOT NULL,
	revision BIGINT NOT NULL DEFAULT 1,
	updated_by UUID NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT sidebar_item_overrides_schema_check CHECK (schema_version > 0),
	CONSTRAINT sidebar_item_overrides_revision_check CHECK (revision > 0)
);
