CREATE TABLE IF NOT EXISTS core.messaging_templates (
	identifier TEXT NOT NULL,
	template_version TEXT NOT NULL,
	topic_identifier TEXT NOT NULL REFERENCES core.messaging_topics (identifier) ON DELETE RESTRICT,
	owner_identifier TEXT NOT NULL,
	fallback_locale TEXT NOT NULL,
	variable_definitions JSONB NOT NULL DEFAULT '{}'::jsonb,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (identifier, template_version)
);

CREATE INDEX IF NOT EXISTS messaging_templates_topic_idx
	ON core.messaging_templates (topic_identifier, active);

CREATE TABLE IF NOT EXISTS core.messaging_template_localizations (
	template_identifier TEXT NOT NULL,
	template_version TEXT NOT NULL,
	locale TEXT NOT NULL,
	title TEXT NOT NULL,
	summary TEXT,
	body TEXT NOT NULL,
	actions JSONB NOT NULL DEFAULT '[]'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (template_identifier, template_version, locale),
	FOREIGN KEY (template_identifier, template_version)
		REFERENCES core.messaging_templates (identifier, template_version) ON DELETE RESTRICT,
	CONSTRAINT messaging_template_localizations_locale_check CHECK (
		locale ~ '^[a-z]{2,3}(?:-[A-Z]{2})?$'
	),
	CONSTRAINT messaging_template_localizations_title_check CHECK (length(btrim(title)) > 0),
	CONSTRAINT messaging_template_localizations_body_check CHECK (length(btrim(body)) > 0)
);

CREATE TABLE IF NOT EXISTS core.messaging_channels (
	identifier TEXT PRIMARY KEY,
	owner_identifier TEXT NOT NULL,
	kind TEXT NOT NULL,
	connector_identifier TEXT,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT messaging_channels_kind_check CHECK (kind IN ('native', 'connector')),
	CONSTRAINT messaging_channels_connector_check CHECK (
		(kind = 'native' AND connector_identifier IS NULL)
		OR (kind = 'connector' AND connector_identifier IS NOT NULL)
	)
);

INSERT INTO core.messaging_channels (identifier, owner_identifier, kind)
VALUES
	('inbox', 'core', 'native'),
	('realtime', 'core', 'native')
ON CONFLICT (identifier) DO NOTHING;

CREATE TABLE IF NOT EXISTS core.notification_channel_preferences (
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	scope_kind TEXT NOT NULL,
	scope_identifier TEXT NOT NULL,
	channel_identifier TEXT NOT NULL REFERENCES core.messaging_channels (identifier) ON DELETE RESTRICT,
	enabled BOOLEAN NOT NULL,
	locale TEXT,
	quiet_start TIME,
	quiet_end TIME,
	timezone TEXT,
	digest_frequency TEXT,
	settings JSONB NOT NULL DEFAULT '{}'::jsonb,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, scope_kind, scope_identifier, channel_identifier),
	CONSTRAINT notification_channel_preferences_scope_check CHECK (
		scope_kind IN ('topic', 'family', 'purpose')
	),
	CONSTRAINT notification_channel_preferences_digest_check CHECK (
		digest_frequency IS NULL OR digest_frequency IN ('immediate', 'hourly', 'daily', 'weekly')
	),
	CONSTRAINT notification_channel_preferences_locale_check CHECK (
		locale IS NULL OR locale ~ '^[a-z]{2,3}(?:-[A-Z]{2})?$'
	),
	CONSTRAINT notification_channel_preferences_quiet_check CHECK (
		(quiet_start IS NULL AND quiet_end IS NULL)
		OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND timezone IS NOT NULL)
	)
);

ALTER TABLE core.notifications
	ADD COLUMN IF NOT EXISTS rendered_locale TEXT,
	ADD COLUMN IF NOT EXISTS purpose TEXT,
	ADD COLUMN IF NOT EXISTS mandatory BOOLEAN NOT NULL DEFAULT false;
