ALTER TABLE core.contribution_schema_journal
	ADD COLUMN IF NOT EXISTS plan_integrity TEXT;

ALTER TABLE core.contribution_schema_journal
	ADD COLUMN IF NOT EXISTS decision_id UUID;

UPDATE core.contribution_schema_journal
SET
	plan_integrity = COALESCE(plan ->> 'integrity', fingerprint),
	decision_id = id
WHERE plan_integrity IS NULL
	OR decision_id IS NULL;

ALTER TABLE core.contribution_schema_journal
	ALTER COLUMN plan_integrity SET NOT NULL;

ALTER TABLE core.contribution_schema_journal
	ALTER COLUMN decision_id SET NOT NULL;

ALTER TABLE core.contribution_schema_journal
	DROP CONSTRAINT IF EXISTS contribution_schema_journal_plan_integrity_check;

ALTER TABLE core.contribution_schema_journal
	ADD CONSTRAINT contribution_schema_journal_plan_integrity_check CHECK (
		plan_integrity ~ '^[a-f0-9]{64}$'
	);

CREATE UNIQUE INDEX IF NOT EXISTS contribution_schema_journal_decision_idx
	ON core.contribution_schema_journal (decision_id);

CREATE INDEX IF NOT EXISTS contribution_schema_journal_plan_integrity_idx
	ON core.contribution_schema_journal (plan_integrity);
