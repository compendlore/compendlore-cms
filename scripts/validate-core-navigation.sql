BEGIN;

INSERT INTO core.navigation_modes (
	id,
	contribution_key,
	version,
	parameter_schema,
	allowed_item_types
)
VALUES (
	'navigation-validation',
	'module.site',
	'1.0.0',
	'{}'::jsonb,
	ARRAY['brand', 'primary', 'action']::TEXT[]
);

INSERT INTO core.navigation_target_types (
	id,
	contribution_key,
	version,
	parameter_schema
)
VALUES (
	'route-validation',
	'module.site',
	'1.0.0',
	'{"path":{"type":"path","required":true}}'::jsonb
);

INSERT INTO core.navigation_mode_target_types (
	mode_id,
	target_type_id
)
VALUES (
	'navigation-validation',
	'route-validation'
);

INSERT INTO core.navigation_targets (
	id,
	contribution_key,
	identifier,
	mode_id,
	target_type_id,
	parameters,
	audience,
	definition_fingerprint
)
VALUES (
	'6b000000-0000-4000-8000-000000000001',
	'module.site',
	'validation.home',
	'navigation-validation',
	'route-validation',
	'{"path":"/"}'::jsonb,
	'public',
	'validation-target'
);

DO $$
DECLARE
	missing_table TEXT;
BEGIN
	SELECT expected.table_name
	INTO missing_table
	FROM (
		VALUES
			('navigation_modes'),
			('navigation_target_types'),
			('navigation_targets'),
			('navigation_links'),
			('navigation_items'),
			('navigation_item_states'),
			('navigation_brand_assignments'),
			('sidebars'),
			('sidebar_states'),
			('sidebar_items'),
			('sidebar_item_states'),
			('visibility_policies')
	) AS expected(table_name)
	WHERE to_regclass('core.' || expected.table_name) IS NULL
	LIMIT 1;

	IF missing_table IS NOT NULL THEN
		RAISE EXCEPTION 'Missing Core navigation table: %', missing_table;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM core.navigation_items
		WHERE contribution_key = 'module.site'
	) THEN
		RAISE EXCEPTION 'Native navigation data must be materialized by the Registry, not migrations';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM core.navigation_targets
		WHERE identifier = 'validation.home'
			AND parameters ->> 'path' = '/'
			AND audience = 'public'
	) THEN
		RAISE EXCEPTION 'Navigation target validation fixture was not persisted';
	END IF;
END
$$;

ROLLBACK;

SELECT 'Core navigation validation succeeded.' AS result;
