\set ON_ERROR_STOP on

DO $$
DECLARE
	missing_tables TEXT;
	missing_constraints TEXT;
	missing_indexes TEXT;
BEGIN
	SELECT string_agg(required.name, ', ' ORDER BY required.name)
	INTO missing_tables
	FROM unnest(ARRAY[
		'instances',
		'users',
		'sessions',
		'two_factor',
		'two_factor_recovery_codes',
		'roles',
		'capabilities',
		'role_capabilities',
		'user_roles',
		'user_capabilities',
		'audit_log',
		'schema_journal',
		'user_email_addresses',
		'security_tokens',
		'user_passkeys',
		'webauthn_challenges',
		'session_device_proofs',
		'capability_implications',
		'role_incompatibilities',
		'user_bans',
		'ip_bans',
		'security_attempts',
		'user_preferences',
		'instance_settings',
		'installation_state',
		'installation_tokens'
	]) AS required(name)
	WHERE NOT EXISTS (
		SELECT 1
		FROM pg_catalog.pg_tables actual
		WHERE actual.schemaname = 'core'
			AND actual.tablename = required.name
	);

	IF missing_tables IS NOT NULL THEN
		RAISE EXCEPTION 'Missing Core tables: %', missing_tables;
	END IF;

	SELECT string_agg(required.name, ', ' ORDER BY required.name)
	INTO missing_constraints
	FROM unnest(ARRAY[
		'sessions_expiration_after_creation',
		'audit_outcome_allowed',
		'security_tokens_expiration_after_creation',
		'user_passkeys_sign_count_positive',
		'capability_implications_not_self',
		'role_incompatibilities_canonical_order',
		'installation_state_lock_complete'
	]) AS required(name)
	WHERE NOT EXISTS (
		SELECT 1
		FROM pg_catalog.pg_constraint actual
		WHERE actual.connamespace = 'core'::regnamespace
			AND actual.conname = required.name
	);

	IF missing_constraints IS NOT NULL THEN
		RAISE EXCEPTION 'Missing Core constraints: %', missing_constraints;
	END IF;

	SELECT string_agg(required.name, ', ' ORDER BY required.name)
	INTO missing_indexes
	FROM unnest(ARRAY[
		'instances_singleton_idx',
		'users_login_idx',
		'users_single_founder_idx',
		'sessions_user_idx',
		'sessions_expiration_idx',
		'audit_log_occurred_idx',
		'audit_log_actor_idx',
		'audit_log_correlation_idx',
		'user_email_addresses_normalized_idx',
		'user_email_addresses_primary_idx',
		'security_tokens_expiration_idx'
	]) AS required(name)
	WHERE NOT EXISTS (
		SELECT 1
		FROM pg_catalog.pg_indexes actual
		WHERE actual.schemaname = 'core'
			AND actual.indexname = required.name
	);

	IF missing_indexes IS NOT NULL THEN
		RAISE EXCEPTION 'Missing Core indexes: %', missing_indexes;
	END IF;
END
$$;

BEGIN;

INSERT INTO core.users (
	id,
	login,
	display_name,
	password_digest,
	is_founder,
	is_active,
	created_at
)
VALUES (
	'31000000-0000-4000-8000-000000000001',
	'phase-3-2-validation',
	'Phase 3.2 Validation',
	'test-password-digest',
	false,
	true,
	now()
);

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM core.users WHERE is_founder) THEN
		INSERT INTO core.users (
			id,
			login,
			display_name,
			password_digest,
			is_founder,
			is_active,
			created_at
		)
		VALUES (
			'31000000-0000-4000-8000-000000000002',
			'phase-3-2-first-founder',
			'First Founder',
			'test-password-digest',
			true,
			true,
			now()
		);
	END IF;

	BEGIN
		INSERT INTO core.users (
			id,
			login,
			display_name,
			password_digest,
			is_founder,
			is_active,
			created_at
		)
		VALUES (
			'31000000-0000-4000-8000-000000000003',
			'phase-3-2-second-founder',
			'Second Founder',
			'test-password-digest',
			true,
			true,
			now()
		);
		RAISE EXCEPTION 'The single-founder constraint accepted a second founder';
	EXCEPTION
		WHEN unique_violation THEN NULL;
	END;

	BEGIN
		INSERT INTO core.sessions (id, user_id, token_digest, created_at, expires_at)
		VALUES (
			'32000000-0000-4000-8000-000000000001',
			'31000000-0000-4000-8000-000000000001',
			'phase-3-2-invalid-session',
			now(),
			now() - interval '1 minute'
		);
		RAISE EXCEPTION 'The session chronology constraint accepted an invalid session';
	EXCEPTION
		WHEN check_violation THEN NULL;
	END;
END
$$;

INSERT INTO core.roles (id, identifier, display_name, is_protected)
VALUES (
	'33000000-0000-4000-8000-000000000001',
	'core.phase-3-2-role',
	'Phase 3.2 role',
	false
);

INSERT INTO core.capabilities (identifier, description, is_core)
VALUES ('core.phase-3-2-capability', 'Phase 3.2 capability', true);

INSERT INTO core.role_capabilities (role_id, capability_identifier)
VALUES (
	'33000000-0000-4000-8000-000000000001',
	'core.phase-3-2-capability'
);

INSERT INTO core.user_roles (user_id, role_id)
VALUES (
	'31000000-0000-4000-8000-000000000001',
	'33000000-0000-4000-8000-000000000001'
);

INSERT INTO core.two_factor (user_id, secret_ciphertext)
VALUES (
	'31000000-0000-4000-8000-000000000001',
	'test-encrypted-secret'
);

INSERT INTO core.audit_log (
	id,
	occurred_at,
	action,
	outcome,
	actor_id,
	correlation_id
)
VALUES (
	'34000000-0000-4000-8000-000000000001',
	now(),
	'phase-3-2.validation',
	'allowed',
	'31000000-0000-4000-8000-000000000001',
	'phase-3-2-validation'
);

ROLLBACK;

SELECT 'Core schema validation succeeded.' AS result;
