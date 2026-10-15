ALTER TABLE core.entity_field_types
	DROP CONSTRAINT IF EXISTS entity_field_types_storage_check;

ALTER TABLE core.entity_field_types
	ADD CONSTRAINT entity_field_types_storage_check CHECK (storage_family IN ('boolean', 'date', 'decimal', 'integer', 'json', 'relation', 'text', 'time', 'timestamp', 'uuid'));

CREATE TABLE IF NOT EXISTS core.entity_field_schema_nodes (
	id UUID PRIMARY KEY,
	field_definition_id UUID NOT NULL REFERENCES core.entity_field_definitions (id) ON DELETE RESTRICT,
	parent_node_id UUID REFERENCES core.entity_field_schema_nodes (id) ON DELETE RESTRICT,
	node_key TEXT NOT NULL,
	node_kind TEXT NOT NULL,
	position INTEGER NOT NULL,
	definition JSONB NOT NULL,
	CONSTRAINT entity_field_schema_nodes_unique UNIQUE (field_definition_id, parent_node_id, node_key),
	CONSTRAINT entity_field_schema_nodes_kind_check CHECK (node_kind IN ('collection', 'field', 'object', 'variant')),
	CONSTRAINT entity_field_schema_nodes_position_check CHECK (position >= 0)
);

CREATE TABLE IF NOT EXISTS core.entity_choice_sources (
	id UUID PRIMARY KEY,
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	source_kind TEXT NOT NULL,
	definition JSONB NOT NULL,
	definition_fingerprint TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	CONSTRAINT entity_choice_sources_kind_check CHECK (source_kind IN ('method', 'static', 'taxonomy'))
);

CREATE TABLE IF NOT EXISTS core.entity_choice_options (
	id UUID PRIMARY KEY,
	choice_source_id UUID NOT NULL REFERENCES core.entity_choice_sources (id) ON DELETE RESTRICT,
	option_key TEXT NOT NULL,
	label_resource TEXT NOT NULL,
	position INTEGER NOT NULL,
	archived_at TIMESTAMPTZ,
	CONSTRAINT entity_choice_options_unique UNIQUE (choice_source_id, option_key),
	CONSTRAINT entity_choice_options_position_check CHECK (position >= 0)
);

CREATE TABLE IF NOT EXISTS core.entity_field_extensions (
	id UUID PRIMARY KEY,
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	field_type_id UUID NOT NULL REFERENCES core.entity_field_types (id) ON DELETE RESTRICT,
	choice_source_id UUID REFERENCES core.entity_choice_sources (id) ON DELETE RESTRICT,
	definition JSONB NOT NULL,
	definition_fingerprint TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS core.entity_projection_definitions (
	id UUID PRIMARY KEY,
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	entity_type_id UUID NOT NULL REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	version INTEGER NOT NULL,
	definition JSONB NOT NULL,
	definition_fingerprint TEXT NOT NULL,
	indexed BOOLEAN NOT NULL DEFAULT false,
	active BOOLEAN NOT NULL DEFAULT true,
	CONSTRAINT entity_projection_versions_check CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS core.entity_projection_dependencies (
	projection_id UUID NOT NULL REFERENCES core.entity_projection_definitions (id) ON DELETE RESTRICT,
	dependency_projection_id UUID NOT NULL REFERENCES core.entity_projection_definitions (id) ON DELETE RESTRICT,
	PRIMARY KEY (projection_id, dependency_projection_id),
	CONSTRAINT entity_projection_dependencies_self_check CHECK (projection_id <> dependency_projection_id)
);

CREATE TABLE IF NOT EXISTS core.entity_interface_versions (
	id UUID PRIMARY KEY,
	interface_id UUID NOT NULL REFERENCES core.entity_interfaces (id) ON DELETE RESTRICT,
	version INTEGER NOT NULL,
	entity_type_version INTEGER NOT NULL,
	composition JSONB NOT NULL,
	authority_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
	definition_fingerprint TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	published_at TIMESTAMPTZ,
	CONSTRAINT entity_interface_versions_unique UNIQUE (interface_id, version),
	CONSTRAINT entity_interface_versions_version_check CHECK (version > 0 AND entity_type_version > 0)
);

CREATE TABLE IF NOT EXISTS core.entity_record_ownership (
	record_id UUID PRIMARY KEY REFERENCES core.entity_records (record_id) ON DELETE RESTRICT,
	author_id UUID REFERENCES core.users (id) ON DELETE SET NULL,
	owner_kind TEXT NOT NULL,
	owner_identifier UUID NOT NULL,
	transferred_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	transferred_at TIMESTAMPTZ,
	CONSTRAINT entity_record_ownership_kind_check CHECK (owner_kind IN ('group', 'instance', 'user'))
);

CREATE INDEX IF NOT EXISTS entity_record_ownership_owner_idx ON core.entity_record_ownership (owner_kind, owner_identifier, record_id);

CREATE TABLE IF NOT EXISTS core.entity_record_shares (
	record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE RESTRICT,
	principal_kind TEXT NOT NULL,
	principal_identifier UUID NOT NULL,
	capabilities JSONB NOT NULL,
	created_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (record_id, principal_kind, principal_identifier),
	CONSTRAINT entity_record_shares_kind_check CHECK (principal_kind IN ('group', 'user'))
);

CREATE TABLE IF NOT EXISTS core.entity_record_relations (
	id UUID PRIMARY KEY,
	relation_definition_id UUID NOT NULL REFERENCES core.entity_relation_definitions (id) ON DELETE RESTRICT,
	source_record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE RESTRICT,
	target_record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE RESTRICT,
	position INTEGER NOT NULL DEFAULT 0,
	created_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	archived_at TIMESTAMPTZ,
	CONSTRAINT entity_record_relations_unique UNIQUE (relation_definition_id, source_record_id, target_record_id),
	CONSTRAINT entity_record_relations_position_check CHECK (position >= 0)
);

CREATE INDEX IF NOT EXISTS entity_record_relations_target_idx ON core.entity_record_relations (relation_definition_id, target_record_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS core.measurement_definitions (
	id UUID PRIMARY KEY,
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	dimension TEXT NOT NULL,
	precision INTEGER NOT NULL,
	canonical_unit_key TEXT NOT NULL,
	definition_fingerprint TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	CONSTRAINT measurement_definitions_precision_check CHECK (precision BETWEEN 0 AND 18)
);

CREATE TABLE IF NOT EXISTS core.measurement_units (
	id UUID PRIMARY KEY,
	measurement_definition_id UUID NOT NULL REFERENCES core.measurement_definitions (id) ON DELETE RESTRICT,
	unit_key TEXT NOT NULL,
	contribution_key TEXT NOT NULL,
	symbol_resource TEXT NOT NULL,
	system_key TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	CONSTRAINT measurement_units_unique UNIQUE (measurement_definition_id, unit_key)
);

CREATE TABLE IF NOT EXISTS core.measurement_conversion_versions (
	id UUID PRIMARY KEY,
	measurement_unit_id UUID NOT NULL REFERENCES core.measurement_units (id) ON DELETE RESTRICT,
	version INTEGER NOT NULL,
	conversion_kind TEXT NOT NULL,
	numerator NUMERIC NOT NULL,
	denominator NUMERIC NOT NULL,
	offset_value NUMERIC NOT NULL DEFAULT 0,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT measurement_conversion_versions_unique UNIQUE (measurement_unit_id, version),
	CONSTRAINT measurement_conversion_versions_kind_check CHECK (conversion_kind IN ('affine', 'rational')),
	CONSTRAINT measurement_conversion_versions_denominator_check CHECK (denominator <> 0),
	CONSTRAINT measurement_conversion_versions_version_check CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS core.taxonomy_vocabularies (
	id UUID PRIMARY KEY,
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	hierarchical BOOLEAN NOT NULL DEFAULT false,
	extensibility TEXT NOT NULL,
	maximum_assignments INTEGER,
	resource_types JSONB NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	CONSTRAINT taxonomy_vocabularies_extensibility_check CHECK (extensibility IN ('closed', 'open', 'proposal')),
	CONSTRAINT taxonomy_vocabularies_maximum_check CHECK (maximum_assignments IS NULL OR maximum_assignments > 0)
);

CREATE TABLE IF NOT EXISTS core.taxonomy_terms (
	id UUID PRIMARY KEY,
	vocabulary_id UUID NOT NULL REFERENCES core.taxonomy_vocabularies (id) ON DELETE RESTRICT,
	parent_term_id UUID REFERENCES core.taxonomy_terms (id) ON DELETE RESTRICT,
	term_key TEXT NOT NULL,
	contribution_key TEXT NOT NULL,
	label_resource TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	archived_at TIMESTAMPTZ,
	CONSTRAINT taxonomy_terms_unique UNIQUE (vocabulary_id, term_key)
);

CREATE TABLE IF NOT EXISTS core.taxonomy_term_aliases (
	term_id UUID NOT NULL REFERENCES core.taxonomy_terms (id) ON DELETE RESTRICT,
	locale TEXT NOT NULL,
	alias TEXT NOT NULL,
	PRIMARY KEY (term_id, locale, alias)
);

CREATE TABLE IF NOT EXISTS core.entity_record_terms (
	record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE RESTRICT,
	field_definition_id UUID NOT NULL REFERENCES core.entity_field_definitions (id) ON DELETE RESTRICT,
	term_id UUID NOT NULL REFERENCES core.taxonomy_terms (id) ON DELETE RESTRICT,
	origin TEXT NOT NULL,
	revision BIGINT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (record_id, field_definition_id, term_id),
	CONSTRAINT entity_record_terms_origin_check CHECK (origin IN ('automatic', 'manual')),
	CONSTRAINT entity_record_terms_revision_check CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS core.entity_search_documents (
	record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE RESTRICT,
	locale TEXT NOT NULL,
	audience TEXT NOT NULL,
	revision BIGINT NOT NULL,
	search_text TEXT NOT NULL,
	facets JSONB NOT NULL DEFAULT '{}'::jsonb,
	document_fingerprint TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (record_id, locale, audience),
	CONSTRAINT entity_search_documents_revision_check CHECK (revision > 0)
);

CREATE INDEX IF NOT EXISTS entity_search_documents_lookup_idx ON core.entity_search_documents (locale, audience, record_id);

CREATE TABLE IF NOT EXISTS core.entity_rich_content_anchors (
	record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE RESTRICT,
	field_definition_id UUID NOT NULL REFERENCES core.entity_field_definitions (id) ON DELETE RESTRICT,
	locale TEXT NOT NULL,
	revision BIGINT NOT NULL,
	anchor_key TEXT NOT NULL,
	PRIMARY KEY (record_id, field_definition_id, locale, revision, anchor_key),
	CONSTRAINT entity_rich_content_anchors_revision_check CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS core.entity_import_jobs (
	id UUID PRIMARY KEY,
	document_digest TEXT NOT NULL,
	conflict_policy TEXT NOT NULL,
	status TEXT NOT NULL,
	total_records INTEGER NOT NULL,
	applied_records INTEGER NOT NULL DEFAULT 0,
	created_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT entity_import_jobs_policy_check CHECK (conflict_policy IN ('reject', 'replace', 'skip')),
	CONSTRAINT entity_import_jobs_status_check CHECK (status IN ('completed', 'failed', 'pending', 'running')),
	CONSTRAINT entity_import_jobs_counts_check CHECK (total_records >= 0 AND applied_records BETWEEN 0 AND total_records)
);

CREATE TABLE IF NOT EXISTS core.entity_schema_evolution_plans (
	id UUID PRIMARY KEY,
	resource_kind TEXT NOT NULL,
	resource_identifier TEXT NOT NULL,
	classification TEXT NOT NULL,
	plan JSONB NOT NULL,
	impact JSONB NOT NULL,
	approved_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT entity_schema_evolution_kind_check CHECK (resource_kind IN ('extension', 'field', 'interface', 'relation', 'type')),
	CONSTRAINT entity_schema_evolution_classification_check CHECK (classification IN ('additive', 'conditional', 'incompatible'))
);
