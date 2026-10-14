\set ON_ERROR_STOP on

BEGIN;

INSERT INTO core.messaging_topics (identifier, owner_identifier)
VALUES ('core.phase-6-6.validation', 'core.validation');

INSERT INTO core.messaging_topic_versions (topic_identifier, schema_version, definition)
VALUES ('core.phase-6-6.validation', '1.0.0', '{"type":"object"}'::jsonb);

WITH message AS (
	INSERT INTO core.messaging_messages (
		id,
		topic_identifier,
		schema_version,
		producer_identifier,
		correlation_id,
		idempotency_key,
		priority,
		payload,
		available_at
	)
	VALUES (
		'66000000-0000-4000-8000-000000000001',
		'core.phase-6-6.validation',
		'1.0.0',
		'core.validation',
		'phase-6-6-correlation',
		'phase-6-6-idempotency',
		'normal',
		'{"value":"persistent"}'::jsonb,
		now()
	)
	RETURNING id, available_at
)
INSERT INTO core.messaging_outbox (id, message_id, available_at)
SELECT '66000000-0000-4000-8000-000000000002', id, available_at
FROM message;

INSERT INTO core.messaging_messages (
	id,
	topic_identifier,
	schema_version,
	producer_identifier,
	idempotency_key,
	priority,
	payload
)
VALUES (
	'66000000-0000-4000-8000-000000000003',
	'core.phase-6-6.validation',
	'1.0.0',
	'core.validation',
	'phase-6-6-idempotency',
	'normal',
	'{}'::jsonb
)
ON CONFLICT (producer_identifier, topic_identifier, idempotency_key) DO NOTHING;

DO $$
DECLARE
	message_count INTEGER;
	outbox_count INTEGER;
BEGIN
	SELECT count(*) INTO message_count
	FROM core.messaging_messages
	WHERE topic_identifier = 'core.phase-6-6.validation';

	SELECT count(*) INTO outbox_count
	FROM core.messaging_outbox outbox
	INNER JOIN core.messaging_messages message ON message.id = outbox.message_id
	WHERE message.topic_identifier = 'core.phase-6-6.validation';

	IF message_count <> 1 OR outbox_count <> 1 THEN
		RAISE EXCEPTION 'Transactional messaging persistence is not idempotent.';
	END IF;
END $$;

WITH due AS (
	SELECT outbox.id
	FROM core.messaging_outbox outbox
	WHERE outbox.id = '66000000-0000-4000-8000-000000000002'
		AND outbox.status = 'pending'
		AND outbox.available_at <= now()
	FOR UPDATE SKIP LOCKED
), claimed AS (
	UPDATE core.messaging_outbox outbox
	SET
		status = 'processing',
		attempt_count = outbox.attempt_count + 1,
		locked_at = now(),
		updated_at = now()
	FROM due
	WHERE outbox.id = due.id
	RETURNING outbox.id
)
SELECT id FROM claimed;

UPDATE core.messaging_outbox
SET
	status = 'published',
	locked_at = NULL,
	updated_at = now()
WHERE id = '66000000-0000-4000-8000-000000000002'
	AND status = 'processing';

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM core.messaging_outbox
		WHERE id = '66000000-0000-4000-8000-000000000002'
			AND status = 'published'
			AND attempt_count = 1
			AND locked_at IS NULL
	) THEN
		RAISE EXCEPTION 'The transactional outbox did not complete its state transition.';
	END IF;
END $$;

ROLLBACK;

SELECT 'Core messaging outbox validation succeeded.' AS result;
