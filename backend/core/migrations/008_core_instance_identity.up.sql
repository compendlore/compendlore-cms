CREATE TABLE core.instance_identities (
	instance_id UUID PRIMARY KEY REFERENCES core.instances (id) ON DELETE CASCADE,
	identity_identifier TEXT NOT NULL UNIQUE,
	algorithm TEXT NOT NULL,
	format_version INTEGER NOT NULL,
	public_key BYTEA NOT NULL,
	public_key_fingerprint TEXT NOT NULL UNIQUE,
	key_reference TEXT NOT NULL,
	assurance_level TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL,
	CONSTRAINT instance_identities_algorithm_check CHECK (algorithm = 'Ed25519'),
	CONSTRAINT instance_identities_format_version_check CHECK (format_version > 0),
	CONSTRAINT instance_identities_public_key_check CHECK (octet_length(public_key) > 0),
	CONSTRAINT instance_identities_identifier_check CHECK (length(btrim(identity_identifier)) > 0),
	CONSTRAINT instance_identities_fingerprint_check CHECK (length(btrim(public_key_fingerprint)) > 0),
	CONSTRAINT instance_identities_key_reference_check CHECK (length(btrim(key_reference)) > 0),
	CONSTRAINT instance_identities_assurance_check CHECK (
		assurance_level IN ('hardware', 'protected-file', 'system')
	),
	CONSTRAINT instance_identities_timestamps_check CHECK (updated_at >= created_at)
);

CREATE INDEX instance_identities_assurance_idx
	ON core.instance_identities (assurance_level);
