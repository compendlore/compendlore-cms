CREATE TABLE IF NOT EXISTS core.entity_field_types (
	id UUID PRIMARY KEY,
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	storage_family TEXT NOT NULL,
	configuration_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
	allows_localization BOOLEAN NOT NULL DEFAULT false,
	allows_multiple BOOLEAN NOT NULL DEFAULT false,
	extensible BOOLEAN NOT NULL DEFAULT false,
	definition_fingerprint TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	archived_at TIMESTAMPTZ,
	CONSTRAINT entity_field_types_identifier_check CHECK (identifier ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'),
	CONSTRAINT entity_field_types_owner_check CHECK (contribution_key ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'),
	CONSTRAINT entity_field_types_storage_check CHECK (storage_family IN ('boolean', 'decimal', 'integer', 'json', 'relation', 'text', 'uuid'))
);

CREATE TABLE IF NOT EXISTS core.entity_types (
	id UUID PRIMARY KEY,
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	parent_type_id UUID REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	abstract BOOLEAN NOT NULL DEFAULT false,
	final BOOLEAN NOT NULL DEFAULT false,
	allows_extensions BOOLEAN NOT NULL DEFAULT false,
	locked BOOLEAN NOT NULL DEFAULT false,
	identifier_policy JSONB NOT NULL,
	definition_fingerprint TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	archived_at TIMESTAMPTZ,
	CONSTRAINT entity_types_identifier_check CHECK (identifier ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'),
	CONSTRAINT entity_types_owner_check CHECK (contribution_key ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'),
	CONSTRAINT entity_types_root_check CHECK ((identifier = 'entity' AND parent_type_id IS NULL AND abstract AND locked) OR identifier <> 'entity'),
	CONSTRAINT entity_types_flags_check CHECK (NOT (abstract AND final))
);

CREATE INDEX IF NOT EXISTS entity_types_parent_idx ON core.entity_types (parent_type_id) WHERE active;

CREATE TABLE IF NOT EXISTS core.entity_type_versions (
	id UUID PRIMARY KEY,
	entity_type_id UUID NOT NULL REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	version INTEGER NOT NULL,
	status TEXT NOT NULL,
	effective_definition JSONB NOT NULL,
	definition_fingerprint TEXT NOT NULL,
	created_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	published_at TIMESTAMPTZ,
	CONSTRAINT entity_type_versions_unique UNIQUE (entity_type_id, version),
	CONSTRAINT entity_type_versions_version_check CHECK (version > 0),
	CONSTRAINT entity_type_versions_status_check CHECK (status IN ('draft', 'published', 'superseded', 'archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS entity_type_versions_published_idx ON core.entity_type_versions (entity_type_id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS core.entity_field_definitions (
	id UUID PRIMARY KEY,
	entity_type_id UUID NOT NULL REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	contribution_key TEXT NOT NULL,
	field_key TEXT NOT NULL,
	field_type_id UUID NOT NULL REFERENCES core.entity_field_types (id) ON DELETE RESTRICT,
	required BOOLEAN NOT NULL DEFAULT false,
	localized BOOLEAN NOT NULL DEFAULT false,
	multiple BOOLEAN NOT NULL DEFAULT false,
	position INTEGER NOT NULL,
	configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
	query_capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
	definition_fingerprint TEXT NOT NULL,
	archived_at TIMESTAMPTZ,
	CONSTRAINT entity_field_definitions_unique UNIQUE (entity_type_id, field_key),
	CONSTRAINT entity_field_definitions_key_check CHECK (field_key ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'),
	CONSTRAINT entity_field_definitions_position_check CHECK (position >= 0)
);

CREATE TABLE IF NOT EXISTS core.entity_relation_definitions (
	id UUID PRIMARY KEY,
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	source_type_id UUID NOT NULL REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	target_type_id UUID NOT NULL REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	cardinality TEXT NOT NULL,
	directed BOOLEAN NOT NULL DEFAULT true,
	withdrawal_policy TEXT NOT NULL DEFAULT 'restrict',
	definition JSONB NOT NULL,
	definition_fingerprint TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	CONSTRAINT entity_relations_cardinality_check CHECK (cardinality IN ('one-to-one', 'one-to-many', 'many-to-many')),
	CONSTRAINT entity_relations_withdrawal_check CHECK (withdrawal_policy IN ('restrict', 'detach', 'archive'))
);

CREATE TABLE IF NOT EXISTS core.entity_interfaces (
	id UUID PRIMARY KEY,
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	entity_type_id UUID NOT NULL REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	usage TEXT NOT NULL,
	version INTEGER NOT NULL,
	definition JSONB NOT NULL,
	definition_fingerprint TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	CONSTRAINT entity_interfaces_usage_check CHECK (usage IN ('create', 'edit', 'detail', 'summary', 'list-item', 'select')),
	CONSTRAINT entity_interfaces_version_check CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS core.entity_records (
	record_id UUID PRIMARY KEY,
	entity_type_id UUID NOT NULL REFERENCES core.entity_types (id) ON DELETE RESTRICT,
	entity_type_version INTEGER NOT NULL,
	public_identifier TEXT NOT NULL,
	editorial_status TEXT NOT NULL DEFAULT 'draft',
	revision BIGINT NOT NULL DEFAULT 1,
	created_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	updated_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	archived_at TIMESTAMPTZ,
	CONSTRAINT entity_records_identifier_unique UNIQUE (entity_type_id, public_identifier),
	CONSTRAINT entity_records_version_check CHECK (entity_type_version > 0),
	CONSTRAINT entity_records_revision_check CHECK (revision > 0),
	CONSTRAINT entity_records_status_check CHECK (editorial_status IN ('draft', 'review', 'scheduled', 'published', 'archived'))
);

CREATE INDEX IF NOT EXISTS entity_records_type_status_idx ON core.entity_records (entity_type_id, editorial_status, record_id);

CREATE TABLE IF NOT EXISTS core.entity_revisions (
	id UUID PRIMARY KEY,
	record_id UUID NOT NULL REFERENCES core.entity_records (record_id) ON DELETE RESTRICT,
	revision BIGINT NOT NULL,
	entity_type_version INTEGER NOT NULL,
	snapshot JSONB NOT NULL,
	created_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	restored_from_revision BIGINT,
	CONSTRAINT entity_revisions_unique UNIQUE (record_id, revision),
	CONSTRAINT entity_revisions_revision_check CHECK (revision > 0),
	CONSTRAINT entity_revisions_type_version_check CHECK (entity_type_version > 0)
);
