BEGIN;

DO $$
DECLARE
	missing_table TEXT;
BEGIN
	SELECT expected.table_name
	INTO missing_table
	FROM (
		VALUES
			('themes'),
			('theme_revisions'),
			('theme_asset_references'),
			('theme_publications'),
			('theme_assignments'),
			('theme_assignment_revisions'),
			('theme_projection_cache')
	) AS expected(table_name)
	WHERE to_regclass('core.' || expected.table_name) IS NULL
	LIMIT 1;

	IF missing_table IS NOT NULL THEN
		RAISE EXCEPTION 'Missing Core theme table: %', missing_table;
	END IF;

	IF to_regclass('core.theme_publications_one_active_idx') IS NULL THEN
		RAISE EXCEPTION 'The active theme publication index is missing';
	END IF;

	IF to_regclass('core.theme_projection_cache_active_idx') IS NULL THEN
		RAISE EXCEPTION 'The targeted theme projection cache index is missing';
	END IF;

	IF EXISTS (SELECT 1 FROM core.themes) THEN
		RAISE EXCEPTION 'Theme data must be materialized by Core operations, not migrations';
	END IF;
END
$$;

ROLLBACK;

SELECT 'Core theme persistence validation succeeded.' AS result;
