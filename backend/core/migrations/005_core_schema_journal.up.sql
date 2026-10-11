CREATE TABLE IF NOT EXISTS core.contribution_schema_journal (
	id UUID PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	owner_identifier TEXT NOT NULL,
	version TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	desired_state TEXT NOT NULL,
	applied_state TEXT NOT NULL,
	observed_state TEXT NOT NULL,
	plan JSONB NOT NULL,
	error TEXT,
	requested_at TIMESTAMPTZ NOT NULL,
	applied_at TIMESTAMPTZ,
	CONSTRAINT contribution_schema_journal_desired_state_check CHECK (
		desired_state IN ('absent', 'active', 'archived', 'preserved')
	),
	CONSTRAINT contribution_schema_journal_applied_state_check CHECK (
		applied_state IN ('applied', 'failed', 'pending', 'rolled-back')
	),
	CONSTRAINT contribution_schema_journal_observed_state_check CHECK (
		observed_state IN ('absent', 'active', 'archived', 'unknown')
	)
);

CREATE INDEX IF NOT EXISTS contribution_schema_journal_contribution_requested_idx
	ON core.contribution_schema_journal (contribution_key, requested_at DESC);

CREATE INDEX IF NOT EXISTS contribution_schema_journal_fingerprint_idx
	ON core.contribution_schema_journal (fingerprint);

CREATE SCHEMA IF NOT EXISTS cms_data;
