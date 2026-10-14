ALTER TABLE core.contribution_schema_journal
	ADD COLUMN IF NOT EXISTS owner_kind TEXT;

UPDATE core.contribution_schema_journal
SET owner_kind = CASE
	WHEN plan ->> 'ownerKind' IN ('addon', 'core', 'instance', 'native-module')
		THEN plan ->> 'ownerKind'
	ELSE 'core'
END
WHERE owner_kind IS NULL;

ALTER TABLE core.contribution_schema_journal
	ALTER COLUMN owner_kind SET NOT NULL;

ALTER TABLE core.contribution_schema_journal
	DROP CONSTRAINT IF EXISTS contribution_schema_journal_owner_kind_check;

ALTER TABLE core.contribution_schema_journal
	ADD CONSTRAINT contribution_schema_journal_owner_kind_check CHECK (
		owner_kind IN ('addon', 'core', 'instance', 'native-module')
	);

CREATE INDEX IF NOT EXISTS contribution_schema_journal_owner_requested_idx
	ON core.contribution_schema_journal (owner_kind, owner_identifier, requested_at DESC);
