\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
	missing_columns TEXT;
BEGIN
	SELECT string_agg(required.name, ', ' ORDER BY required.name)
	INTO missing_columns
	FROM unnest(ARRAY[
		'sequence',
		'owner_identifier',
		'schema_version',
		'payload_checksum',
		'signature',
		'received_at',
		'retention_until',
		'idempotency_key'
	]) AS required(name)
	WHERE NOT EXISTS (
		SELECT 1
		FROM information_schema.columns actual
		WHERE actual.table_schema = 'core'
			AND actual.table_name = 'events'
			AND actual.column_name = required.name
	);

	IF missing_columns IS NOT NULL THEN
		RAISE EXCEPTION 'Missing Core event columns: %', missing_columns;
	END IF;
END $$;

INSERT INTO core.event_consumers (
	identifier,
	owner_identifier,
	topics,
	last_sequence,
	is_active
)
VALUES (
	'core.phase-3-7.validation',
	'core.validation',
	ARRAY['core.validation.event'],
	0,
	true
);

INSERT INTO core.events (
	id,
	owner_identifier,
	topic,
	schema_version,
	payload,
	payload_checksum,
	signature,
	occurred_at,
	received_at,
	retention_until,
	idempotency_key
)
VALUES
	(
		'37000000-0000-4000-8000-000000000001',
		'core.validation',
		'core.validation.event',
		1,
		'{"order":1}'::jsonb,
		repeat('a', 64),
		repeat('b', 64),
		now() - INTERVAL '2 hours',
		now() - INTERVAL '2 hours',
		now() - INTERVAL '1 hour',
		'phase-3-7-first'
	),
	(
		'37000000-0000-4000-8000-000000000002',
		'core.validation',
		'core.validation.event',
		1,
		'{"order":2}'::jsonb,
		repeat('c', 64),
		repeat('d', 64),
		now() - INTERVAL '1 hour',
		now() - INTERVAL '1 hour',
		now() + INTERVAL '1 hour',
		'phase-3-7-second'
	);

DO $$
DECLARE
	ordered_payloads INTEGER[];
	expired_sequence BIGINT;
	deleted_count INTEGER;
BEGIN
	SELECT array_agg((payload ->> 'order')::INTEGER ORDER BY sequence)
	INTO ordered_payloads
	FROM core.events
	WHERE topic = 'core.validation.event';

	IF ordered_payloads <> ARRAY[1, 2] THEN
		RAISE EXCEPTION 'The Core event stream is not ordered by its persistent sequence.';
	END IF;

	SELECT sequence
	INTO STRICT expired_sequence
	FROM core.events
	WHERE id = '37000000-0000-4000-8000-000000000001';

	DELETE FROM core.events event
	WHERE event.retention_until <= now()
		AND NOT EXISTS (
			SELECT 1
			FROM core.event_consumers consumer
			WHERE consumer.is_active = true
				AND event.topic = ANY(consumer.topics)
				AND consumer.last_sequence < event.sequence
		);
	GET DIAGNOSTICS deleted_count = ROW_COUNT;

	IF deleted_count <> 0 THEN
		RAISE EXCEPTION 'Retention deleted an event still awaited by an active consumer.';
	END IF;

	UPDATE core.event_consumers
	SET last_sequence = expired_sequence, updated_at = now()
	WHERE identifier = 'core.phase-3-7.validation';

	DELETE FROM core.events event
	WHERE event.retention_until <= now()
		AND NOT EXISTS (
			SELECT 1
			FROM core.event_consumers consumer
			WHERE consumer.is_active = true
				AND event.topic = ANY(consumer.topics)
				AND consumer.last_sequence < event.sequence
		);
	GET DIAGNOSTICS deleted_count = ROW_COUNT;

	IF deleted_count <> 1 THEN
		RAISE EXCEPTION 'Retention did not delete the acknowledged expired event.';
	END IF;
END $$;

DO $$
BEGIN
	BEGIN
		INSERT INTO core.events (
			owner_identifier,
			topic,
			schema_version,
			payload,
			payload_checksum,
			signature,
			retention_until,
			idempotency_key
		)
		VALUES (
			'core.validation',
			'core.validation.event',
			1,
			'{}'::jsonb,
			repeat('e', 64),
			repeat('f', 64),
			now() + INTERVAL '1 hour',
			'phase-3-7-second'
		);
		RAISE EXCEPTION 'The event stream accepted a duplicate idempotency key.';
	EXCEPTION
		WHEN unique_violation THEN NULL;
	END;

	BEGIN
		INSERT INTO core.events (
			owner_identifier,
			topic,
			schema_version,
			payload,
			payload_checksum,
			signature,
			retention_until
		)
		VALUES (
			'core.validation',
			'core.validation.event',
			1,
			'{}'::jsonb,
			'invalid-checksum',
			repeat('f', 64),
			now() + INTERVAL '1 hour'
		);
		RAISE EXCEPTION 'The event stream accepted an invalid integrity proof.';
	EXCEPTION
		WHEN check_violation THEN NULL;
	END;
END $$;

UPDATE core.event_consumers
SET is_active = false, updated_at = now()
WHERE identifier = 'core.phase-3-7.validation';

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM core.event_consumers
		WHERE identifier = 'core.phase-3-7.validation'
			AND is_active = false
	) THEN
		RAISE EXCEPTION 'The Core event consumer could not be deactivated.';
	END IF;
END $$;

ROLLBACK;

SELECT 'Core event stream validation succeeded.' AS result;
