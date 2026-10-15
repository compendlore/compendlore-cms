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
	'localization-validation',
	'Localization Validation',
	'validation-only',
	now()
);

INSERT INTO core.localized_text_resources (
	id,
	contribution_key,
	namespace,
	resource_key,
	format,
	allow_instance_override,
	required
)
VALUES (
	'69000000-0000-4000-8000-000000000003',
	'module.site',
	'navigation',
	'home.title',
	'plain',
	true,
	true
);

INSERT INTO core.localized_text_values (
	id,
	resource_id,
	locale_tag,
	source_layer,
	source_contribution_key,
	value,
	revision,
	active,
	created_by
)
VALUES
	(
		'69000000-0000-4000-8000-000000000004',
		'69000000-0000-4000-8000-000000000003',
		'en',
		'owner',
		'module.site',
		'Home',
		1,
		true,
		NULL
	),
	(
		'69000000-0000-4000-8000-000000000005',
		'69000000-0000-4000-8000-000000000003',
		'fr-FR',
		'translation',
		'translation.site-fr',
		'Accueil',
		1,
		true,
		NULL
	),
	(
		'69000000-0000-4000-8000-000000000006',
		'69000000-0000-4000-8000-000000000003',
		'fr-FR',
		'instance',
		'instance.localization-validation',
		'Bienvenue',
		1,
		true,
		'69000000-0000-4000-8000-000000000001'
	);

INSERT INTO core.instance_locales (
	instance_id,
	locale_tag,
	enabled,
	display_order,
	is_default,
	fallback_locale_tag
)
VALUES
	(
		(SELECT id FROM core.instances LIMIT 1),
		'en',
		true,
		0,
		true,
		NULL
	),
	(
		(SELECT id FROM core.instances LIMIT 1),
		'fr-FR',
		true,
		1,
		false,
		'en'
	);

INSERT INTO core.translation_source_selections (
	instance_id,
	target_contribution_key,
	locale_tag,
	source_contribution_key,
	priority,
	enabled,
	updated_by
)
VALUES (
	(SELECT id FROM core.instances LIMIT 1),
	'module.site',
	'fr-FR',
	'translation.site-fr',
	0,
	true,
	'69000000-0000-4000-8000-000000000001'
);

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM core.localized_text_resources
		WHERE contribution_key = 'module.site'
			AND namespace = 'navigation'
			AND resource_key = 'home.title'
			AND allow_instance_override
			AND required
	) THEN
		RAISE EXCEPTION 'The localized resource contract was not persisted.';
	END IF;

	IF (
		SELECT count(*)
		FROM core.localized_text_values
		WHERE resource_id = '69000000-0000-4000-8000-000000000003'
			AND active
	) <> 3 THEN
		RAISE EXCEPTION 'The localization source layers were not persisted independently.';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM core.instance_locales
		WHERE instance_id = (SELECT id FROM core.instances LIMIT 1)
			AND locale_tag = 'fr-FR'
			AND fallback_locale_tag = 'en'
	) THEN
		RAISE EXCEPTION 'The instance locale fallback was not persisted.';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM core.translation_source_selections
		WHERE instance_id = (SELECT id FROM core.instances LIMIT 1)
			AND target_contribution_key = 'module.site'
			AND source_contribution_key = 'translation.site-fr'
			AND enabled
	) THEN
		RAISE EXCEPTION 'The selected translation source was not persisted.';
	END IF;
END;
$$;

ROLLBACK;

SELECT 'Core localization validation succeeded.' AS result;
