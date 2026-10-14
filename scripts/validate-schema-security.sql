\set ON_ERROR_STOP on

BEGIN;

INSERT INTO core.contribution_schema_journal (
	id, contribution_key, owner_kind, owner_identifier, version, fingerprint,
	plan_integrity, decision_id, desired_state, applied_state, observed_state,
	plan, requested_at, applied_at
)
VALUES (
	'56000000-0000-4000-8000-000000000001',
	'table.phase-5-6.validation',
	'addon',
	'addon.phase-5-6.validation',
	'1.0.0',
	repeat('a', 64),
	repeat('b', 64),
	'56000000-0000-4000-8000-000000000011',
	'active',
	'applied',
	'active',
	'{"integrity":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'::jsonb,
	now(),
	now()
);

DO $$
BEGIN
	BEGIN
		INSERT INTO core.contribution_schema_journal (
			id, contribution_key, owner_kind, owner_identifier, version, fingerprint,
			plan_integrity, decision_id, desired_state, applied_state, observed_state,
			plan, requested_at
		)
		VALUES (
			'56000000-0000-4000-8000-000000000002',
			'table.phase-5-6.replay',
			'addon',
			'addon.phase-5-6.validation',
			'1.0.0',
			repeat('c', 64),
			repeat('d', 64),
			'56000000-0000-4000-8000-000000000011',
			'active',
			'pending',
			'unknown',
			'{}'::jsonb,
			now()
		);
		RAISE EXCEPTION 'The schema journal accepted a replayed Core decision.';
	EXCEPTION
		WHEN unique_violation THEN NULL;
	END;

	BEGIN
		INSERT INTO core.contribution_schema_journal (
			id, contribution_key, owner_kind, owner_identifier, version, fingerprint,
			plan_integrity, decision_id, desired_state, applied_state, observed_state,
			plan, requested_at
		)
		VALUES (
			'56000000-0000-4000-8000-000000000003',
			'table.phase-5-6.invalid-integrity',
			'addon',
			'addon.phase-5-6.validation',
			'1.0.0',
			repeat('e', 64),
			'invalid',
			'56000000-0000-4000-8000-000000000013',
			'active',
			'pending',
			'unknown',
			'{}'::jsonb,
			now()
		);
		RAISE EXCEPTION 'The schema journal accepted an invalid plan integrity proof.';
	EXCEPTION
		WHEN check_violation THEN NULL;
	END;
END $$;

ROLLBACK;

SELECT 'Schema security validation succeeded.' AS result;
