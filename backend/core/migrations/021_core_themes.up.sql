CREATE TABLE IF NOT EXISTS core.themes (
	id UUID PRIMARY KEY,
	identifier TEXT NOT NULL UNIQUE,
	owner_identifier TEXT NOT NULL,
	kind TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT themes_kind_check CHECK (kind IN ('full-theme', 'theme-extension', 'component-style'))
);

CREATE TABLE IF NOT EXISTS core.theme_revisions (
	id UUID PRIMARY KEY,
	theme_id UUID NOT NULL REFERENCES core.themes (id) ON DELETE RESTRICT,
	revision BIGINT NOT NULL,
	design_system_version TEXT NOT NULL,
	contract JSONB NOT NULL,
	token_schema JSONB NOT NULL DEFAULT '{}',
	typography_roles JSONB NOT NULL DEFAULT '{}',
	brand_document JSONB,
	fingerprint TEXT NOT NULL,
	created_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT theme_revisions_revision_check CHECK (revision > 0),
	CONSTRAINT theme_revisions_fingerprint_check CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
	CONSTRAINT theme_revisions_unique UNIQUE (theme_id, revision)
);

CREATE TABLE IF NOT EXISTS core.theme_asset_references (
	theme_revision_id UUID NOT NULL REFERENCES core.theme_revisions (id) ON DELETE RESTRICT,
	asset_identifier TEXT NOT NULL,
	asset_digest TEXT NOT NULL,
	analysis_evidence_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (theme_revision_id, asset_identifier),
	CONSTRAINT theme_asset_identifier_check CHECK (
		asset_identifier ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
	),
	CONSTRAINT theme_asset_digest_check CHECK (asset_digest ~ '^[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS core.theme_publications (
	id UUID PRIMARY KEY,
	theme_id UUID NOT NULL REFERENCES core.themes (id) ON DELETE RESTRICT,
	theme_revision_id UUID NOT NULL REFERENCES core.theme_revisions (id) ON DELETE RESTRICT,
	state TEXT NOT NULL,
	published_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	published_at TIMESTAMPTZ,
	restored_from_revision BIGINT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT theme_publications_state_check CHECK (state IN ('draft', 'published', 'archived')),
	CONSTRAINT theme_publications_published_check CHECK (
		(state = 'published' AND published_at IS NOT NULL)
		OR (state <> 'published' AND published_at IS NULL)
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS theme_publications_one_active_idx
	ON core.theme_publications (theme_id)
	WHERE state = 'published';

CREATE TABLE IF NOT EXISTS core.theme_assignments (
	id UUID PRIMARY KEY,
	identifier TEXT NOT NULL UNIQUE,
	surface TEXT NOT NULL,
	mode TEXT NOT NULL,
	current_revision BIGINT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT theme_assignments_surface_check CHECK (
		surface IN ('site', 'administration', 'editor-preview', 'recovery')
	),
	CONSTRAINT theme_assignments_mode_check CHECK (
		mode IN ('default', 'light', 'dark', 'high-contrast')
	),
	CONSTRAINT theme_assignments_revision_check CHECK (current_revision > 0),
	CONSTRAINT theme_assignments_context_unique UNIQUE (surface, mode)
);

CREATE TABLE IF NOT EXISTS core.theme_assignment_revisions (
	id UUID PRIMARY KEY,
	assignment_id UUID NOT NULL REFERENCES core.theme_assignments (id) ON DELETE RESTRICT,
	revision BIGINT NOT NULL,
	base_theme_id UUID NOT NULL REFERENCES core.themes (id) ON DELETE RESTRICT,
	base_theme_revision_id UUID NOT NULL REFERENCES core.theme_revisions (id) ON DELETE RESTRICT,
	layers JSONB NOT NULL DEFAULT '[]',
	preferences JSONB NOT NULL DEFAULT '[]',
	created_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT theme_assignment_revisions_revision_check CHECK (revision > 0),
	CONSTRAINT theme_assignment_revisions_unique UNIQUE (assignment_id, revision)
);

CREATE TABLE IF NOT EXISTS core.theme_projection_cache (
	id UUID PRIMARY KEY,
	assignment_revision_id UUID NOT NULL REFERENCES core.theme_assignment_revisions (id) ON DELETE CASCADE,
	locale TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	compatibility JSONB NOT NULL,
	projection JSONB NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	invalidated_at TIMESTAMPTZ,
	CONSTRAINT theme_projection_fingerprint_check CHECK (fingerprint ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS theme_projection_cache_active_idx
	ON core.theme_projection_cache (assignment_revision_id, locale)
	WHERE invalidated_at IS NULL;

CREATE INDEX IF NOT EXISTS theme_assignment_surface_lookup_idx
	ON core.theme_assignments (surface, mode, current_revision);

CREATE INDEX IF NOT EXISTS theme_revision_lookup_idx
	ON core.theme_revisions (theme_id, revision DESC);
