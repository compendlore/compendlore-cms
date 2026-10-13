BEGIN;

DO $$
DECLARE
	instance_identifier UUID;
BEGIN
	SELECT id
	INTO instance_identifier
	FROM core.instances
	LIMIT 1;

	IF instance_identifier IS NULL THEN
		RAISE EXCEPTION 'A Core instance is required for identity validation.';
	END IF;

	INSERT INTO core.instance_identities (
		instance_id,
		identity_identifier,
		algorithm,
		format_version,
		public_key,
		public_key_fingerprint,
		key_reference,
		assurance_level,
		created_at,
		updated_at
	)
	VALUES (
		instance_identifier,
		'compendlore:instance:v1:test-validation-fingerprint',
		'Ed25519',
		1,
		decode('302a300506032b65700321000000000000000000000000000000000000000000000000000000000000000000', 'hex'),
		'test-validation-fingerprint',
		'protected-file:validation',
		'protected-file',
		now(),
		now()
	)
	ON CONFLICT (instance_id) DO NOTHING;

	IF NOT EXISTS (
		SELECT 1
		FROM core.instance_identities
		WHERE instance_id = instance_identifier
	) THEN
		RAISE EXCEPTION 'The public instance identity was not persisted.';
	END IF;
END
$$;

DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'core'
			AND table_name = 'instance_identities'
			AND column_name LIKE '%private%'
	) THEN
		RAISE EXCEPTION 'A private identity component is exposed in PostgreSQL.';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM information_schema.table_constraints
		WHERE constraint_schema = 'core'
			AND table_name = 'instance_identities'
			AND constraint_name = 'instance_identities_algorithm_check'
	) THEN
		RAISE EXCEPTION 'The Ed25519 algorithm constraint is missing.';
	END IF;
END
$$;

ROLLBACK;

SELECT 'Core instance identity validation succeeded.' AS result;
