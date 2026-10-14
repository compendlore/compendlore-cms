BEGIN;

INSERT INTO core.connector_tokens (connection_key_digest, sealed_token)
VALUES (
	encode(digest('official.library:instance', 'sha256'), 'hex'),
	'encrypted-token-placeholder'
);

DO $$
DECLARE
	stored_count INTEGER;
BEGIN
	SELECT count(*)
	INTO stored_count
	FROM core.connector_tokens
	WHERE connection_key_digest = encode(digest('official.library:instance', 'sha256'), 'hex');

	IF stored_count <> 1 THEN
		RAISE EXCEPTION 'Connector token persistence validation failed.';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM core.connector_tokens
		WHERE connection_key_digest = 'official.library:instance'
	) THEN
		RAISE EXCEPTION 'Connector connection keys must not be stored in clear text.';
	END IF;
END
$$;

ROLLBACK;

SELECT 'Connector chaining validation succeeded.' AS result;
