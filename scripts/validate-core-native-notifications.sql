BEGIN;

DO $$
DECLARE
	revision_nullable TEXT;
	revision_default TEXT;
BEGIN
	SELECT is_nullable, column_default
	INTO revision_nullable, revision_default
	FROM information_schema.columns
	WHERE table_schema = 'core'
		AND table_name = 'notification_user_states'
		AND column_name = 'revision';

	IF revision_nullable IS DISTINCT FROM 'NO' OR revision_default NOT LIKE '%notification_state_revision_sequence%' THEN
		RAISE EXCEPTION 'Notification synchronization revision is not configured';
	END IF;

	IF to_regclass('core.notification_user_states_revision_idx') IS NULL THEN
		RAISE EXCEPTION 'Notification synchronization revision index is missing';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM core.messaging_topics
		WHERE identifier IN ('core.account', 'core.maintenance', 'core.restart', 'core.security')
	) THEN
		RAISE EXCEPTION 'Native notification topics must be materialized by Core operations';
	END IF;
END
$$;

ROLLBACK;

SELECT 'Core native notification validation succeeded.' AS result;

