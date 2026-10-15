BEGIN;

DO $$
DECLARE
	missing_table TEXT;
BEGIN
	SELECT expected.table_name
	INTO missing_table
	FROM (
		VALUES
			('pages'),
			('page_versions'),
			('page_routes'),
			('page_publications'),
			('page_imports')
	) AS expected(table_name)
	WHERE to_regclass('core.' || expected.table_name) IS NULL
	LIMIT 1;

	IF missing_table IS NOT NULL THEN
		RAISE EXCEPTION 'Missing Core page table: %', missing_table;
	END IF;

	IF EXISTS (SELECT 1 FROM core.pages) THEN
		RAISE EXCEPTION 'Page data must be materialized by Core operations, not migrations';
	END IF;
END
$$;

ROLLBACK;

SELECT 'Core page foundation validation succeeded.' AS result;
