BEGIN;

INSERT INTO core.users (
	id,
	login,
	display_name,
	password_digest,
	created_at
)
VALUES (
	'69000000-0000-4000-8000-000000000001',
	'campaign-validation',
	'Campaign Validation',
	'validation-only',
	now()
);

INSERT INTO core.messaging_topics (identifier, owner_identifier)
VALUES ('validation.campaign', 'site.validation');

INSERT INTO core.messaging_topic_versions (
	topic_identifier,
	schema_version,
	definition
)
VALUES (
	'validation.campaign',
	'1.0.0',
	'{"type":"object"}'::jsonb
);

INSERT INTO core.messaging_templates (
	identifier,
	template_version,
	topic_identifier,
	owner_identifier,
	fallback_locale,
	variable_definitions
)
VALUES (
	'validation.campaign',
	'1.0.0',
	'validation.campaign',
	'site.validation',
	'en',
	'{}'::jsonb
);

INSERT INTO core.messaging_template_localizations (
	template_identifier,
	template_version,
	locale,
	title,
	body
)
VALUES (
	'validation.campaign',
	'1.0.0',
	'en',
	'Validation campaign',
	'Validation body.'
);

INSERT INTO core.messaging_segments (
	identifier,
	owner_identifier,
	definition
)
VALUES (
	'validation.active-users',
	'site.validation',
	'{"resolverMethodIdentifier":"validation.segment.resolve","maximumRecipients":1000}'::jsonb
);

INSERT INTO core.messaging_actions (
	identifier,
	owner_identifier,
	definition
)
VALUES (
	'validation.open-account',
	'site.validation',
	'{"methodIdentifier":"validation.account.open","confirmationRequired":false}'::jsonb
);

INSERT INTO core.messaging_subscription_definitions (
	identifier,
	owner_identifier,
	topic_identifier,
	definition
)
VALUES (
	'validation.campaign-subscription',
	'site.validation',
	'validation.campaign',
	'{"defaultEnabled":true,"userControllable":true}'::jsonb
);

INSERT INTO core.messaging_campaigns (
	id,
	owner_identifier,
	contribution_identifier,
	topic_identifier,
	schema_version,
	template_identifier,
	template_version,
	audience,
	variables,
	requested_locale,
	priority,
	status,
	preview_digest,
	preview_recipient_count,
	scheduled_at,
	created_by
)
VALUES (
	'69000000-0000-4000-8000-000000000002',
	'site.validation',
	'site.validation.campaigns',
	'validation.campaign',
	'1.0.0',
	'validation.campaign',
	'1.0.0',
	'{"kind":"segment","selector":{"identifier":"validation.active-users"}}'::jsonb,
	'{}'::jsonb,
	'en',
	'normal',
	'scheduled',
	repeat('a', 64),
	42,
	now() - interval '1 minute',
	'69000000-0000-4000-8000-000000000001'
);

UPDATE core.messaging_campaigns
SET
	status = 'running',
	started_at = now(),
	updated_at = now()
WHERE id = '69000000-0000-4000-8000-000000000002'
	AND status = 'scheduled';

UPDATE core.messaging_campaigns
SET
	status = 'completed',
	completed_at = now(),
	updated_at = now()
WHERE id = '69000000-0000-4000-8000-000000000002'
	AND status = 'running';

INSERT INTO core.messaging_campaign_events (
	campaign_id,
	event_type,
	outcome,
	actor_id,
	correlation_id,
	metadata
)
VALUES
	(
		'69000000-0000-4000-8000-000000000002',
		'previewed',
		'allowed',
		'69000000-0000-4000-8000-000000000001',
		'campaign-validation-preview',
		'{"recipientCount":42}'::jsonb
	),
	(
		'69000000-0000-4000-8000-000000000002',
		'mass-sent',
		'allowed',
		NULL,
		'campaign-validation-send',
		'{"recipientCount":42,"messageId":"69000000-0000-4000-8000-000000000003"}'::jsonb
	),
	(
		'69000000-0000-4000-8000-000000000002',
		'dead-letter-replayed',
		'allowed',
		'69000000-0000-4000-8000-000000000001',
		'campaign-validation-replay',
		'{"deadLetterId":"69000000-0000-4000-8000-000000000004"}'::jsonb
	);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM core.messaging_campaigns
		WHERE id = '69000000-0000-4000-8000-000000000002'
			AND status = 'completed'
			AND preview_recipient_count = 42
			AND completed_at IS NOT NULL
	) THEN
		RAISE EXCEPTION 'The campaign lifecycle was not persisted.';
	END IF;

	IF (
		SELECT count(*)
		FROM core.messaging_campaign_events
		WHERE campaign_id = '69000000-0000-4000-8000-000000000002'
	) <> 3 THEN
		RAISE EXCEPTION 'The campaign audit trail is incomplete.';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM core.messaging_segments
		WHERE identifier = 'validation.active-users' AND active = true
	) OR NOT EXISTS (
		SELECT 1
		FROM core.messaging_actions
		WHERE identifier = 'validation.open-account' AND active = true
	) OR NOT EXISTS (
		SELECT 1
		FROM core.messaging_subscription_definitions
		WHERE identifier = 'validation.campaign-subscription' AND active = true
	) THEN
		RAISE EXCEPTION 'The messaging contribution catalogs are incomplete.';
	END IF;
END;
$$;

ROLLBACK;

SELECT 'Core messaging campaign validation succeeded.' AS result;
