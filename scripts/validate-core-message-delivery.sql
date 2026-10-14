\set ON_ERROR_STOP on

BEGIN;

INSERT INTO core.users (id, login, display_name, password_digest, created_at)
VALUES ('67000000-0000-4000-8000-000000000001', 'phase-6-7-user', 'Phase 6.7 User', 'validation-digest', now());

INSERT INTO core.messaging_topics (identifier, owner_identifier)
VALUES ('core.phase-6-7.validation', 'core.validation');

INSERT INTO core.messaging_topic_versions (topic_identifier, schema_version, definition)
VALUES ('core.phase-6-7.validation', '1.0.0', '{"type":"object"}'::jsonb);

INSERT INTO core.messaging_messages (
	id, topic_identifier, schema_version, producer_identifier, priority, payload, idempotency_key
)
VALUES
	(
		'67000000-0000-4000-8000-000000000010',
		'core.phase-6-7.validation',
		'1.0.0',
		'core.validation',
		'normal',
		'{"order":1}'::jsonb,
		'phase-6-7-first'
	),
	(
		'67000000-0000-4000-8000-000000000011',
		'core.phase-6-7.validation',
		'1.0.0',
		'core.validation',
		'normal',
		'{"order":2}'::jsonb,
		'phase-6-7-second'
	);

INSERT INTO core.messaging_audiences (
	id, message_id, kind, selector, resolution_mode, resolved_at
)
VALUES (
	'67000000-0000-4000-8000-000000000020',
	'67000000-0000-4000-8000-000000000010',
	'segment',
	'["active-members"]'::jsonb,
	'snapshot',
	now()
);

INSERT INTO core.messaging_recipients (message_id, user_id, audience_id)
VALUES
	(
		'67000000-0000-4000-8000-000000000010',
		'67000000-0000-4000-8000-000000000001',
		'67000000-0000-4000-8000-000000000020'
	),
	(
		'67000000-0000-4000-8000-000000000011',
		'67000000-0000-4000-8000-000000000001',
		NULL
	);

INSERT INTO core.messaging_deliveries (
	id, message_id, user_id, channel, required_acknowledgement, next_attempt_at
)
VALUES
	(
		'67000000-0000-4000-8000-000000000030',
		'67000000-0000-4000-8000-000000000010',
		'67000000-0000-4000-8000-000000000001',
		'realtime',
		'read',
		now()
	),
	(
		'67000000-0000-4000-8000-000000000031',
		'67000000-0000-4000-8000-000000000011',
		'67000000-0000-4000-8000-000000000001',
		'inbox',
		'none',
		now()
	);

UPDATE core.messaging_deliveries
SET status = 'processing', attempt_count = attempt_count + 1, locked_at = now()
WHERE id = '67000000-0000-4000-8000-000000000030' AND status = 'pending';

WITH completed AS (
	UPDATE core.messaging_deliveries
	SET status = 'delivered', delivered_at = now(), locked_at = NULL, updated_at = now()
	WHERE id = '67000000-0000-4000-8000-000000000030' AND status = 'processing'
	RETURNING id, attempt_count
)
INSERT INTO core.messaging_delivery_attempts (delivery_id, attempt_number, result)
SELECT id, attempt_count, 'delivered' FROM completed;

INSERT INTO core.messaging_acknowledgements (delivery_id, kind)
VALUES
	('67000000-0000-4000-8000-000000000030', 'transport'),
	('67000000-0000-4000-8000-000000000030', 'read');

UPDATE core.messaging_deliveries
SET status = 'acknowledged', updated_at = now()
WHERE id = '67000000-0000-4000-8000-000000000030';

UPDATE core.messaging_deliveries
SET status = 'processing', attempt_count = attempt_count + 1, locked_at = now()
WHERE id = '67000000-0000-4000-8000-000000000031' AND status = 'pending';

WITH failed AS (
	UPDATE core.messaging_deliveries
	SET status = 'failed', next_attempt_at = NULL, locked_at = NULL, updated_at = now()
	WHERE id = '67000000-0000-4000-8000-000000000031' AND status = 'processing'
	RETURNING id, attempt_count
)
INSERT INTO core.messaging_delivery_attempts (delivery_id, attempt_number, result, error_code)
SELECT id, attempt_count, 'failed', 'transport.unavailable' FROM failed;

INSERT INTO core.messaging_dead_letters (id, delivery_id, reason_code)
VALUES (
	'67000000-0000-4000-8000-000000000040',
	'67000000-0000-4000-8000-000000000031',
	'transport.unavailable'
);

INSERT INTO core.messaging_cursors (consumer_identifier, partition_identifier, position)
SELECT
	'frontend.validation',
	'67000000-0000-4000-8000-000000000001',
	max(sequence)
FROM core.messaging_messages
WHERE topic_identifier = 'core.phase-6-7.validation';

DO $$
DECLARE
	acknowledgement_count INTEGER;
	dead_letter_count INTEGER;
	maximum_sequence BIGINT;
	cursor_position BIGINT;
BEGIN
	SELECT count(*) INTO acknowledgement_count
	FROM core.messaging_acknowledgements
	WHERE delivery_id = '67000000-0000-4000-8000-000000000030';

	SELECT count(*) INTO dead_letter_count
	FROM core.messaging_dead_letters
	WHERE delivery_id = '67000000-0000-4000-8000-000000000031';

	SELECT max(sequence) INTO maximum_sequence
	FROM core.messaging_messages
	WHERE topic_identifier = 'core.phase-6-7.validation';

	SELECT position INTO STRICT cursor_position
	FROM core.messaging_cursors
	WHERE consumer_identifier = 'frontend.validation'
		AND partition_identifier = '67000000-0000-4000-8000-000000000001';

	IF acknowledgement_count <> 2 OR dead_letter_count <> 1 THEN
		RAISE EXCEPTION 'Delivery acknowledgements or dead letters are incomplete.';
	END IF;

	IF cursor_position <> maximum_sequence THEN
		RAISE EXCEPTION 'The durable delivery cursor is inconsistent.';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM core.messaging_deliveries
		WHERE id = '67000000-0000-4000-8000-000000000031'
			AND next_attempt_at IS NOT NULL
	) THEN
		RAISE EXCEPTION 'A terminal delivery failure remains eligible for retry.';
	END IF;
END $$;

ROLLBACK;

SELECT 'Core message delivery validation succeeded.' AS result;
