ALTER TABLE core.pages
	ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'native-module',
	ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false,
	ADD COLUMN context_definition JSONB NOT NULL DEFAULT '{"kind":"none"}'::jsonb,
	ADD COLUMN canonical_entity_type_identifier TEXT,
	ADD COLUMN canonical_usage TEXT;

ALTER TABLE core.navigation_links
	ADD COLUMN route_parameters JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE core.pages
	ADD CONSTRAINT pages_owner_kind_check CHECK (
		owner_kind IN ('addon', 'core', 'instance', 'native-module')
	),
	ADD CONSTRAINT pages_surface_phase_10_check CHECK (
		surface IN ('site', 'account', 'administration', 'system')
	),
	ADD CONSTRAINT pages_canonical_assignment_check CHECK (
		(canonical_entity_type_identifier IS NULL) = (canonical_usage IS NULL)
	);

ALTER TABLE core.pages
	DROP CONSTRAINT pages_surface_check,
	DROP CONSTRAINT pages_route_key;

CREATE UNIQUE INDEX pages_canonical_assignment_unique_idx
	ON core.pages (surface, canonical_entity_type_identifier, canonical_usage)
	WHERE canonical_entity_type_identifier IS NOT NULL AND archived = false;

CREATE TABLE core.page_route_parameter_types (
	identifier TEXT PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	base_type TEXT NOT NULL,
	maximum_length INTEGER,
	allowed_values JSONB,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT page_route_parameter_types_base_check CHECK (
		base_type IN ('integer', 'locale', 'slug', 'string', 'uuid')
	),
	CONSTRAINT page_route_parameter_types_length_check CHECK (
		maximum_length IS NULL OR maximum_length BETWEEN 1 AND 512
	)
);

CREATE TABLE core.page_routes (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	page_id UUID NOT NULL REFERENCES core.pages (id) ON DELETE CASCADE,
	identifier TEXT NOT NULL UNIQUE,
	pattern TEXT NOT NULL,
	locale_tag TEXT,
	priority INTEGER NOT NULL DEFAULT 0,
	canonical BOOLEAN NOT NULL DEFAULT false,
	redirect_to_route_id UUID REFERENCES core.page_routes (id) ON DELETE RESTRICT,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	UNIQUE (page_id, pattern, locale_tag)
);

CREATE UNIQUE INDEX page_routes_canonical_locale_idx
	ON core.page_routes (page_id, COALESCE(locale_tag, ''))
	WHERE canonical = true AND active = true;

CREATE INDEX page_routes_surface_lookup_idx
	ON core.page_routes (active, priority DESC, pattern);

CREATE TABLE core.page_route_aliases (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	route_id UUID NOT NULL REFERENCES core.page_routes (id) ON DELETE CASCADE,
	pattern TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	UNIQUE (route_id, pattern)
);

CREATE INDEX page_route_aliases_pattern_idx
	ON core.page_route_aliases (pattern);

CREATE TABLE core.page_component_contracts (
	identifier TEXT PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	contract_version TEXT NOT NULL,
	frontend_module_identifier TEXT NOT NULL,
	allowed_properties JSONB NOT NULL DEFAULT '[]'::jsonb,
	slots JSONB NOT NULL DEFAULT '[]'::jsonb,
	events JSONB NOT NULL DEFAULT '[]'::jsonb,
	required_capabilities TEXT[] NOT NULL DEFAULT '{}',
	definition_fingerprint TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE core.page_data_provider_contracts (
	identifier TEXT PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	contract_version TEXT NOT NULL,
	business_method_identifier TEXT NOT NULL,
	context_kinds TEXT[] NOT NULL,
	definition_fingerprint TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE core.page_action_contracts (
	identifier TEXT PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	contract_version TEXT NOT NULL,
	business_method_identifier TEXT NOT NULL,
	required_capability TEXT,
	definition_fingerprint TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE core.page_context_types (
	identifier TEXT PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	contract_version TEXT NOT NULL,
	resolver_method_identifier TEXT NOT NULL,
	parameter_types JSONB NOT NULL,
	definition_fingerprint TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE core.page_revisions (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	page_id UUID NOT NULL REFERENCES core.pages (id) ON DELETE CASCADE,
	revision BIGINT NOT NULL,
	state TEXT NOT NULL,
	document JSONB NOT NULL,
	author_id UUID REFERENCES core.users (id) ON DELETE SET NULL,
	validated_at TIMESTAMPTZ,
	published_at TIMESTAMPTZ,
	scheduled_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT page_revisions_state_check CHECK (
		state IN ('draft', 'validated', 'scheduled', 'published')
	),
	CONSTRAINT page_revisions_schedule_check CHECK (
		(state = 'scheduled' AND scheduled_at IS NOT NULL) OR state <> 'scheduled'
	),
	UNIQUE (page_id, revision)
);

CREATE INDEX page_revisions_publication_idx
	ON core.page_revisions (state, scheduled_at)
	WHERE state IN ('scheduled', 'published');

CREATE TABLE core.page_publications (
	page_id UUID PRIMARY KEY REFERENCES core.pages (id) ON DELETE CASCADE,
	revision_id UUID NOT NULL UNIQUE REFERENCES core.page_revisions (id) ON DELETE RESTRICT,
	published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE core.page_regions (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	revision_id UUID NOT NULL REFERENCES core.page_revisions (id) ON DELETE CASCADE,
	identifier TEXT NOT NULL,
	display_order INTEGER NOT NULL,
	UNIQUE (revision_id, identifier)
);

CREATE TABLE core.page_containers (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	revision_id UUID NOT NULL REFERENCES core.page_revisions (id) ON DELETE CASCADE,
	region_id UUID NOT NULL REFERENCES core.page_regions (id) ON DELETE CASCADE,
	identifier TEXT NOT NULL,
	minimum_column_span INTEGER NOT NULL DEFAULT 1,
	minimum_row_span INTEGER NOT NULL DEFAULT 1,
	UNIQUE (revision_id, identifier)
);

CREATE TABLE core.page_grid_breakpoints (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	revision_id UUID NOT NULL REFERENCES core.page_revisions (id) ON DELETE CASCADE,
	identifier TEXT NOT NULL,
	minimum_width INTEGER NOT NULL,
	columns INTEGER NOT NULL,
	row_height INTEGER NOT NULL,
	gap INTEGER NOT NULL,
	inherits_identifier TEXT,
	CONSTRAINT page_grid_breakpoints_columns_check CHECK (columns BETWEEN 1 AND 24),
	CONSTRAINT page_grid_breakpoints_sizes_check CHECK (
		minimum_width >= 0 AND row_height > 0 AND gap >= 0
	),
	UNIQUE (revision_id, identifier)
);

CREATE TABLE core.page_container_placements (
	container_id UUID NOT NULL REFERENCES core.page_containers (id) ON DELETE CASCADE,
	breakpoint_id UUID NOT NULL REFERENCES core.page_grid_breakpoints (id) ON DELETE CASCADE,
	grid_column INTEGER NOT NULL,
	grid_row INTEGER NOT NULL,
	column_span INTEGER NOT NULL,
	row_span INTEGER NOT NULL,
	PRIMARY KEY (container_id, breakpoint_id),
	CONSTRAINT page_container_placements_positive_check CHECK (
		grid_column > 0 AND grid_row > 0 AND column_span > 0 AND row_span > 0
	)
);

CREATE TABLE core.page_component_instances (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	revision_id UUID NOT NULL REFERENCES core.page_revisions (id) ON DELETE CASCADE,
	container_id UUID NOT NULL REFERENCES core.page_containers (id) ON DELETE CASCADE,
	identifier TEXT NOT NULL,
	component_identifier TEXT NOT NULL REFERENCES core.page_component_contracts (identifier) ON DELETE RESTRICT,
	display_order INTEGER NOT NULL,
	properties JSONB NOT NULL DEFAULT '{}'::jsonb,
	sources JSONB NOT NULL DEFAULT '{}'::jsonb,
	action_identifiers TEXT[] NOT NULL DEFAULT '{}',
	UNIQUE (revision_id, identifier)
);
