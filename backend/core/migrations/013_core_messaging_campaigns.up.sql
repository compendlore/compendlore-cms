CREATE TABLE IF NOT EXISTS core.messaging_segments (
	identifier TEXT PRIMARY KEY,
	owner_identifier TEXT NOT NULL,
	definition JSONB NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.messaging_actions (
	identifier TEXT PRIMARY KEY,
	owner_identifier TEXT NOT NULL,
	definition JSONB NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.messaging_subscription_definitions (
	identifier TEXT PRIMARY KEY,
	owner_identifier TEXT NOT NULL,
	topic_identifier TEXT NOT NULL REFERENCES core.messaging_topics (identifier) ON DELETE RESTRICT,
	definition JSONB NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.messaging_campaigns (
	id UUID PRIMARY KEY,
	owner_identifier TEXT NOT NULL,
	contribution_identifier TEXT NOT NULL,
	topic_identifier TEXT NOT NULL,
	schema_version TEXT NOT NULL,
	template_identifier TEXT NOT NULL,
	template_version TEXT NOT NULL,
	audience JSONB NOT NULL,
	variables JSONB NOT NULL,
	requested_locale TEXT NOT NULL,
	priority TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'draft',
	preview_digest TEXT,
	preview_recipient_count INTEGER,
	scheduled_at TIMESTAMPTZ,
	started_at TIMESTAMPTZ,
	completed_at TIMESTAMPTZ,
	cancelled_at TIMESTAMPTZ,
	revoked_at TIMESTAMPTZ,
	created_by UUID NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	FOREIGN KEY (topic_identifier, schema_version)
		REFERENCES core.messaging_topic_versions (topic_identifier, schema_version) ON DELETE RESTRICT,
	FOREIGN KEY (template_identifier, template_version)
		REFERENCES core.messaging_templates (identifier, template_version) ON DELETE RESTRICT,
	CONSTRAINT messaging_campaigns_priority_check CHECK (
		priority IN ('low', 'normal', 'high', 'critical')
	),
	CONSTRAINT messaging_campaigns_status_check CHECK (
		status IN ('draft', 'confirmed', 'scheduled', 'running', 'completed', 'cancelled', 'revoked', 'failed')
	),
	CONSTRAINT messaging_campaigns_locale_check CHECK (
		requested_locale ~ '^[a-z]{2,3}(?:-[A-Z]{2})?$'
	),
	CONSTRAINT messaging_campaigns_preview_count_check CHECK (
		preview_recipient_count IS NULL OR preview_recipient_count >= 0
	)
);

CREATE INDEX IF NOT EXISTS messaging_campaigns_due_idx
	ON core.messaging_campaigns (scheduled_at, created_at)
	WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS messaging_campaigns_owner_idx
	ON core.messaging_campaigns (owner_identifier, created_at DESC);
CREATE INDEX IF NOT EXISTS messaging_campaigns_contribution_idx
	ON core.messaging_campaigns (contribution_identifier, status);

CREATE TABLE IF NOT EXISTS core.messaging_campaign_events (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	campaign_id UUID NOT NULL REFERENCES core.messaging_campaigns (id) ON DELETE CASCADE,
	event_type TEXT NOT NULL,
	outcome TEXT NOT NULL,
	actor_id UUID REFERENCES core.users (id) ON DELETE SET NULL,
	correlation_id TEXT NOT NULL,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT messaging_campaign_events_outcome_check CHECK (
		outcome IN ('allowed', 'denied', 'failed')
	)
);

CREATE INDEX IF NOT EXISTS messaging_campaign_events_campaign_idx
	ON core.messaging_campaign_events (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messaging_campaign_events_correlation_idx
	ON core.messaging_campaign_events (correlation_id);
