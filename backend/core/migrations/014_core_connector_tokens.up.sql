CREATE TABLE IF NOT EXISTS core.connector_tokens (
	connection_key_digest TEXT PRIMARY KEY,
	sealed_token TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT connector_tokens_key_digest_check CHECK (
		connection_key_digest ~ '^[0-9a-f]{64}$'
	),
	CONSTRAINT connector_tokens_sealed_token_check CHECK (
		char_length(sealed_token) BETWEEN 1 AND 65536
	)
);

CREATE INDEX IF NOT EXISTS connector_tokens_updated_at_idx
	ON core.connector_tokens (updated_at);
