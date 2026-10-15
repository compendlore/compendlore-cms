CREATE TABLE IF NOT EXISTS core.localized_text_resources (
	id UUID PRIMARY KEY,
	contribution_key TEXT NOT NULL,
	namespace TEXT NOT NULL,
	resource_key TEXT NOT NULL,
	format TEXT NOT NULL,
	allow_instance_override BOOLEAN NOT NULL DEFAULT false,
	required BOOLEAN NOT NULL DEFAULT false,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	archived_at TIMESTAMPTZ,
	CONSTRAINT localized_text_resources_identity_unique UNIQUE (
		contribution_key,
		namespace,
		resource_key
	),
	CONSTRAINT localized_text_resources_contribution_check CHECK (
		contribution_key ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
	),
	CONSTRAINT localized_text_resources_namespace_check CHECK (
		namespace ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
	),
	CONSTRAINT localized_text_resources_key_check CHECK (
		resource_key ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
	),
	CONSTRAINT localized_text_resources_format_check CHECK (
		format IN ('plain', 'multiline')
	)
);

CREATE INDEX IF NOT EXISTS localized_text_resources_contribution_idx
	ON core.localized_text_resources (contribution_key)
	WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS core.localized_text_values (
	id UUID PRIMARY KEY,
	resource_id UUID NOT NULL REFERENCES core.localized_text_resources (id) ON DELETE RESTRICT,
	locale_tag TEXT NOT NULL,
	source_layer TEXT NOT NULL,
	source_contribution_key TEXT NOT NULL,
	value TEXT NOT NULL,
	revision BIGINT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	created_by UUID REFERENCES core.users (id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT localized_text_values_revision_unique UNIQUE (
		resource_id,
		locale_tag,
		source_layer,
		source_contribution_key,
		revision
	),
	CONSTRAINT localized_text_values_locale_check CHECK (
		char_length(locale_tag) BETWEEN 2 AND 64
		AND locale_tag !~ '_'
	),
	CONSTRAINT localized_text_values_source_layer_check CHECK (
		source_layer IN ('owner', 'translation', 'instance')
	),
	CONSTRAINT localized_text_values_source_check CHECK (
		source_contribution_key ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
	),
	CONSTRAINT localized_text_values_value_check CHECK (
		char_length(btrim(value)) BETWEEN 1 AND 65536
	),
	CONSTRAINT localized_text_values_revision_check CHECK (revision > 0),
	CONSTRAINT localized_text_values_instance_actor_check CHECK (
		source_layer <> 'instance' OR created_by IS NOT NULL
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS localized_text_values_active_source_idx
	ON core.localized_text_values (
		resource_id,
		locale_tag,
		source_layer,
		source_contribution_key
	)
	WHERE active;

CREATE INDEX IF NOT EXISTS localized_text_values_resolution_idx
	ON core.localized_text_values (resource_id, locale_tag, active);

CREATE TABLE IF NOT EXISTS core.instance_locales (
	instance_id UUID NOT NULL REFERENCES core.instances (id) ON DELETE CASCADE,
	locale_tag TEXT NOT NULL,
	enabled BOOLEAN NOT NULL DEFAULT true,
	display_order INTEGER NOT NULL,
	is_default BOOLEAN NOT NULL DEFAULT false,
	fallback_locale_tag TEXT,
	flag_media_id UUID,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (instance_id, locale_tag),
	CONSTRAINT instance_locales_fallback_foreign_key FOREIGN KEY (
		instance_id,
		fallback_locale_tag
	) REFERENCES core.instance_locales (instance_id, locale_tag) DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT instance_locales_tag_check CHECK (
		char_length(locale_tag) BETWEEN 2 AND 64
		AND locale_tag !~ '_'
	),
	CONSTRAINT instance_locales_order_check CHECK (display_order >= 0),
	CONSTRAINT instance_locales_default_check CHECK (NOT is_default OR enabled),
	CONSTRAINT instance_locales_fallback_check CHECK (
		fallback_locale_tag IS NULL OR fallback_locale_tag <> locale_tag
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS instance_locales_default_idx
	ON core.instance_locales (instance_id)
	WHERE is_default;

CREATE UNIQUE INDEX IF NOT EXISTS instance_locales_display_order_idx
	ON core.instance_locales (instance_id, display_order)
	WHERE enabled;

CREATE TABLE IF NOT EXISTS core.translation_source_selections (
	instance_id UUID NOT NULL REFERENCES core.instances (id) ON DELETE CASCADE,
	target_contribution_key TEXT NOT NULL,
	locale_tag TEXT NOT NULL,
	source_contribution_key TEXT NOT NULL,
	priority INTEGER NOT NULL,
	enabled BOOLEAN NOT NULL DEFAULT true,
	updated_by UUID NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (
		instance_id,
		target_contribution_key,
		locale_tag,
		source_contribution_key
	),
	CONSTRAINT translation_source_selections_target_check CHECK (
		target_contribution_key ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
	),
	CONSTRAINT translation_source_selections_source_check CHECK (
		source_contribution_key ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
		AND source_contribution_key <> target_contribution_key
	),
	CONSTRAINT translation_source_selections_locale_check CHECK (
		char_length(locale_tag) BETWEEN 2 AND 64
		AND locale_tag !~ '_'
	),
	CONSTRAINT translation_source_selections_priority_check CHECK (priority >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS translation_source_selections_priority_idx
	ON core.translation_source_selections (
		instance_id,
		target_contribution_key,
		locale_tag,
		priority
	)
	WHERE enabled;
