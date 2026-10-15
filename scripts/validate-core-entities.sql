BEGIN;

INSERT INTO core.measurement_definitions (
	id,
	identifier,
	contribution_key,
	dimension,
	precision,
	canonical_unit_key,
	definition_fingerprint
)
VALUES (
	'6a000000-0000-4000-8000-000000000001',
	'duration',
	'module.site',
	'time',
	6,
	'second',
	'validation-measurement'
);

INSERT INTO core.measurement_units (
	id,
	measurement_definition_id,
	unit_key,
	contribution_key,
	symbol_resource,
	system_key
)
VALUES (
	'6a000000-0000-4000-8000-000000000002',
	'6a000000-0000-4000-8000-000000000001',
	'second',
	'module.site',
	'core.measurement.second.symbol',
	'metric'
);

INSERT INTO core.measurement_conversion_versions (
	id,
	measurement_unit_id,
	version,
	conversion_kind,
	numerator,
	denominator,
	offset_value
)
VALUES (
	'6a000000-0000-4000-8000-000000000003',
	'6a000000-0000-4000-8000-000000000002',
	1,
	'rational',
	1,
	1,
	0
);

INSERT INTO core.taxonomy_vocabularies (
	id,
	identifier,
	contribution_key,
	hierarchical,
	extensibility,
	maximum_assignments,
	resource_types
)
VALUES (
	'6a000000-0000-4000-8000-000000000004',
	'entity-tags',
	'module.site',
	false,
	'open',
	20,
	'["entity"]'::jsonb
);

INSERT INTO core.taxonomy_terms (
	id,
	vocabulary_id,
	term_key,
	contribution_key,
	label_resource
)
VALUES (
	'6a000000-0000-4000-8000-000000000005',
	'6a000000-0000-4000-8000-000000000004',
	'validation',
	'module.site',
	'core.taxonomy.validation'
);

INSERT INTO core.taxonomy_term_aliases (
	term_id,
	locale,
	alias
)
VALUES (
	'6a000000-0000-4000-8000-000000000005',
	'fr',
	'validé'
);

DO $$
DECLARE
	missing_table TEXT;
BEGIN
	SELECT expected.table_name
	INTO missing_table
	FROM (
		VALUES
			('entity_field_types'),
			('entity_types'),
			('entity_type_versions'),
			('entity_field_definitions'),
			('entity_relation_definitions'),
			('entity_interfaces'),
			('entity_records'),
			('entity_revisions'),
			('entity_field_schema_nodes'),
			('entity_choice_sources'),
			('entity_projection_definitions'),
			('entity_interface_versions'),
			('entity_record_ownership'),
			('entity_record_shares'),
			('entity_record_relations'),
			('measurement_definitions'),
			('measurement_units'),
			('measurement_conversion_versions'),
			('taxonomy_vocabularies'),
			('taxonomy_terms'),
			('taxonomy_term_aliases'),
			('entity_record_terms'),
			('entity_search_documents'),
			('entity_rich_content_anchors'),
			('entity_import_jobs'),
			('entity_schema_evolution_plans')
	) AS expected(table_name)
	WHERE to_regclass('core.' || expected.table_name) IS NULL
	LIMIT 1;

	IF missing_table IS NOT NULL THEN
		RAISE EXCEPTION 'Missing Core entity catalog table: %', missing_table;
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM core.measurement_conversion_versions
		WHERE measurement_unit_id = '6a000000-0000-4000-8000-000000000002'
			AND version = 1
			AND denominator = 1
	) THEN
		RAISE EXCEPTION 'The versioned measurement conversion was not persisted.';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM core.taxonomy_term_aliases
		WHERE term_id = '6a000000-0000-4000-8000-000000000005'
			AND locale = 'fr'
			AND alias = 'validé'
	) THEN
		RAISE EXCEPTION 'The taxonomy alias was not persisted.';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM information_schema.tables
		WHERE table_schema = 'core'
			AND table_name LIKE 'entity_data_%'
	) THEN
		RAISE EXCEPTION 'Business entity data must not be created in the Core schema.';
	END IF;
END;
$$;

ROLLBACK;

SELECT 'Core entity foundation validation succeeded.' AS result;
