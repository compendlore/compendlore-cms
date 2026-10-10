ALTER TABLE core.events
	ADD COLUMN sequence BIGINT GENERATED ALWAYS AS IDENTITY,
	ADD COLUMN owner_identifier TEXT NOT NULL DEFAULT 'core.legacy',
	ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1,
	ADD COLUMN received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	ADD COLUMN retention_until TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '90 days'),
	ADD COLUMN idempotency_key TEXT;

ALTER TABLE core.events
	ADD CONSTRAINT events_sequence_unique UNIQUE (sequence),
	ADD CONSTRAINT events_schema_version_positive CHECK (schema_version > 0),
	ADD CONSTRAINT events_retention_after_reception CHECK (retention_until > received_at),
	ADD CONSTRAINT events_owner_not_empty CHECK (length(owner_identifier) > 0),
	ADD CONSTRAINT events_topic_not_empty CHECK (length(topic) > 0);

CREATE UNIQUE INDEX events_owner_idempotency_unique
	ON core.events (owner_identifier, idempotency_key)
	WHERE idempotency_key IS NOT NULL;

CREATE INDEX events_stream_idx
	ON core.events (topic, sequence);

CREATE INDEX events_retention_idx
	ON core.events (retention_until, sequence);

CREATE TABLE core.event_consumers (
	identifier TEXT PRIMARY KEY,
	owner_identifier TEXT NOT NULL,
	topics TEXT[] NOT NULL,
	last_sequence BIGINT NOT NULL DEFAULT 0,
	is_active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT event_consumers_identifier_not_empty CHECK (length(identifier) > 0),
	CONSTRAINT event_consumers_owner_not_empty CHECK (length(owner_identifier) > 0),
	CONSTRAINT event_consumers_topics_not_empty CHECK (cardinality(topics) > 0),
	CONSTRAINT event_consumers_cursor_positive CHECK (last_sequence >= 0)
);

CREATE INDEX event_consumers_active_idx
	ON core.event_consumers (is_active, last_sequence)
	WHERE is_active = true;
