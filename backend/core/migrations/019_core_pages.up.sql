CREATE TABLE IF NOT EXISTS core.pages (
	id UUID PRIMARY KEY,
	identifier TEXT NOT NULL UNIQUE,
	contribution_key TEXT NOT NULL,
	surface TEXT NOT NULL,
	export_policy TEXT NOT NULL,
	lifecycle_policy JSONB NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT pages_surface_check CHECK (surface IN ('site', 'account', 'administration', 'system')),
	CONSTRAINT pages_export_policy_check CHECK (export_policy IN ('exportable', 'locked'))
);

CREATE TABLE IF NOT EXISTS core.page_versions (
	id UUID PRIMARY KEY,
	page_id UUID NOT NULL REFERENCES core.pages (id) ON DELETE RESTRICT,
	revision BIGINT NOT NULL,
	contract_version TEXT NOT NULL,
	component_identifier TEXT NOT NULL,
	title_text_id UUID NOT NULL REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	required_capabilities TEXT[] NOT NULL DEFAULT '{}',
	definition JSONB NOT NULL,
	fingerprint TEXT NOT NULL,
	created_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT page_versions_revision_check CHECK (revision > 0),
	CONSTRAINT page_versions_unique UNIQUE (page_id, revision)
);

CREATE TABLE IF NOT EXISTS core.page_routes (
	id UUID PRIMARY KEY,
	page_id UUID NOT NULL REFERENCES core.pages (id) ON DELETE RESTRICT,
	surface TEXT NOT NULL,
	path TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT page_routes_surface_check CHECK (surface IN ('site', 'account', 'administration', 'system')),
	CONSTRAINT page_routes_path_check CHECK (path LIKE '/%'),
	CONSTRAINT page_routes_unique UNIQUE (surface, path)
);

CREATE INDEX IF NOT EXISTS page_routes_active_lookup_idx ON core.page_routes (surface, path) WHERE active;

CREATE TABLE IF NOT EXISTS core.page_publications (
	id UUID PRIMARY KEY,
	page_id UUID NOT NULL REFERENCES core.pages (id) ON DELETE RESTRICT,
	page_version_id UUID NOT NULL UNIQUE REFERENCES core.page_versions (id) ON DELETE RESTRICT,
	state TEXT NOT NULL,
	published_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	published_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT page_publications_state_check CHECK (state IN ('draft', 'published', 'archived')),
	CONSTRAINT page_publications_published_check CHECK (
		(state = 'published' AND published_at IS NOT NULL)
		OR (state <> 'published' AND published_at IS NULL)
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS page_publications_one_active_idx ON core.page_publications (page_id) WHERE state = 'published';

CREATE TABLE IF NOT EXISTS core.page_imports (
	id UUID PRIMARY KEY,
	requested_by UUID NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
	document_fingerprint TEXT NOT NULL,
	preview JSONB NOT NULL,
	state TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	applied_at TIMESTAMPTZ,
	CONSTRAINT page_imports_state_check CHECK (state IN ('previewed', 'applied', 'rejected'))
);
