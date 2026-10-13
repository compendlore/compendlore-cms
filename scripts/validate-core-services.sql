\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
	missing_tables TEXT;
BEGIN
	SELECT string_agg(required.name, ', ' ORDER BY required.name)
	INTO missing_tables
	FROM unnest(ARRAY[
		'tasks',
		'events',
		'event_consumers',
		'communications',
		'messaging_outbox',
		'messaging_presence'
	]) AS required(name)
	WHERE NOT EXISTS (
		SELECT 1
		FROM pg_catalog.pg_tables actual
		WHERE actual.schemaname = 'core'
			AND actual.tablename = required.name
	);

	IF missing_tables IS NOT NULL THEN
		RAISE EXCEPTION 'Missing Core service tables: %', missing_tables;
	END IF;
END $$;

INSERT INTO core.tasks (id, type, payload, execute_at)
VALUES (
	'00000000-0000-4000-8000-000000000034',
	'core.validation.service',
	'{"source":"phase-3.4"}'::jsonb,
	now() - INTERVAL '1 second'
);

DO $$
DECLARE
	claimed_count INTEGER;
BEGIN
	WITH due AS (
		SELECT id
		FROM core.tasks
		WHERE status = 'pending'
			AND execute_at <= now()
		ORDER BY execute_at, created_at
		FOR UPDATE SKIP LOCKED
		LIMIT 1
	), claimed AS (
		UPDATE core.tasks AS task
		SET status = 'running', attempts = task.attempts + 1
		FROM due
		WHERE task.id = due.id
		RETURNING task.id
	)
	SELECT count(*) INTO claimed_count FROM claimed;

	IF claimed_count <> 1 THEN
		RAISE EXCEPTION 'The due Core task could not be claimed atomically.';
	END IF;
END $$;

UPDATE core.tasks
SET status = 'completed'
WHERE id = '00000000-0000-4000-8000-000000000034'
	AND status = 'running';

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM core.tasks
		WHERE id = '00000000-0000-4000-8000-000000000034'
			AND status = 'completed'
			AND attempts = 1
	) THEN
		RAISE EXCEPTION 'The Core task lifecycle is inconsistent.';
	END IF;
END $$;

ROLLBACK;

SELECT 'Core services validation succeeded.' AS result;
