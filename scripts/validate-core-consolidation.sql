\set ON_ERROR_STOP on

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
	'36000000-0000-4000-8000-000000000001',
	'phase-3-6-validation',
	'Phase 3.6 Validation',
	'test-password-digest',
	false,
	true,
	now()
);

INSERT INTO core.user_email_addresses (
	id,
	user_id,
	email,
	normalized_email,
	is_primary
)
VALUES (
	'36000000-0000-4000-8000-000000000002',
	'36000000-0000-4000-8000-000000000001',
	'validation@example.test',
	'validation@example.test',
	true
);

INSERT INTO core.security_tokens (
	id,
	user_id,
	purpose,
	token_digest,
	created_at,
	expires_at
)
VALUES (
	'36000000-0000-4000-8000-000000000003',
	'36000000-0000-4000-8000-000000000001',
	'password-reset',
	'phase-3-6-token',
	now(),
	now() + INTERVAL '5 minutes'
);

INSERT INTO core.user_passkeys (
	id,
	user_id,
	credential_id,
	public_key,
	sign_count,
	device_type,
	display_name
)
VALUES (
	'36000000-0000-4000-8000-000000000004',
	'36000000-0000-4000-8000-000000000001',
	decode('360004', 'hex'),
	decode('360005', 'hex'),
	0,
	'single-device',
	'Validation passkey'
);

INSERT INTO core.sessions (id, user_id, token_digest, created_at, expires_at)
VALUES (
	'36000000-0000-4000-8000-000000000005',
	'36000000-0000-4000-8000-000000000001',
	'phase-3-6-session',
	now(),
	now() + INTERVAL '5 minutes'
);

INSERT INTO core.session_device_proofs (
	id,
	session_id,
	device_identifier_digest,
	proof_digest,
	created_at,
	expires_at
)
VALUES (
	'36000000-0000-4000-8000-000000000006',
	'36000000-0000-4000-8000-000000000005',
	'phase-3-6-device',
	'phase-3-6-proof',
	now(),
	now() + INTERVAL '5 minutes'
);

INSERT INTO core.capabilities (identifier, description, is_core)
VALUES
	('core.phase-3-6.source', 'Validation source', true),
	('core.phase-3-6.implied', 'Validation implied', true);

INSERT INTO core.capability_implications (capability_identifier, implied_capability_identifier)
VALUES ('core.phase-3-6.source', 'core.phase-3-6.implied');

INSERT INTO core.roles (id, identifier, display_name, is_protected)
VALUES
	('36000000-0000-4000-8000-000000000010', 'core.phase-3-6.first', 'First role', false),
	('36000000-0000-4000-8000-000000000011', 'core.phase-3-6.second', 'Second role', false);

INSERT INTO core.role_incompatibilities (lower_role_id, upper_role_id)
VALUES (
	'36000000-0000-4000-8000-000000000010',
	'36000000-0000-4000-8000-000000000011'
);

INSERT INTO core.user_bans (id, user_id, reason)
VALUES (
	'36000000-0000-4000-8000-000000000012',
	'36000000-0000-4000-8000-000000000001',
	'Validation ban'
);

INSERT INTO core.ip_bans (id, address_digest, reason)
VALUES (
	'36000000-0000-4000-8000-000000000013',
	'phase-3-6-address',
	'Validation address ban'
);

INSERT INTO core.security_attempts (id, kind, subject_digest, outcome)
VALUES (
	'36000000-0000-4000-8000-000000000014',
	'login',
	'phase-3-6-subject',
	'succeeded'
);

INSERT INTO core.user_preferences (user_id, preference_key, value)
VALUES (
	'36000000-0000-4000-8000-000000000001',
	'core.validation.preference',
	'true'::jsonb
);

INSERT INTO core.instance_settings (setting_key, value)
VALUES ('core.validation.setting', 'false'::jsonb);

DO $$
DECLARE
	current_instance_id UUID;
BEGIN
	SELECT id INTO STRICT current_instance_id FROM core.instances LIMIT 1;
	INSERT INTO core.installation_state (instance_id, status, bootstrap_version)
	VALUES (current_instance_id, 'pending', 1)
	ON CONFLICT (instance_id) DO UPDATE
	SET status = 'pending', lock_owner = NULL, locked_at = NULL;

	BEGIN
		UPDATE core.installation_state
		SET lock_owner = 'invalid-lock', locked_at = NULL
		WHERE instance_id = current_instance_id;
		RAISE EXCEPTION 'The installation lock constraint accepted a partial lock';
	EXCEPTION
		WHEN check_violation THEN NULL;
	END;
END $$;

DO $$
BEGIN
	BEGIN
		INSERT INTO core.user_email_addresses (user_id, email, normalized_email, is_primary)
		VALUES (
			'36000000-0000-4000-8000-000000000001',
			'duplicate@example.test',
			'validation@example.test',
			false
		);
		RAISE EXCEPTION 'The normalized email uniqueness constraint accepted a duplicate';
	EXCEPTION
		WHEN unique_violation THEN NULL;
	END;

	BEGIN
		INSERT INTO core.user_passkeys (
			user_id,
			credential_id,
			public_key,
			sign_count,
			device_type,
			display_name
		)
		VALUES (
			'36000000-0000-4000-8000-000000000001',
			decode('360006', 'hex'),
			decode('360007', 'hex'),
			-1,
			'single-device',
			'Invalid passkey'
		);
		RAISE EXCEPTION 'The passkey counter constraint accepted a negative value';
	EXCEPTION
		WHEN check_violation THEN NULL;
	END;

	BEGIN
		INSERT INTO core.capability_implications (
			capability_identifier,
			implied_capability_identifier
		)
		VALUES ('core.phase-3-6.source', 'core.phase-3-6.source');
		RAISE EXCEPTION 'The capability implication constraint accepted a self reference';
	EXCEPTION
		WHEN check_violation THEN NULL;
	END;

	BEGIN
		INSERT INTO core.role_incompatibilities (lower_role_id, upper_role_id)
		VALUES (
			'36000000-0000-4000-8000-000000000011',
			'36000000-0000-4000-8000-000000000010'
		);
		RAISE EXCEPTION 'The role order constraint accepted a reversed pair';
	EXCEPTION
		WHEN check_violation THEN NULL;
	END;
END $$;

ROLLBACK;

SELECT 'Core consolidation validation succeeded.' AS result;
