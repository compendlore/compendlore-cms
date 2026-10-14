ALTER TABLE core.messaging_messages
	ADD COLUMN IF NOT EXISTS sequence BIGINT GENERATED ALWAYS AS IDENTITY;

CREATE UNIQUE INDEX IF NOT EXISTS messaging_messages_sequence_idx
	ON core.messaging_messages (sequence);

ALTER TABLE core.messaging_audiences
	DROP CONSTRAINT IF EXISTS messaging_audiences_kind_check;

ALTER TABLE core.messaging_audiences
	ADD CONSTRAINT messaging_audiences_kind_check CHECK (
		kind IN (
			'broadcast',
			'capability',
			'group',
			'permission',
			'role',
			'segment',
			'team',
			'user',
			'user-list'
		)
	);

ALTER TABLE core.messaging_deliveries
	ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
	ADD COLUMN IF NOT EXISTS required_acknowledgement TEXT NOT NULL DEFAULT 'transport';

ALTER TABLE core.messaging_deliveries
	ADD CONSTRAINT messaging_deliveries_attempt_count_check CHECK (attempt_count >= 0),
	ADD CONSTRAINT messaging_deliveries_acknowledgement_check CHECK (
		required_acknowledgement IN ('none', 'transport', 'processed', 'read', 'action')
	);

CREATE INDEX IF NOT EXISTS messaging_deliveries_claim_idx
	ON core.messaging_deliveries (next_attempt_at, created_at)
	WHERE status IN ('pending', 'failed');
