import type { CoreDatabase, SqlStatement, SqlValue, TransactionContext } from "../database.js";
import { CoreError } from "./errors.js";
import type { CoreJsonValue } from "./store.js";
import type {
	PhysicalColumn,
	PhysicalForeignKey,
	PhysicalIndex,
	PhysicalTableState,
	SchemaJournalEntry,
	SchemaPlan,
	SchemaPlanOperation,
	SchemaRuntime,
	SchemaValueType,
} from "./schema-runtime.js";

interface ColumnRow {
	column_name: string;
	data_type: string;
	udt_name: string;
	is_nullable: "NO" | "YES";
	column_default: string | null;
	character_maximum_length: number | null;
	numeric_precision: number | null;
	numeric_scale: number | null;
	is_primary: boolean;
	is_unique: boolean;
}

interface IndexRow {
	index_name: string;
	columns: string[];
	is_unique: boolean;
}

interface ForeignKeyRow {
	constraint_name: string;
	columns: string[];
	target_table: string;
	target_columns: string[];
	delete_action: "CASCADE" | "NO ACTION" | "RESTRICT" | "SET NULL";
}

interface JournalRow {
	id: string;
	contribution_key: string;
	owner_identifier: string;
	version: string;
	fingerprint: string;
	desired_state: SchemaJournalEntry["desiredState"];
	applied_state: SchemaJournalEntry["appliedState"];
	observed_state: SchemaJournalEntry["observedState"];
	plan: SchemaPlan;
	error: string | null;
	requested_at: Date;
	applied_at: Date | null;
}

export class PostgresSchemaRuntime implements SchemaRuntime {
	constructor(private readonly database: CoreDatabase) {}

	async inspect(tableName: string): Promise<PhysicalTableState | undefined> {
		validateIdentifier(tableName);
		const columns = await this.database.query<ColumnRow>(sql`
			/* pgsql */
			SELECT
				column_name,
				data_type,
				udt_name,
				is_nullable,
				column_default,
				character_maximum_length,
				numeric_precision,
				numeric_scale,
				EXISTS (
					SELECT 1
					FROM information_schema.table_constraints tc
					JOIN information_schema.key_column_usage kcu
						ON tc.constraint_name = kcu.constraint_name
						AND tc.constraint_schema = kcu.constraint_schema
					WHERE tc.table_schema = 'cms_data'
						AND tc.table_name = ${tableName}
						AND tc.constraint_type = 'PRIMARY KEY'
						AND kcu.column_name = columns.column_name
				) AS is_primary,
				EXISTS (
					SELECT 1
					FROM information_schema.table_constraints tc
					JOIN information_schema.key_column_usage kcu
						ON tc.constraint_name = kcu.constraint_name
						AND tc.constraint_schema = kcu.constraint_schema
					WHERE tc.table_schema = 'cms_data'
						AND tc.table_name = ${tableName}
						AND tc.constraint_type = 'UNIQUE'
						AND kcu.column_name = columns.column_name
				) AS is_unique
			FROM information_schema.columns AS columns
			WHERE table_schema = 'cms_data'
				AND table_name = ${tableName}
			ORDER BY ordinal_position
		`);
		if (columns.rowCount === 0) return undefined;
		const indexes = await this.readIndexes(tableName);
		const foreignKeys = await this.readForeignKeys(tableName);
		return {
			name: tableName,
			columns: columns.rows.map(mapColumn),
			indexes,
			foreignKeys,
			archived: tableName.includes("_archive_"),
		};
	}

	async apply(plan: SchemaPlan): Promise<SchemaJournalEntry> {
		const pending = journalEntry(plan, "pending", "unknown");
		await this.writeJournal(pending);
		try {
			await this.database.transaction(async (transaction) => {
				for (const operation of plan.operations) {
					await executeOperation(transaction, operation);
				}
			});
			const applied: SchemaJournalEntry = {
				...pending,
				appliedState: "applied",
				observedState: await this.observeAfter(plan),
				appliedAt: new Date(),
			};
			await this.updateJournal(applied);
			return applied;
		} catch (error) {
			const failed: SchemaJournalEntry = {
				...pending,
				appliedState: "rolled-back",
				observedState: "unknown",
				error: error instanceof Error ? error.message : "Échec inconnu.",
			};
			await this.updateJournal(failed);
			throw new CoreError("infrastructure.unavailable", "Le plan de schéma a été annulé.", {
				cause: error,
				retryable: true,
			});
		}
	}

	async history(contributionKey: string): Promise<readonly SchemaJournalEntry[]> {
		const result = await this.database.query<JournalRow>(sql`
			/* pgsql */
			SELECT
				id,
				contribution_key,
				owner_identifier,
				version,
				fingerprint,
				desired_state,
				applied_state,
				observed_state,
				plan,
				error,
				requested_at,
				applied_at
			FROM core.schema_journal
			WHERE contribution_key = ${contributionKey}
			ORDER BY requested_at DESC
		`);
		return result.rows.map(mapJournal);
	}

	private async observeAfter(plan: SchemaPlan): Promise<SchemaJournalEntry["observedState"]> {
		if (plan.desiredState === "archived") {
			const archived = plan.operations.find(
				(
					operation,
				): operation is Extract<SchemaPlanOperation, { readonly kind: "archive-table" }> =>
					operation.kind === "archive-table",
			);
			return archived && (await this.inspect(archived.archiveName)) ? "archived" : "unknown";
		}
		const exists = Boolean(await this.inspect(plan.resourceName));
		if (plan.desiredState === "absent") return exists ? "unknown" : "absent";
		return exists ? "active" : "unknown";
	}

	private async readIndexes(tableName: string): Promise<readonly PhysicalIndex[]> {
		const result = await this.database.query<IndexRow>(sql`
			/* pgsql */
			SELECT
				index_class.relname AS index_name,
				array_agg(attribute.attname ORDER BY keys.ordinality) AS columns,
				index.indisunique AS is_unique
			FROM pg_index AS index
			JOIN pg_class AS table_class ON table_class.oid = index.indrelid
			JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
			JOIN pg_class AS index_class ON index_class.oid = index.indexrelid
			JOIN unnest(index.indkey) WITH ORDINALITY AS keys(attribute_number, ordinality) ON TRUE
			JOIN pg_attribute AS attribute
				ON attribute.attrelid = table_class.oid
				AND attribute.attnum = keys.attribute_number
			WHERE namespace.nspname = 'cms_data'
				AND table_class.relname = ${tableName}
				AND NOT index.indisprimary
				AND NOT EXISTS (
					SELECT 1
					FROM pg_constraint
					WHERE conindid = index.indexrelid
				)
			GROUP BY index_class.relname, index.indisunique
		`);
		return result.rows.map((row) => ({
			name: row.index_name,
			columns: row.columns,
			unique: row.is_unique,
		}));
	}

	private async readForeignKeys(tableName: string): Promise<readonly PhysicalForeignKey[]> {
		const result = await this.database.query<ForeignKeyRow>(sql`
			/* pgsql */
			SELECT
				constraint_name,
				array_agg(column_name ORDER BY ordinal_position) AS columns,
				MAX(foreign_table_name) AS target_table,
				array_agg(foreign_column_name ORDER BY ordinal_position) AS target_columns,
				MAX(delete_rule) AS delete_action
			FROM (
				SELECT
					tc.constraint_name,
					kcu.column_name,
					kcu.ordinal_position,
					ccu.table_name AS foreign_table_name,
					ccu.column_name AS foreign_column_name,
					rc.delete_rule
				FROM information_schema.table_constraints tc
				JOIN information_schema.key_column_usage kcu
					ON tc.constraint_name = kcu.constraint_name
					AND tc.constraint_schema = kcu.constraint_schema
				JOIN information_schema.constraint_column_usage ccu
					ON ccu.constraint_name = tc.constraint_name
					AND ccu.constraint_schema = tc.constraint_schema
				JOIN information_schema.referential_constraints rc
					ON rc.constraint_name = tc.constraint_name
					AND rc.constraint_schema = tc.constraint_schema
				WHERE tc.table_schema = 'cms_data'
					AND tc.table_name = ${tableName}
					AND tc.constraint_type = 'FOREIGN KEY'
			) relations
			GROUP BY constraint_name
		`);
		return result.rows.map((row) => ({
			name: row.constraint_name,
			columns: row.columns,
			targetTable: row.target_table,
			targetColumns: row.target_columns,
			onDelete: mapDeleteAction(row.delete_action),
		}));
	}

	private writeJournal(entry: SchemaJournalEntry): Promise<unknown> {
		return this.database.query(sql`
			/* pgsql */
			INSERT INTO core.schema_journal (
				id, contribution_key, owner_identifier, version, fingerprint,
				desired_state, applied_state, observed_state, plan, error,
				requested_at, applied_at
			) VALUES (
				${entry.id}, ${entry.contributionKey}, ${entry.ownerIdentifier}, ${entry.version},
				${entry.fingerprint}, ${entry.desiredState}, ${entry.appliedState},
				${entry.observedState}, ${JSON.stringify(entry.plan)}, ${entry.error ?? null},
				${entry.requestedAt}, ${entry.appliedAt ?? null}
			)
		`);
	}

	private updateJournal(entry: SchemaJournalEntry): Promise<unknown> {
		return this.database.query(sql`
			/* pgsql */
			UPDATE core.schema_journal
			SET
				applied_state = ${entry.appliedState},
				observed_state = ${entry.observedState},
				error = ${entry.error ?? null},
				applied_at = ${entry.appliedAt ?? null}
			WHERE id = ${entry.id}
		`);
	}
}

async function executeOperation(
	transaction: TransactionContext,
	operation: SchemaPlanOperation,
): Promise<void> {
	const statements = statementsFor(operation);
	if (isBatched(operation)) {
		let affected: number;
		do {
			affected = (await transaction.query(statements[0]!)).rowCount;
		} while (affected === operation.batchSize);
		return;
	}
	for (const statement of statements) await transaction.query(statement);
}

function statementsFor(operation: SchemaPlanOperation): readonly SqlStatement[] {
	const table =
		"table" in operation
			? quote(typeof operation.table === "string" ? operation.table : operation.table.name)
			: "";
	switch (operation.kind) {
		case "create-table": {
			const primary = operation.table.columns
				.filter((column) => column.primary)
				.map((column) => quote(column.name));
			const definitions = operation.table.columns.map(columnSql);
			if (primary.length > 0) definitions.push(`PRIMARY KEY (${primary.join(", ")})`);
			const statements: SqlStatement[] = [
				raw(/* pgsql */ `CREATE TABLE cms_data.${table} (${definitions.join(", ")})`),
			];
			for (const index of operation.table.indexes)
				statements.push(indexStatement(operation.table.name, index));
			for (const foreignKey of operation.table.foreignKeys)
				statements.push(foreignKeyStatement(operation.table.name, foreignKey));
			return statements;
		}
		case "archive-table":
			return [
				raw(/* pgsql */ `ALTER TABLE cms_data.${table} RENAME TO ${quote(operation.archiveName)}`),
			];
		case "drop-table":
			return [raw(/* pgsql */ `DROP TABLE cms_data.${table}`)];
		case "add-column":
			return [
				raw(/* pgsql */ `ALTER TABLE cms_data.${table} ADD COLUMN ${columnSql(operation.column)}`),
			];
		case "drop-column":
			return [
				raw(/* pgsql */ `ALTER TABLE cms_data.${table} DROP COLUMN ${quote(operation.column)}`),
			];
		case "rename-column":
			return [
				raw(
					/* pgsql */ `ALTER TABLE cms_data.${table} RENAME COLUMN ${quote(operation.from)} TO ${quote(operation.to)}`,
				),
			];
		case "alter-column":
			return alterColumnStatements(operation.table, operation.column);
		case "replace-primary-key":
			return [
				raw(
					/* pgsql */ `ALTER TABLE cms_data.${table} DROP CONSTRAINT IF EXISTS ${quote(generatedConstraintName(operation.table, "pkey"))}${operation.columns.length > 0 ? `, ADD PRIMARY KEY (${operation.columns.map(quote).join(", ")})` : ""}`,
				),
			];
		case "create-index":
			return [indexStatement(operation.table, operation.index)];
		case "drop-index":
			return [raw(/* pgsql */ `DROP INDEX cms_data.${quote(operation.index)}`)];
		case "add-foreign-key":
			return [foreignKeyStatement(operation.table, operation.foreignKey)];
		case "drop-foreign-key":
			return [
				raw(
					/* pgsql */ `ALTER TABLE cms_data.${table} DROP CONSTRAINT ${quote(operation.foreignKey)}`,
				),
			];
		case "copy-column":
			return [
				batchUpdate(
					operation.table,
					`${quote(operation.to)} = ${quote(operation.from)}`,
					`${quote(operation.to)} IS DISTINCT FROM ${quote(operation.from)}`,
					operation.batchSize,
				),
			];
		case "fill-column":
			return [
				batchUpdate(
					operation.table,
					`${quote(operation.column)} = ${literal(operation.value)}`,
					`${quote(operation.column)} IS NULL`,
					operation.batchSize,
				),
			];
		case "transform-column": {
			const column = quote(operation.column);
			const expression = transformerExpression(operation.transformer, column);
			return [
				batchUpdate(
					operation.table,
					`${column} = ${expression}`,
					`${column} IS NOT NULL AND ${column} IS DISTINCT FROM ${expression}`,
					operation.batchSize,
				),
			];
		}
		case "merge-columns": {
			const expression = `concat_ws(${literal(operation.separator)}, ${operation.sources.map(quote).join(", ")})`;
			return [
				batchUpdate(
					operation.table,
					`${quote(operation.target)} = ${expression}`,
					`${quote(operation.target)} IS DISTINCT FROM ${expression}`,
					operation.batchSize,
				),
			];
		}
		case "split-column": {
			const expressions = operation.targets.map(
				(_target, index) =>
					`split_part(${quote(operation.source)}, ${literal(operation.separator)}, ${index + 1})`,
			);
			return [
				batchUpdate(
					operation.table,
					operation.targets
						.map((target, index) => `${quote(target)} = ${expressions[index]}`)
						.join(", "),
					`${quote(operation.source)} IS NOT NULL AND ROW(${operation.targets.map(quote).join(", ")}) IS DISTINCT FROM ROW(${expressions.join(", ")})`,
					operation.batchSize,
				),
			];
		}
	}
}

function columnSql(column: PhysicalColumn): string {
	const parts = [quote(column.name), typeSql(column)];
	if (!column.nullable) parts.push("NOT NULL");
	if (column.unique && !column.primary) parts.push("UNIQUE");
	if (column.defaultValue) parts.push(`DEFAULT ${defaultSql(column.defaultValue)}`);
	return parts.join(" ");
}

function alterColumnStatements(tableName: string, column: PhysicalColumn): readonly SqlStatement[] {
	const table = quote(tableName);
	const name = quote(column.name);
	const statements: SqlStatement[] = [
		raw(
			/* pgsql */ `ALTER TABLE cms_data.${table} ALTER COLUMN ${name} TYPE ${typeSql(column)} USING ${name}::${typeSql(column)}`,
		),
	];
	statements.push(
		raw(
			/* pgsql */ `ALTER TABLE cms_data.${table} ALTER COLUMN ${name} ${column.nullable ? "DROP" : "SET"} NOT NULL`,
		),
	);
	statements.push(
		raw(
			/* pgsql */ `ALTER TABLE cms_data.${table} ALTER COLUMN ${name} ${column.defaultValue ? `SET DEFAULT ${defaultSql(column.defaultValue)}` : "DROP DEFAULT"}`,
		),
	);
	const uniqueConstraint = quote(generatedConstraintName(tableName, column.name, "key"));
	statements.push(
		raw(
			/* pgsql */ `ALTER TABLE cms_data.${table} DROP CONSTRAINT IF EXISTS ${uniqueConstraint}${column.unique && !column.primary ? `, ADD CONSTRAINT ${uniqueConstraint} UNIQUE (${name})` : ""}`,
		),
	);
	return statements;
}

function indexStatement(tableName: string, index: PhysicalIndex): SqlStatement {
	return raw(
		/* pgsql */ `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(index.name)} ON cms_data.${quote(tableName)} (${index.columns.map(quote).join(", ")})`,
	);
}

function foreignKeyStatement(tableName: string, foreignKey: PhysicalForeignKey): SqlStatement {
	const action = { cascade: "CASCADE", restrict: "RESTRICT", "set-null": "SET NULL" }[
		foreignKey.onDelete
	];
	return raw(
		/* pgsql */ `ALTER TABLE cms_data.${quote(tableName)} ADD CONSTRAINT ${quote(foreignKey.name)} FOREIGN KEY (${foreignKey.columns.map(quote).join(", ")}) REFERENCES cms_data.${quote(foreignKey.targetTable)} (${foreignKey.targetColumns.map(quote).join(", ")}) ON DELETE ${action}`,
	);
}

function batchUpdate(
	tableName: string,
	assignment: string,
	predicate: string,
	batchSize: number,
): SqlStatement {
	return raw(
		/* pgsql */ `WITH batch AS (SELECT ctid FROM cms_data.${quote(tableName)} WHERE ${predicate} LIMIT ${batchSize} FOR UPDATE) UPDATE cms_data.${quote(tableName)} AS target SET ${assignment} FROM batch WHERE target.ctid = batch.ctid RETURNING target.ctid`,
	);
}

function isBatched(
	operation: SchemaPlanOperation,
): operation is Extract<SchemaPlanOperation, { readonly batchSize: number }> {
	return "batchSize" in operation;
}

function transformerExpression(transformer: string, column: string): string {
	switch (transformer) {
		case "integer.to-text":
			return `${column}::text`;
		case "json.to-text":
			return `${column}::text`;
		case "text.lowercase":
			return `lower(${column})`;
		case "text.to-integer":
			return `${column}::integer`;
		case "text.to-json":
			return `${column}::jsonb`;
		case "text.uppercase":
			return `upper(${column})`;
		default:
			throw new CoreError(
				"configuration.invalid",
				`Le transformateur ${transformer} est interdit.`,
			);
	}
}

function typeSql(column: PhysicalColumn): string {
	switch (column.type) {
		case "bigint":
			return "BIGINT";
		case "boolean":
			return "BOOLEAN";
		case "date":
			return "DATE";
		case "decimal":
			return `NUMERIC(${column.precision}, ${column.scale ?? 0})`;
		case "integer":
			return "INTEGER";
		case "json":
			return "JSONB";
		case "text":
			return "TEXT";
		case "timestamp":
			return "TIMESTAMPTZ";
		case "uuid":
			return "UUID";
		case "varchar":
			return `VARCHAR(${column.length})`;
	}
}

function defaultSql(value: NonNullable<PhysicalColumn["defaultValue"]>): string {
	if (value.kind === "now") return "CURRENT_TIMESTAMP";
	if (value.kind === "uuid") return "gen_random_uuid()";
	return literal(value.value);
}

function literal(value: CoreJsonValue): string {
	if (value === null) return "NULL";
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new CoreError("configuration.invalid", "Nombre SQL invalide.");
		return String(value);
	}
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	return `'${serialized.replaceAll("'", "''")}'`;
}

function quote(identifier: string): string {
	validateIdentifier(identifier);
	return `"${identifier}"`;
}

function validateIdentifier(identifier: string): void {
	if (!/^[a-z][a-z0-9_]{0,62}$/.test(identifier))
		throw new CoreError("configuration.invalid", "Identifiant SQL interdit.");
}

function generatedConstraintName(...parts: readonly string[]): string {
	return parts.join("_").slice(0, 63);
}

function raw(text: string, values: readonly SqlValue[] = []): SqlStatement {
	return { text, values };
}

function sql(strings: TemplateStringsArray, ...values: SqlValue[]): SqlStatement {
	return {
		text: strings.reduce(
			(statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ""),
			"",
		),
		values,
	};
}

function mapColumn(row: ColumnRow): PhysicalColumn {
	const type = mapType(row.data_type, row.udt_name);
	return {
		name: row.column_name,
		type,
		nullable: row.is_nullable === "YES",
		unique: row.is_unique,
		primary: row.is_primary,
		...(mapDefault(row.column_default) ? { defaultValue: mapDefault(row.column_default)! } : {}),
		...(row.character_maximum_length ? { length: row.character_maximum_length } : {}),
		...(row.numeric_precision ? { precision: row.numeric_precision } : {}),
		...(row.numeric_scale !== null ? { scale: row.numeric_scale } : {}),
	};
}

function mapDefault(value: string | null): PhysicalColumn["defaultValue"] | undefined {
	if (!value) return undefined;
	if (/gen_random_uuid\(\)/i.test(value)) return { kind: "uuid" };
	if (/^(?:CURRENT_TIMESTAMP|now\(\))/i.test(value)) return { kind: "now" };
	if (value === "true" || value === "false") {
		return { kind: "literal", value: value === "true" };
	}
	if (/^-?\d+(?:\.\d+)?$/.test(value)) return { kind: "literal", value: Number(value) };
	const quoted = /^'((?:''|[^'])*)'(?:::.*)?$/.exec(value);
	if (quoted) return { kind: "literal", value: quoted[1]!.replaceAll("''", "'") };
	return undefined;
}

function mapType(dataType: string, underlyingType: string): SchemaValueType {
	if (underlyingType === "uuid") return "uuid";
	if (underlyingType === "jsonb") return "json";
	if (underlyingType === "int8") return "bigint";
	if (underlyingType === "int4") return "integer";
	if (underlyingType === "timestamptz") return "timestamp";
	const mapping: Partial<Record<string, SchemaValueType>> = {
		boolean: "boolean",
		date: "date",
		numeric: "decimal",
		text: "text",
		"character varying": "varchar",
	};
	const mapped = mapping[dataType];
	if (!mapped)
		throw new CoreError("configuration.invalid", `Le type PostgreSQL ${dataType} est inconnu.`);
	return mapped;
}

function mapDeleteAction(action: ForeignKeyRow["delete_action"]): PhysicalForeignKey["onDelete"] {
	if (action === "CASCADE") return "cascade";
	if (action === "SET NULL") return "set-null";
	return "restrict";
}

function journalEntry(
	plan: SchemaPlan,
	appliedState: SchemaJournalEntry["appliedState"],
	observedState: SchemaJournalEntry["observedState"],
): SchemaJournalEntry {
	return {
		id: plan.id,
		contributionKey: plan.contributionKey,
		ownerIdentifier: plan.ownerIdentifier,
		version: plan.version,
		fingerprint: plan.fingerprint,
		desiredState: plan.desiredState,
		appliedState,
		observedState,
		plan,
		requestedAt: new Date(),
	};
}

function mapJournal(row: JournalRow): SchemaJournalEntry {
	return {
		id: row.id,
		contributionKey: row.contribution_key,
		ownerIdentifier: row.owner_identifier,
		version: row.version,
		fingerprint: row.fingerprint,
		desiredState: row.desired_state,
		appliedState: row.applied_state,
		observedState: row.observed_state,
		plan: row.plan,
		requestedAt: row.requested_at,
		...(row.applied_at ? { appliedAt: row.applied_at } : {}),
		...(row.error ? { error: row.error } : {}),
	};
}
