CREATE TABLE IF NOT EXISTS core.messaging_topics (
	identifier TEXT PRIMARY KEY,
	owner_identifier TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.messaging_topic_versions (
	topic_identifier TEXT NOT NULL REFERENCES core.messaging_topics (identifier) ON DELETE RESTRICT,
	schema_version TEXT NOT NULL,
	definition JSONB NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (topic_identifier, schema_version)
);

CREATE TABLE IF NOT EXISTS core.messaging_messages (
	id UUID PRIMARY KEY,
	topic_identifier TEXT NOT NULL,
	schema_version TEXT NOT NULL,
	producer_identifier TEXT NOT NULL,
	correlation_id TEXT,
	idempotency_key TEXT,
	priority TEXT NOT NULL,
	payload JSONB NOT NULL,
	available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	expires_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	FOREIGN KEY (topic_identifier, schema_version)
		REFERENCES core.messaging_topic_versions (topic_identifier, schema_version) ON DELETE RESTRICT,
	CONSTRAINT messaging_messages_priority_check CHECK (priority IN ('low', 'normal', 'high', 'critical')),
	CONSTRAINT messaging_messages_expiration_check CHECK (expires_at IS NULL OR expires_at > created_at),
	UNIQUE (producer_identifier, topic_identifier, idempotency_key)
);

CREATE INDEX IF NOT EXISTS messaging_messages_available_idx
	ON core.messaging_messages (available_at, expires_at, created_at);
CREATE INDEX IF NOT EXISTS messaging_messages_correlation_idx
	ON core.messaging_messages (correlation_id, created_at)
	WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.messaging_audiences (
	id UUID PRIMARY KEY,
	message_id UUID NOT NULL REFERENCES core.messaging_messages (id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	selector JSONB NOT NULL,
	resolution_mode TEXT NOT NULL,
	resolved_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT messaging_audiences_kind_check CHECK (
		kind IN ('broadcast', 'capability', 'group', 'permission', 'role', 'team', 'user', 'user-list')
	),
	CONSTRAINT messaging_audiences_resolution_check CHECK (resolution_mode IN ('dynamic', 'snapshot'))
);

CREATE INDEX IF NOT EXISTS messaging_audiences_message_idx
	ON core.messaging_audiences (message_id);

CREATE TABLE IF NOT EXISTS core.messaging_recipients (
	message_id UUID NOT NULL REFERENCES core.messaging_messages (id) ON DELETE CASCADE,
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	audience_id UUID REFERENCES core.messaging_audiences (id) ON DELETE SET NULL,
	resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS messaging_recipients_user_idx
	ON core.messaging_recipients (user_id, resolved_at DESC);

CREATE TABLE IF NOT EXISTS core.messaging_outbox (
	id UUID PRIMARY KEY,
	message_id UUID NOT NULL UNIQUE REFERENCES core.messaging_messages (id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'pending',
	attempt_count INTEGER NOT NULL DEFAULT 0,
	available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	locked_at TIMESTAMPTZ,
	last_error_code TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT messaging_outbox_status_check CHECK (status IN ('pending', 'processing', 'published', 'failed', 'cancelled')),
	CONSTRAINT messaging_outbox_attempt_count_check CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS messaging_outbox_due_idx
	ON core.messaging_outbox (available_at, created_at)
	WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS core.messaging_deliveries (
	id UUID PRIMARY KEY,
	message_id UUID NOT NULL REFERENCES core.messaging_messages (id) ON DELETE CASCADE,
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	channel TEXT NOT NULL,
	device_identifier TEXT NOT NULL DEFAULT 'shared',
	status TEXT NOT NULL DEFAULT 'pending',
	next_attempt_at TIMESTAMPTZ,
	delivered_at TIMESTAMPTZ,
	expired_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT messaging_deliveries_channel_check CHECK (channel IN ('inbox', 'realtime')),
	CONSTRAINT messaging_deliveries_status_check CHECK (
		status IN ('pending', 'processing', 'delivered', 'acknowledged', 'expired', 'failed', 'cancelled')
	),
	UNIQUE (message_id, user_id, channel, device_identifier)
);

CREATE INDEX IF NOT EXISTS messaging_deliveries_due_idx
	ON core.messaging_deliveries (next_attempt_at, created_at)
	WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS messaging_deliveries_user_idx
	ON core.messaging_deliveries (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS core.messaging_delivery_attempts (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	delivery_id UUID NOT NULL REFERENCES core.messaging_deliveries (id) ON DELETE CASCADE,
	attempt_number INTEGER NOT NULL,
	result TEXT NOT NULL,
	error_code TEXT,
	occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT messaging_delivery_attempts_number_check CHECK (attempt_number > 0),
	CONSTRAINT messaging_delivery_attempts_result_check CHECK (result IN ('delivered', 'failed', 'unavailable')),
	UNIQUE (delivery_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS core.messaging_acknowledgements (
	delivery_id UUID NOT NULL REFERENCES core.messaging_deliveries (id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	PRIMARY KEY (delivery_id, kind),
	CONSTRAINT messaging_acknowledgements_kind_check CHECK (kind IN ('transport', 'processed', 'read', 'action'))
);

CREATE TABLE IF NOT EXISTS core.messaging_dead_letters (
	id UUID PRIMARY KEY,
	delivery_id UUID NOT NULL UNIQUE REFERENCES core.messaging_deliveries (id) ON DELETE CASCADE,
	reason_code TEXT NOT NULL,
	details JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	replayed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS core.messaging_cursors (
	consumer_identifier TEXT NOT NULL,
	partition_identifier TEXT NOT NULL,
	position BIGINT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (consumer_identifier, partition_identifier),
	CONSTRAINT messaging_cursors_position_check CHECK (position >= 0)
);

CREATE TABLE IF NOT EXISTS core.notifications (
	id UUID PRIMARY KEY,
	message_id UUID NOT NULL UNIQUE REFERENCES core.messaging_messages (id) ON DELETE CASCADE,
	template_identifier TEXT,
	template_version TEXT,
	rendered_content JSONB NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.notification_user_states (
	notification_id UUID NOT NULL REFERENCES core.notifications (id) ON DELETE CASCADE,
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	state TEXT NOT NULL DEFAULT 'unread',
	read_at TIMESTAMPTZ,
	processed_at TIMESTAMPTZ,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (notification_id, user_id),
	CONSTRAINT notification_user_states_state_check CHECK (state IN ('unread', 'read', 'hidden', 'archived', 'processed'))
);

CREATE INDEX IF NOT EXISTS notification_user_states_inbox_idx
	ON core.notification_user_states (user_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS core.notification_preferences (
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	scope_kind TEXT NOT NULL,
	scope_identifier TEXT NOT NULL,
	channel TEXT NOT NULL,
	enabled BOOLEAN NOT NULL,
	settings JSONB NOT NULL DEFAULT '{}'::jsonb,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, scope_kind, scope_identifier, channel),
	CONSTRAINT notification_preferences_scope_check CHECK (scope_kind IN ('topic', 'family', 'purpose')),
	CONSTRAINT notification_preferences_channel_check CHECK (channel IN ('inbox', 'realtime'))
);

CREATE TABLE IF NOT EXISTS core.messaging_subscriptions (
	id UUID PRIMARY KEY,
	user_id UUID NOT NULL REFERENCES core.users (id) ON DELETE CASCADE,
	topic_identifier TEXT NOT NULL REFERENCES core.messaging_topics (identifier) ON DELETE CASCADE,
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	UNIQUE (user_id, topic_identifier)
);

CREATE TABLE IF NOT EXISTS core.messaging_presence (
	session_id UUID NOT NULL REFERENCES core.sessions (id) ON DELETE CASCADE,
	device_identifier TEXT NOT NULL,
	connection_identifier TEXT NOT NULL,
	last_active_at TIMESTAMPTZ NOT NULL,
	expires_at TIMESTAMPTZ NOT NULL,
	PRIMARY KEY (session_id, device_identifier, connection_identifier),
	CONSTRAINT messaging_presence_expiration_check CHECK (expires_at > last_active_at)
);

CREATE INDEX IF NOT EXISTS messaging_presence_expiration_idx
	ON core.messaging_presence (expires_at);

