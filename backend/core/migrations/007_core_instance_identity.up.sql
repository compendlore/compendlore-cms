CREATE TABLE IF NOT EXISTS core.instance_identities (
	installation_id UUID PRIMARY KEY,
	algorithm TEXT NOT NULL,
	public_key_spki TEXT NOT NULL,
	fingerprint TEXT NOT NULL UNIQUE,
	assurance_level TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active',
	created_at TIMESTAMPTZ NOT NULL,
	rotated_at TIMESTAMPTZ,
	revoked_at TIMESTAMPTZ,
	CONSTRAINT instance_identities_algorithm_check CHECK (algorithm = 'Ed25519'),
	CONSTRAINT instance_identities_assurance_check CHECK (
		assurance_level IN ('software', 'operating-system', 'hardware')
	),
	CONSTRAINT instance_identities_status_check CHECK (status IN ('active', 'rotated', 'revoked')),
	CONSTRAINT instance_identities_key_check CHECK (length(public_key_spki) BETWEEN 32 AND 512),
	CONSTRAINT instance_identities_fingerprint_check CHECK (length(fingerprint) BETWEEN 32 AND 128)
);

CREATE UNIQUE INDEX IF NOT EXISTS instance_identities_single_active_idx
	ON core.instance_identities ((status))
	WHERE status = 'active';
