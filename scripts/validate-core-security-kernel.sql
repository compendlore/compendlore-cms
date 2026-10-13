BEGIN;

INSERT INTO core.security_attempts (
	id,
	kind,
	subject_digest,
	outcome,
	occurred_at,
	metadata
)
VALUES (
	'00000000-0000-4000-8000-000000000381',
	'security-kernel.allowed',
	repeat('a', 64),
	'allowed',
	'2026-10-13T20:00:00Z',
	'{"evidenceId":"evidence-test","correlationId":"correlation-test","operation":"core.settings.update","policyIdentifier":"core.settings.update","policyVersion":"1.0.0","resourceKind":"settings","resourceDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'::jsonb
);

DO $$
DECLARE
	audit_record core.security_attempts%ROWTYPE;
BEGIN
	SELECT
		*
	INTO STRICT
		audit_record
	FROM
		core.security_attempts
	WHERE
		id = '00000000-0000-4000-8000-000000000381';

	IF audit_record.subject_digest <> repeat('a', 64) THEN
		RAISE EXCEPTION 'The Security Kernel subject is not pseudonymized.';
	END IF;
	IF audit_record.metadata ? 'value' OR audit_record.metadata ? 'resourceIdentifier' THEN
		RAISE EXCEPTION 'The Security Kernel audit contains a raw protected value.';
	END IF;
	IF audit_record.metadata ->> 'resourceDigest' <> repeat('b', 64) THEN
		RAISE EXCEPTION 'The Security Kernel resource digest is missing.';
	END IF;
END;
$$;

DO $$
BEGIN
	BEGIN
		INSERT INTO core.security_attempts (id, kind, outcome)
		VALUES ('00000000-0000-4000-8000-000000000382', '', 'allowed');
		RAISE EXCEPTION 'An empty Security Kernel audit kind was accepted.';
	EXCEPTION
		WHEN check_violation THEN NULL;
	END;

	BEGIN
		INSERT INTO core.security_attempts (id, kind, outcome)
		VALUES ('00000000-0000-4000-8000-000000000383', 'security-kernel.invalid', 'unknown');
		RAISE EXCEPTION 'An invalid Security Kernel audit outcome was accepted.';
	EXCEPTION
		WHEN check_violation THEN NULL;
	END;
END;
$$;

ROLLBACK;

SELECT 'Core Security Kernel validation succeeded.' AS result;
