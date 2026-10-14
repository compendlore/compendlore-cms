\set ON_ERROR_STOP on

BEGIN;

INSERT INTO core.contribution_schema_journal (
	id,
	contribution_key,
	owner_kind,
	owner_identifier,
	version,
	fingerprint,
	plan_integrity,
	decision_id,
	desired_state,
	applied_state,
	observed_state,
	plan,
	error,
	requested_at,
	applied_at
)
VALUES (
	'52000000-0000-4000-8000-000000000001',
	'table.phase-5-2.validation',
	'addon',
	'addon.phase-5-2.validation',
	'1.2.3',
	repeat('a', 64),
	repeat('c', 64),
	'52000000-0000-4000-8000-000000000011',
	'active',
	'applied',
	'active',
	'{"id":"52000000-0000-4000-8000-000000000001","ownerKind":"addon"}'::jsonb,
	NULL,
	now() - INTERVAL '1 second',
	now()
);

DO $$
DECLARE
	journal_owner_kind TEXT;
	journal_owner_identifier TEXT;
	journal_plan JSONB;
	journal_requested_at TIMESTAMPTZ;
	journal_applied_at TIMESTAMPTZ;
BEGIN
	SELECT owner_kind, owner_identifier, plan, requested_at, applied_at
	INTO STRICT journal_owner_kind, journal_owner_identifier, journal_plan,
		journal_requested_at, journal_applied_at
	FROM core.contribution_schema_journal
	WHERE id = '52000000-0000-4000-8000-000000000001';

	IF journal_owner_kind <> 'addon'
		OR journal_owner_identifier <> 'addon.phase-5-2.validation'
		OR journal_plan ->> 'ownerKind' <> 'addon'
		OR journal_requested_at IS NULL
		OR journal_applied_at IS NULL
		OR journal_applied_at < journal_requested_at THEN
		RAISE EXCEPTION 'The schema journal did not preserve its complete metadata.';
	END IF;

	BEGIN
		INSERT INTO core.contribution_schema_journal (
			id, contribution_key, owner_kind, owner_identifier, version, fingerprint,
			plan_integrity, decision_id,
			desired_state, applied_state, observed_state, plan, requested_at
		)
		VALUES (
			'52000000-0000-4000-8000-000000000002',
			'table.phase-5-2.invalid',
			'unknown',
			'addon.phase-5-2.invalid',
			'1.0.0',
			repeat('b', 64),
			repeat('d', 64),
			'52000000-0000-4000-8000-000000000012',
			'active',
			'pending',
			'unknown',
			'{}'::jsonb,
			now()
		);
		RAISE EXCEPTION 'The schema journal accepted an invalid owner kind.';
	EXCEPTION
		WHEN check_violation THEN NULL;
	END;
END $$;

ROLLBACK;

SELECT 'Schema journal validation succeeded.' AS result;
