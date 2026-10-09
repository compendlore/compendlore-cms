CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.instances (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT instances_singleton CHECK (id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS instances_singleton_idx ON core.instances ((true));

CREATE TABLE IF NOT EXISTS core.users (
	id UUID PRIMARY KEY,
	login TEXT NOT NULL,
	display_name TEXT NOT NULL,
	password_digest TEXT NOT NULL,
	is_founder BOOLEAN NOT NULL DEFAULT false,
	is_active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT users_login_normalized CHECK (login = lower(login)),
	CONSTRAINT users_login_not_empty CHECK (length(btrim(login)) > 0),
	CONSTRAINT users_display_name_not_empty CHECK (length(btrim(display_name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_login_idx ON core.users (login);
CREATE UNIQUE INDEX IF NOT EXISTS users_single_founder_idx ON core.users (is_founder) WHERE is_founder;

CREATE TABLE IF NOT EXISTS core.sessions (
	id UUID PRIMARY KEY,
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	token_digest TEXT NOT NULL UNIQUE,
	created_at TIMESTAMPTZ NOT NULL,
	expires_at TIMESTAMPTZ NOT NULL,
	revoked_at TIMESTAMPTZ,
	second_factor_verified_at TIMESTAMPTZ,
	CONSTRAINT sessions_expiration_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON core.sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiration_idx ON core.sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS core.two_factor (
	user_id UUID PRIMARY KEY REFERENCES core.users (id) ON DELETE CASCADE,
	secret_ciphertext TEXT NOT NULL,
	enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.two_factor_recovery_codes (
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	code_digest TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	consumed_at TIMESTAMPTZ,
	PRIMARY KEY (user_id, code_digest)
);

CREATE TABLE IF NOT EXISTS core.roles (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	identifier TEXT NOT NULL UNIQUE,
	display_name TEXT NOT NULL,
	is_protected BOOLEAN NOT NULL DEFAULT false,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.capabilities (
	identifier TEXT PRIMARY KEY,
	description TEXT NOT NULL DEFAULT '',
	is_core BOOLEAN NOT NULL DEFAULT false,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.role_capabilities (
	role_id UUID NOT NULL REFERENCES core.roles (id) ON DELETE CASCADE,
	capability_identifier TEXT NOT NULL REFERENCES core.capabilities (identifier) ON DELETE CASCADE,
	PRIMARY KEY (role_id, capability_identifier)
);

CREATE TABLE IF NOT EXISTS core.user_roles (
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	role_id UUID NOT NULL REFERENCES core.roles (id) ON DELETE CASCADE,
	PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS core.user_capabilities (
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	capability_identifier TEXT NOT NULL REFERENCES core.capabilities (identifier) ON DELETE CASCADE,
	PRIMARY KEY (user_id, capability_identifier)
);

CREATE INDEX IF NOT EXISTS role_capabilities_capability_idx ON core.role_capabilities (capability_identifier);
CREATE INDEX IF NOT EXISTS user_roles_role_idx ON core.user_roles (role_id);

CREATE TABLE IF NOT EXISTS core.audit_log (
	id UUID PRIMARY KEY,
	occurred_at TIMESTAMPTZ NOT NULL,
	action TEXT NOT NULL,
	outcome TEXT NOT NULL,
	actor_id UUID REFERENCES core.users (id) ON DELETE SET NULL,
	subject_id UUID REFERENCES core.users (id) ON DELETE SET NULL,
	correlation_id TEXT NOT NULL,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	CONSTRAINT audit_outcome_allowed CHECK (outcome IN ('allowed', 'denied', 'failed'))
);

CREATE INDEX IF NOT EXISTS audit_log_occurred_idx ON core.audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON core.audit_log (actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_correlation_idx ON core.audit_log (correlation_id);

CREATE TABLE IF NOT EXISTS core.schema_journal (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	scope TEXT NOT NULL,
	version TEXT NOT NULL,
	checksum TEXT NOT NULL,
	applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	UNIQUE (scope, version)
);

CREATE TABLE IF NOT EXISTS core.secret_references (
	identifier TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	reference TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.tasks (
	id UUID PRIMARY KEY,
	type TEXT NOT NULL,
	payload JSONB NOT NULL DEFAULT '{}'::jsonb,
	status TEXT NOT NULL DEFAULT 'pending',
	execute_at TIMESTAMPTZ NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT tasks_status_allowed CHECK (status IN ('pending', 'running', 'completed', 'failed')),
	CONSTRAINT tasks_attempts_positive CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS tasks_due_idx ON core.tasks (execute_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS core.events (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	topic TEXT NOT NULL,
	payload JSONB NOT NULL DEFAULT '{}'::jsonb,
	occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_topic_idx ON core.events (topic, occurred_at DESC);

CREATE TABLE IF NOT EXISTS core.communications (
	id UUID PRIMARY KEY,
	mode TEXT NOT NULL,
	topic TEXT NOT NULL,
	target JSONB NOT NULL,
	payload JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL,
	acknowledgement_deadline_ms INTEGER,
	retry_limit INTEGER,
	CONSTRAINT communications_mode_allowed CHECK (mode IN ('broadcast', 'direct', 'event')),
	CONSTRAINT communications_ack_positive CHECK (acknowledgement_deadline_ms IS NULL OR acknowledgement_deadline_ms > 0),
	CONSTRAINT communications_retry_positive CHECK (retry_limit IS NULL OR retry_limit >= 0)
);

CREATE INDEX IF NOT EXISTS communications_created_idx ON core.communications (created_at DESC);

CREATE TABLE IF NOT EXISTS core.communication_receipts (
	communication_id UUID NOT NULL REFERENCES core.communications (id) ON DELETE CASCADE,
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	delivered_at TIMESTAMPTZ,
	acknowledged_at TIMESTAMPTZ,
	retry_count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (communication_id, user_id),
	CONSTRAINT communication_retry_positive CHECK (retry_count >= 0)
);

CREATE TABLE IF NOT EXISTS core.outbound_policies (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	host TEXT NOT NULL,
	allowed_methods TEXT[] NOT NULL,
	is_active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	UNIQUE (host)
);

CREATE TABLE IF NOT EXISTS core.object_metadata (
	object_key TEXT PRIMARY KEY,
	content_type TEXT NOT NULL,
	byte_size BIGINT NOT NULL,
	checksum TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT object_size_positive CHECK (byte_size >= 0)
);
