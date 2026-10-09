CREATE TABLE IF NOT EXISTS core.user_email_addresses (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	email TEXT NOT NULL,
	normalized_email TEXT NOT NULL,
	is_primary BOOLEAN NOT NULL DEFAULT false,
	verified_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT user_email_address_not_empty CHECK (length(btrim(email)) > 0),
	CONSTRAINT user_email_normalized CHECK (normalized_email = lower(btrim(normalized_email)))
);

CREATE UNIQUE INDEX IF NOT EXISTS user_email_addresses_normalized_idx
	ON core.user_email_addresses (normalized_email);
CREATE UNIQUE INDEX IF NOT EXISTS user_email_addresses_primary_idx
	ON core.user_email_addresses (user_id)
	WHERE is_primary;

CREATE TABLE IF NOT EXISTS core.security_tokens (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id UUID REFERENCES core.users (id) ON DELETE CASCADE,
	purpose TEXT NOT NULL,
	token_digest TEXT NOT NULL UNIQUE,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	expires_at TIMESTAMPTZ NOT NULL,
	consumed_at TIMESTAMPTZ,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	CONSTRAINT security_tokens_purpose_allowed CHECK (
		purpose IN (
			'account-activation',
			'email-verification',
			'password-reset',
			'two-factor-reset'
		)
	),
	CONSTRAINT security_tokens_expiration_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS security_tokens_user_idx
	ON core.security_tokens (user_id, purpose);
CREATE INDEX IF NOT EXISTS security_tokens_expiration_idx
	ON core.security_tokens (expires_at)
	WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS core.user_passkeys (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	credential_id BYTEA NOT NULL UNIQUE,
	public_key BYTEA NOT NULL,
	sign_count BIGINT NOT NULL DEFAULT 0,
	transports TEXT[] NOT NULL DEFAULT '{}',
	device_type TEXT NOT NULL,
	backed_up BOOLEAN NOT NULL DEFAULT false,
	display_name TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	last_used_at TIMESTAMPTZ,
	CONSTRAINT user_passkeys_sign_count_positive CHECK (sign_count >= 0),
	CONSTRAINT user_passkeys_device_type_allowed CHECK (device_type IN ('single-device', 'multi-device')),
	CONSTRAINT user_passkeys_display_name_not_empty CHECK (length(btrim(display_name)) > 0)
);

CREATE INDEX IF NOT EXISTS user_passkeys_user_idx ON core.user_passkeys (user_id);

CREATE TABLE IF NOT EXISTS core.webauthn_challenges (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id UUID REFERENCES core.users (id) ON DELETE CASCADE,
	session_id UUID REFERENCES core.sessions (id) ON DELETE CASCADE,
	purpose TEXT NOT NULL,
	challenge_digest TEXT NOT NULL UNIQUE,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	expires_at TIMESTAMPTZ NOT NULL,
	consumed_at TIMESTAMPTZ,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	CONSTRAINT webauthn_challenges_purpose_allowed CHECK (purpose IN ('authentication', 'registration')),
	CONSTRAINT webauthn_challenges_expiration_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS webauthn_challenges_expiration_idx
	ON core.webauthn_challenges (expires_at)
	WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS core.session_device_proofs (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	session_id UUID NOT NULL REFERENCES core.sessions (id) ON DELETE CASCADE,
	device_identifier_digest TEXT NOT NULL,
	proof_digest TEXT NOT NULL UNIQUE,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	expires_at TIMESTAMPTZ NOT NULL,
	last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	revoked_at TIMESTAMPTZ,
	CONSTRAINT session_device_proofs_expiration_after_creation CHECK (expires_at > created_at),
	UNIQUE (session_id, device_identifier_digest)
);

CREATE INDEX IF NOT EXISTS session_device_proofs_expiration_idx
	ON core.session_device_proofs (expires_at)
	WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS core.capability_implications (
	capability_identifier TEXT NOT NULL REFERENCES core.capabilities (identifier) ON DELETE CASCADE,
	implied_capability_identifier TEXT NOT NULL REFERENCES core.capabilities (identifier) ON DELETE CASCADE,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (capability_identifier, implied_capability_identifier),
	CONSTRAINT capability_implications_not_self CHECK (
		capability_identifier <> implied_capability_identifier
	)
);

CREATE INDEX IF NOT EXISTS capability_implications_implied_idx
	ON core.capability_implications (implied_capability_identifier);

CREATE TABLE IF NOT EXISTS core.role_incompatibilities (
	lower_role_id UUID NOT NULL REFERENCES core.roles (id) ON DELETE CASCADE,
	upper_role_id UUID NOT NULL REFERENCES core.roles (id) ON DELETE CASCADE,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (lower_role_id, upper_role_id),
	CONSTRAINT role_incompatibilities_canonical_order CHECK (lower_role_id < upper_role_id)
);

CREATE TABLE IF NOT EXISTS core.user_bans (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	reason TEXT NOT NULL,
	starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	expires_at TIMESTAMPTZ,
	created_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	revoked_at TIMESTAMPTZ,
	revoked_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	CONSTRAINT user_bans_reason_not_empty CHECK (length(btrim(reason)) > 0),
	CONSTRAINT user_bans_expiration_after_start CHECK (expires_at IS NULL OR expires_at > starts_at)
);

CREATE INDEX IF NOT EXISTS user_bans_active_idx
	ON core.user_bans (user_id, starts_at DESC)
	WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS core.ip_bans (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	address_digest TEXT NOT NULL,
	reason TEXT NOT NULL,
	starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	expires_at TIMESTAMPTZ,
	created_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	revoked_at TIMESTAMPTZ,
	revoked_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	CONSTRAINT ip_bans_reason_not_empty CHECK (length(btrim(reason)) > 0),
	CONSTRAINT ip_bans_expiration_after_start CHECK (expires_at IS NULL OR expires_at > starts_at)
);

CREATE INDEX IF NOT EXISTS ip_bans_active_idx
	ON core.ip_bans (address_digest, starts_at DESC)
	WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS core.security_attempts (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	kind TEXT NOT NULL,
	subject_digest TEXT,
	address_digest TEXT,
	outcome TEXT NOT NULL,
	occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	CONSTRAINT security_attempts_kind_not_empty CHECK (length(btrim(kind)) > 0),
	CONSTRAINT security_attempts_outcome_allowed CHECK (
		outcome IN ('allowed', 'succeeded', 'failed', 'blocked')
	)
);

CREATE INDEX IF NOT EXISTS security_attempts_subject_idx
	ON core.security_attempts (kind, subject_digest, occurred_at DESC);
CREATE INDEX IF NOT EXISTS security_attempts_address_idx
	ON core.security_attempts (kind, address_digest, occurred_at DESC);

CREATE TABLE IF NOT EXISTS core.user_preferences (
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	preference_key TEXT NOT NULL,
	value JSONB NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, preference_key),
	CONSTRAINT user_preferences_key_not_empty CHECK (length(btrim(preference_key)) > 0)
);

CREATE TABLE IF NOT EXISTS core.instance_settings (
	setting_key TEXT PRIMARY KEY,
	value JSONB NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT instance_settings_key_not_empty CHECK (length(btrim(setting_key)) > 0)
);

CREATE TABLE IF NOT EXISTS core.installation_state (
	instance_id UUID PRIMARY KEY REFERENCES core.instances (id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'pending',
	bootstrap_version INTEGER NOT NULL DEFAULT 1,
	lock_owner TEXT,
	locked_at TIMESTAMPTZ,
	completed_at TIMESTAMPTZ,
	failure_code TEXT,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT installation_state_status_allowed CHECK (
		status IN ('pending', 'in-progress', 'completed', 'failed')
	),
	CONSTRAINT installation_state_version_positive CHECK (bootstrap_version > 0),
	CONSTRAINT installation_state_lock_complete CHECK (
		(lock_owner IS NULL AND locked_at IS NULL)
		OR (lock_owner IS NOT NULL AND locked_at IS NOT NULL)
	)
);
