CREATE SEQUENCE IF NOT EXISTS core.notification_state_revision_sequence;

ALTER TABLE core.notification_user_states
	ADD COLUMN IF NOT EXISTS revision BIGINT;

UPDATE core.notification_user_states
SET revision = nextval('core.notification_state_revision_sequence')
WHERE revision IS NULL;

ALTER TABLE core.notification_user_states
	ALTER COLUMN revision SET DEFAULT nextval('core.notification_state_revision_sequence'),
	ALTER COLUMN revision SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS notification_user_states_revision_idx
	ON core.notification_user_states (revision);

