CREATE TABLE IF NOT EXISTS core.installation_tokens (
	instance_id UUID PRIMARY KEY REFERENCES core.instances (id) ON DELETE CASCADE,
	token_digest TEXT NOT NULL UNIQUE,
	created_at TIMESTAMPTZ NOT NULL,
	expires_at TIMESTAMPTZ NOT NULL,
	consumed_at TIMESTAMPTZ,
	CONSTRAINT installation_tokens_expiration_after_creation CHECK (expires_at > created_at),
	CONSTRAINT installation_tokens_consumption_after_creation CHECK (
		consumed_at IS NULL OR consumed_at >= created_at
	)
);

CREATE INDEX IF NOT EXISTS installation_tokens_expiration_idx
	ON core.installation_tokens (expires_at)
	WHERE consumed_at IS NULL;
