BEGIN;

INSERT INTO core.users (
	id,
	login,
	display_name,
	password_digest,
	created_at
)
VALUES (
	'68000000-0000-4000-8000-000000000001',
	'notification-template-validation',
	'Notification Template Validation',
	'validation-only',
	now()
);

INSERT INTO core.messaging_topics (identifier, owner_identifier)
VALUES ('validation.notification', 'site.validation');

INSERT INTO core.messaging_topic_versions (
	topic_identifier,
	schema_version,
	definition
)
VALUES (
	'validation.notification',
	'1.0.0',
	'{"type":"object","required":["displayName"]}'::jsonb
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
	'validation.welcome',
	'1.0.0',
	'validation.notification',
	'site.validation',
	'en',
	'{"displayName":{"type":"string","required":true,"classification":"personal"}}'::jsonb
);

INSERT INTO core.messaging_template_localizations (
	template_identifier,
	template_version,
	locale,
	title,
	summary,
	body,
	actions
)
VALUES
	(
		'validation.welcome',
		'1.0.0',
		'en',
		'Welcome {{displayName}}',
		'Your account is ready.',
		'Hello {{displayName}}.',
		'[{"identifier":"open-account","label":"Open account","action":"core.account.open"}]'::jsonb
	),
	(
		'validation.welcome',
		'1.0.0',
		'fr-FR',
		'Bienvenue {{displayName}}',
		'Votre compte est prêt.',
		'Bonjour {{displayName}}.',
		'[{"identifier":"open-account","label":"Ouvrir le compte","action":"core.account.open"}]'::jsonb
	);

INSERT INTO core.messaging_channels (
	identifier,
	owner_identifier,
	kind,
	connector_identifier
)
VALUES (
	'email',
	'site.validation',
	'connector',
	'connector.validation.email'
);

INSERT INTO core.notification_channel_preferences (
	user_id,
	scope_kind,
	scope_identifier,
	channel_identifier,
	enabled,
	locale,
	quiet_start,
	quiet_end,
	timezone,
	digest_frequency
)
VALUES (
	'68000000-0000-4000-8000-000000000001',
	'topic',
	'validation.notification',
	'email',
	false,
	'fr-FR',
	'22:00:00',
	'07:00:00',
	'Europe/Paris',
	'daily'
);

INSERT INTO core.messaging_messages (
	id,
	topic_identifier,
	schema_version,
	producer_identifier,
	idempotency_key,
	priority,
	payload
)
VALUES (
	'68000000-0000-4000-8000-000000000002',
	'validation.notification',
	'1.0.0',
	'site.validation',
	'welcome-1',
	'normal',
	'{"displayName":"Example"}'::jsonb
);

INSERT INTO core.notifications (
	id,
	message_id,
	template_identifier,
	template_version,
	rendered_content,
	rendered_locale,
	purpose,
	mandatory
)
VALUES (
	'68000000-0000-4000-8000-000000000003',
	'68000000-0000-4000-8000-000000000002',
	'validation.welcome',
	'1.0.0',
	'{"title":"Bienvenue Example","summary":"Votre compte est prêt.","body":"Bonjour Example.","actions":[{"identifier":"open-account","label":"Ouvrir le compte","action":"core.account.open"}]}'::jsonb,
	'fr-FR',
	'account',
	true
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM core.messaging_channels
		WHERE identifier = 'inbox'
			AND kind = 'native'
			AND connector_identifier IS NULL
	) OR NOT EXISTS (
		SELECT 1
		FROM core.messaging_channels
		WHERE identifier = 'realtime'
			AND kind = 'native'
			AND connector_identifier IS NULL
	) THEN
		RAISE EXCEPTION 'Native messaging channels are incomplete.';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM core.messaging_templates
		WHERE identifier = 'validation.welcome'
			AND template_version = '1.0.0'
			AND fallback_locale = 'en'
			AND variable_definitions #>> '{displayName,classification}' = 'personal'
	) THEN
		RAISE EXCEPTION 'The versioned template metadata was not persisted.';
	END IF;

	IF (
		SELECT count(*)
		FROM core.messaging_template_localizations
		WHERE template_identifier = 'validation.welcome'
			AND template_version = '1.0.0'
	) <> 2 THEN
		RAISE EXCEPTION 'The localized template variants were not persisted.';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM core.messaging_channels
		WHERE identifier = 'email'
			AND kind = 'connector'
			AND connector_identifier = 'connector.validation.email'
	) THEN
		RAISE EXCEPTION 'The external channel is not bound to a connector.';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM core.notification_channel_preferences
		WHERE user_id = '68000000-0000-4000-8000-000000000001'
			AND scope_kind = 'topic'
			AND scope_identifier = 'validation.notification'
			AND channel_identifier = 'email'
			AND enabled = false
			AND locale = 'fr-FR'
			AND digest_frequency = 'daily'
	) THEN
		RAISE EXCEPTION 'The scoped notification preference was not persisted.';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM core.notifications
		WHERE id = '68000000-0000-4000-8000-000000000003'
			AND template_identifier = 'validation.welcome'
			AND template_version = '1.0.0'
			AND rendered_locale = 'fr-FR'
			AND purpose = 'account'
			AND mandatory = true
			AND rendered_content #>> '{title}' = 'Bienvenue Example'
	) THEN
		RAISE EXCEPTION 'The immutable localized notification rendering was not persisted.';
	END IF;
END;
$$;

ROLLBACK;

SELECT 'Core notification template validation succeeded.' AS result;
