ALTER TABLE core.events
	ADD COLUMN payload_checksum TEXT,
	ADD COLUMN signature TEXT;

ALTER TABLE core.events
	ADD CONSTRAINT events_payload_checksum_format CHECK (
		payload_checksum IS NULL OR payload_checksum ~ '^[0-9a-f]{64}$'
	),
	ADD CONSTRAINT events_signature_format CHECK (
		signature IS NULL OR signature ~ '^[0-9a-f]{64}$'
	);

CREATE INDEX events_integrity_idx
	ON core.events (payload_checksum, signature)
	WHERE payload_checksum IS NOT NULL AND signature IS NOT NULL;
