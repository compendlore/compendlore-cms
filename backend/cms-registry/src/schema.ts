import { randomUUID } from "node:crypto";
import {
	fingerprintSchema,
	schemaPlanIntegrity,
	schemaValueTypes,
	type CoreJsonValue,
	type PhysicalColumn,
	type PhysicalForeignKey,
	type PhysicalIndex,
	type PhysicalTableState,
	type SchemaJournalEntry,
	type SchemaPlan,
	type SchemaPlanOperation,
	type SchemaValueType,
} from "../../core/src/index.js";
import type { ContributionOwner, WithdrawalPolicy } from "./contracts.js";
import { RegistryError } from "./errors.js";

export interface TableColumnDefinition {
	readonly name: string;
	readonly type: SchemaValueType;
	readonly nullable?: boolean;
	readonly unique?: boolean;
	readonly primary?: boolean;
	readonly defaultValue?: PhysicalColumn["defaultValue"];
	readonly length?: number;
	readonly precision?: number;
	readonly scale?: number;
}

export interface TableIndexDefinition {
	readonly name: string;
	readonly columns: readonly string[];
	readonly unique?: boolean;
}

export interface TableForeignKeyDefinition {
	readonly name: string;
	readonly columns: readonly string[];
	readonly targetTable: string;
	readonly targetColumns: readonly string[];
	readonly onDelete?: "cascade" | "restrict" | "set-null";
}

export type TableTransformation =
	| { readonly kind: "rename"; readonly from: string; readonly to: string }
	| {
			readonly kind: "copy";
			readonly from: string;
			readonly to: string;
			readonly batchSize?: number;
	  }
	| {
			readonly kind: "fill";
			readonly column: string;
			readonly value: CoreJsonValue;
			readonly batchSize?: number;
	  }
	| {
			readonly kind: "convert";
			readonly column: string;
			readonly transformer: string;
			readonly batchSize?: number;
	  }
	| {
			readonly kind: "merge";
			readonly sources: readonly string[];
			readonly target: string;
			readonly separator?: string;
			readonly batchSize?: number;
	  }
	| {
			readonly kind: "split";
			readonly source: string;
			readonly targets: readonly string[];
			readonly separator: string;
			readonly batchSize?: number;
	  };

export interface TableSchemaDefinition {
	readonly name: string;
	readonly columns: readonly TableColumnDefinition[];
	readonly indexes?: readonly TableIndexDefinition[];
	readonly foreignKeys?: readonly TableForeignKeyDefinition[];
	readonly transformations?: readonly TableTransformation[];
}

export interface TableSchemaContribution {
	readonly contributionKey: string;
	readonly owner: ContributionOwner;
	readonly version: string;
	readonly withdrawalPolicy: WithdrawalPolicy;
	readonly schema: TableSchemaDefinition;
}

export interface SchemaPlanningOptions {
	readonly allowDestructive?: boolean;
	readonly desiredState?: "active" | "withdrawn";
}

export interface SchemaCorePort {
	inspect(tableName: string): Promise<PhysicalTableState | undefined>;
	apply(request: {
		readonly plan: SchemaPlan;
		readonly destructiveApproved: boolean;
	}): Promise<SchemaJournalEntry>;
	history(contributionKey: string): Promise<readonly SchemaJournalEntry[]>;
}

const builtInTransformers = new Set([
	"integer.to-text",
	"json.to-text",
	"text.lowercase",
	"text.to-integer",
	"text.to-json",
	"text.uppercase",
]);
const ownerKinds = new Set(["addon", "core", "instance", "native-module"]);
const withdrawalPolicies = new Set(["archive", "block-uninstall", "delete", "preserve-data"]);
const columnTypes = new Set<SchemaValueType>(schemaValueTypes);
const foreignKeyDeleteActions = new Set(["cascade", "restrict", "set-null"]);

export class SchemaPlanner {
	constructor(private readonly transformers: ReadonlySet<string> = builtInTransformers) {}

	plan(
		contribution: TableSchemaContribution,
		observed: PhysicalTableState | undefined,
		options: SchemaPlanningOptions = {},
	): SchemaPlan {
		validateTableContribution(contribution, this.transformers);
		const desiredState = options.desiredState ?? "active";
		const operations =
			desiredState === "withdrawn"
				? withdrawalOperations(contribution, observed)
				: deploymentOperations(contribution.schema, observed, this.transformers);
		const destructive = operations.some((operation) =>
			["alter-column", "drop-column", "drop-table", "replace-primary-key"].includes(operation.kind),
		);
		const unsignedPlan: Omit<SchemaPlan, "integrity"> = {
			id: randomUUID(),
			contributionKey: contribution.contributionKey,
			resourceName: contribution.schema.name,
			ownerKind: contribution.owner.kind,
			ownerIdentifier: contribution.owner.identifier,
			version: contribution.version,
			fingerprint: fingerprintSchema(asJson(contribution.schema)),
			observedFingerprint: fingerprintSchema(asJson(observed ?? null)),
			desiredState: desiredPlanState(contribution, desiredState),
			operations,
			destructive,
			generatedAt: new Date(),
		};
		return { ...unsignedPlan, integrity: schemaPlanIntegrity(unsignedPlan) };
	}
}

export class DeclarativeSchemaManager {
	constructor(
		private readonly core: SchemaCorePort,
		private readonly planner = new SchemaPlanner(),
	) {}

	async deploy(
		contribution: TableSchemaContribution,
		options: SchemaPlanningOptions = {},
	): Promise<{ readonly plan: SchemaPlan; readonly journal: SchemaJournalEntry }> {
		const plan = await this.preview(contribution, options);
		const journal = await this.core.apply({
			plan,
			destructiveApproved: options.allowDestructive ?? false,
		});
		return { plan, journal };
	}

	async preview(
		contribution: TableSchemaContribution,
		options: SchemaPlanningOptions = {},
	): Promise<SchemaPlan> {
		const observed = await this.core.inspect(contribution.schema.name);
		return this.planner.plan(contribution, observed, options);
	}

	async withdraw(
		contribution: TableSchemaContribution,
		destructiveApproved = false,
	): Promise<{ readonly plan: SchemaPlan; readonly journal: SchemaJournalEntry }> {
		return this.deploy(contribution, {
			desiredState: "withdrawn",
			allowDestructive: destructiveApproved,
		});
	}

	history(contributionKey: string): Promise<readonly SchemaJournalEntry[]> {
		return this.core.history(contributionKey);
	}
}

function deploymentOperations(
	definition: TableSchemaDefinition,
	observed: PhysicalTableState | undefined,
	transformers: ReadonlySet<string>,
): readonly SchemaPlanOperation[] {
	const desired = physicalTable(definition);
	if (!observed) return [{ kind: "create-table", table: desired }];
	const operations: SchemaPlanOperation[] = [];
	const alterOperations: SchemaPlanOperation[] = [];
	const dropColumnOperations: SchemaPlanOperation[] = [];
	const relationOperations: SchemaPlanOperation[] = [];
	const renamedFrom = new Set<string>();
	const renamedTo = new Set<string>();
	const renameSources = new Map<string, string>();
	const renameTargets = new Map<string, string>();
	const availableColumns = new Set(observed.columns.map((column) => column.name));
	for (const transformation of definition.transformations ?? []) {
		if (transformation.kind === "rename") {
			if (!availableColumns.has(transformation.from) || availableColumns.has(transformation.to)) {
				throw invalid(`Column ${transformation.from} cannot be renamed to ${transformation.to}.`);
			}
			operations.push({
				kind: "rename-column",
				table: definition.name,
				from: transformation.from,
				to: transformation.to,
			});
			renamedFrom.add(transformation.from);
			renamedTo.add(transformation.to);
			renameSources.set(transformation.to, transformation.from);
			renameTargets.set(transformation.from, transformation.to);
			availableColumns.delete(transformation.from);
			availableColumns.add(transformation.to);
		}
	}
	const observedColumns = new Map(observed.columns.map((column) => [column.name, column]));
	const desiredColumns = new Map(desired.columns.map((column) => [column.name, column]));
	const delayedAlters: SchemaPlanOperation[] = [];
	const populatedColumns = new Set(
		(definition.transformations ?? []).flatMap((transformation) => {
			switch (transformation.kind) {
				case "copy":
					return [transformation.to];
				case "fill":
					return [transformation.column];
				case "merge":
					return [transformation.target];
				case "split":
					return transformation.targets;
				case "convert":
				case "rename":
					return [];
			}
		}),
	);
	const observedPrimary = observed.columns
		.filter((column) => column.primary)
		.map((column) => renameTargets.get(column.name) ?? column.name);
	const desiredPrimary = desired.columns
		.filter((column) => column.primary)
		.map((column) => column.name);
	if (JSON.stringify(observedPrimary) !== JSON.stringify(desiredPrimary)) {
		alterOperations.push({
			kind: "replace-primary-key",
			table: definition.name,
			columns: desiredPrimary,
		});
	}
	for (const column of desired.columns) {
		if (renamedTo.has(column.name)) {
			const source = observedColumns.get(renameSources.get(column.name)!);
			if (source && !sameColumn({ ...source, name: column.name }, column)) {
				alterOperations.push({ kind: "alter-column", table: definition.name, column });
			}
			continue;
		}
		const current = observedColumns.get(column.name);
		if (!current) {
			if (!column.nullable && !column.defaultValue) {
				if (!populatedColumns.has(column.name)) {
					throw invalid(
						`New column ${column.name} requires a default value or a population transformation.`,
					);
				}
				operations.push({
					kind: "add-column",
					table: definition.name,
					column: { ...column, nullable: true },
				});
				delayedAlters.push({ kind: "alter-column", table: definition.name, column });
			} else {
				operations.push({ kind: "add-column", table: definition.name, column });
			}
			availableColumns.add(column.name);
		} else if (!sameColumn(current, column)) {
			alterOperations.push({ kind: "alter-column", table: definition.name, column });
		}
	}
	for (const column of observed.columns) {
		if (!desiredColumns.has(column.name) && !renamedFrom.has(column.name)) {
			dropColumnOperations.push({
				kind: "drop-column",
				table: definition.name,
				column: column.name,
			});
		}
	}
	diffIndexes(definition.name, observed.indexes, desired.indexes, relationOperations);
	diffForeignKeys(definition.name, observed.foreignKeys, desired.foreignKeys, relationOperations);
	operations.push(
		...relationOperations.filter((operation) =>
			["drop-index", "drop-foreign-key"].includes(operation.kind),
		),
	);
	for (const transformation of definition.transformations ?? []) {
		if (transformation.kind === "rename") continue;
		assertTransformationColumns(transformation, availableColumns);
		operations.push(transformationOperation(definition.name, transformation, transformers));
	}
	operations.push(...delayedAlters, ...alterOperations, ...dropColumnOperations);
	operations.push(
		...relationOperations.filter((operation) =>
			["create-index", "add-foreign-key"].includes(operation.kind),
		),
	);
	return operations;
}

function withdrawalOperations(
	contribution: TableSchemaContribution,
	observed: PhysicalTableState | undefined,
): readonly SchemaPlanOperation[] {
	if (!observed) return [];
	switch (contribution.withdrawalPolicy) {
		case "block-uninstall":
			throw new RegistryError(
				"registry.withdrawal_blocked",
				`Table ${contribution.schema.name} prevents its withdrawal.`,
			);
		case "preserve-data":
			return [];
		case "archive":
			return [
				{
					kind: "archive-table",
					table: contribution.schema.name,
					archiveName: archiveName(contribution.schema.name),
				},
			];
		case "delete":
			return [{ kind: "drop-table", table: contribution.schema.name }];
	}
}

function physicalTable(definition: TableSchemaDefinition): PhysicalTableState {
	return {
		name: definition.name,
		columns: definition.columns.map((column) => ({
			name: column.name,
			type: column.type,
			nullable: column.nullable ?? !column.primary,
			unique: column.unique ?? false,
			primary: column.primary ?? false,
			...(column.defaultValue ? { defaultValue: column.defaultValue } : {}),
			...(column.length ? { length: column.length } : {}),
			...(column.precision ? { precision: column.precision } : {}),
			...(column.scale !== undefined ? { scale: column.scale } : {}),
		})),
		indexes: (definition.indexes ?? []).map((index) => ({
			name: index.name,
			columns: index.columns,
			unique: index.unique ?? false,
		})),
		foreignKeys: (definition.foreignKeys ?? []).map((foreignKey) => ({
			name: foreignKey.name,
			columns: foreignKey.columns,
			targetTable: foreignKey.targetTable,
			targetColumns: foreignKey.targetColumns,
			onDelete: foreignKey.onDelete ?? "restrict",
		})),
		archived: false,
	};
}

function validateTableContribution(
	contribution: TableSchemaContribution,
	transformers: ReadonlySet<string>,
): void {
	if (!isRecord(contribution)) throw invalid("The table contribution must be an object.");
	validateRegistryIdentifier(contribution.contributionKey);
	if (!isRecord(contribution.owner) || !ownerKinds.has(contribution.owner.kind)) {
		throw invalid("The table owner is invalid.");
	}
	validateRegistryIdentifier(contribution.owner.identifier);
	if (!withdrawalPolicies.has(contribution.withdrawalPolicy)) {
		throw invalid("The table withdrawal policy is invalid.");
	}
	if (
		typeof contribution.version !== "string" ||
		!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(contribution.version)
	) {
		throw invalid("The table version is invalid.");
	}
	const definition = contribution.schema;
	if (!isRecord(definition)) throw invalid("The table schema must be an object.");
	validateSqlIdentifier(definition.name);
	assertRequiredArray(definition.columns, "columns");
	if (definition.columns.length === 0) throw invalid("A table must contain at least one column.");
	if (definition.columns.length > 512) throw invalid("The table declares too many columns.");
	for (const column of definition.columns) {
		if (!isRecord(column)) throw invalid("A column must be an object.");
	}
	assertOptionalArray(definition.indexes, "index");
	assertOptionalArray(definition.foreignKeys, "relationships");
	assertOptionalArray(definition.transformations, "transformations");
	if ((definition.indexes?.length ?? 0) > 512)
		throw invalid("The table declares too many indexes.");
	if ((definition.foreignKeys?.length ?? 0) > 256) {
		throw invalid("The table declares too many relationships.");
	}
	if ((definition.transformations?.length ?? 0) > 512) {
		throw invalid("The table declares too many transformations.");
	}
	const columns = uniqueIdentifiers(
		definition.columns.map((column) => column.name),
		"column",
	);
	const primaryColumns = definition.columns.filter((column) => column.primary);
	if (primaryColumns.length === 0) throw invalid("A table must have a primary key.");
	for (const column of definition.columns) {
		validateColumn(column);
		if (column.primary && column.nullable) throw invalid("A primary key cannot be nullable.");
	}
	uniqueIdentifiers(
		(definition.indexes ?? []).map((index) => index.name),
		"index",
	);
	for (const index of definition.indexes ?? []) {
		if (!isRecord(index)) throw invalid("An index must be an object.");
		assertRequiredArray(index.columns, "index columns");
		if (index.unique !== undefined && typeof index.unique !== "boolean") {
			throw invalid(`Index ${index.name} has an invalid uniqueness flag.`);
		}
		if (
			index.columns.length === 0 ||
			new Set(index.columns).size !== index.columns.length ||
			index.columns.some((column) => typeof column !== "string" || !columns.has(column))
		) {
			throw invalid(`Index ${index.name} references an invalid column.`);
		}
	}
	uniqueIdentifiers(
		(definition.foreignKeys ?? []).map((foreignKey) => foreignKey.name),
		"relationship",
	);
	for (const foreignKey of definition.foreignKeys ?? []) {
		if (!isRecord(foreignKey)) throw invalid("A relationship must be an object.");
		validateSqlIdentifier(foreignKey.targetTable);
		assertRequiredArray(foreignKey.columns, "relationship columns");
		assertRequiredArray(foreignKey.targetColumns, "target relationship columns");
		if (foreignKey.onDelete !== undefined && !foreignKeyDeleteActions.has(foreignKey.onDelete)) {
			throw invalid(`Relationship ${foreignKey.name} has an invalid delete action.`);
		}
		if (
			foreignKey.columns.length === 0 ||
			foreignKey.columns.length !== foreignKey.targetColumns.length ||
			new Set(foreignKey.columns).size !== foreignKey.columns.length ||
			new Set(foreignKey.targetColumns).size !== foreignKey.targetColumns.length ||
			foreignKey.columns.some((column) => typeof column !== "string" || !columns.has(column))
		) {
			throw invalid(`Relationship ${foreignKey.name} is invalid.`);
		}
		foreignKey.targetColumns.forEach(validateSqlIdentifier);
		if (
			foreignKey.onDelete === "set-null" &&
			foreignKey.columns.some(
				(name) => definition.columns.find((column) => column.name === name)?.nullable !== true,
			)
		) {
			throw invalid(`Relationship ${foreignKey.name} requires nullable local columns.`);
		}
	}
	for (const transformation of definition.transformations ?? []) {
		validateTransformation(transformation, transformers);
	}
}

function validateColumn(column: TableColumnDefinition): void {
	validateSqlIdentifier(column.name);
	if (!columnTypes.has(column.type)) throw invalid(`Column ${column.name} uses a forbidden type.`);
	for (const [attribute, value] of [
		["nullable", column.nullable],
		["unique", column.unique],
		["primary", column.primary],
	] as const) {
		if (value !== undefined && typeof value !== "boolean") {
			throw invalid(`Column ${column.name} has an invalid ${attribute} attribute.`);
		}
	}
	if (
		column.type === "varchar" &&
		(!Number.isSafeInteger(column.length) || column.length! < 1 || column.length! > 10_000)
	) {
		throw invalid(`Column ${column.name} has an invalid length.`);
	}
	if (column.type !== "varchar" && column.length !== undefined) {
		throw invalid(`Column ${column.name} cannot define a length for its type.`);
	}
	if (column.type === "decimal") {
		if (
			!Number.isSafeInteger(column.precision) ||
			column.precision! < 1 ||
			column.precision! > 1_000 ||
			!Number.isSafeInteger(column.scale ?? 0) ||
			(column.scale ?? 0) < 0 ||
			(column.scale ?? 0) > column.precision!
		) {
			throw invalid(`Column ${column.name} has an invalid precision.`);
		}
	} else if (column.precision !== undefined || column.scale !== undefined) {
		throw invalid(`Column ${column.name} cannot define precision for its type.`);
	}
	validateColumnDefault(column);
}

function validateColumnDefault(column: TableColumnDefinition): void {
	if (column.defaultValue === undefined) return;
	if (!isRecord(column.defaultValue))
		throw invalid(`Column ${column.name} has an invalid default value.`);
	if (column.defaultValue.kind === "now") {
		if (!["date", "timestamp"].includes(column.type)) {
			throw invalid(`The now default is incompatible with column ${column.name}.`);
		}
		return;
	}
	if (column.defaultValue.kind === "uuid") {
		if (column.type !== "uuid") {
			throw invalid(`The uuid default is incompatible with column ${column.name}.`);
		}
		return;
	}
	if (column.defaultValue.kind !== "literal" || !("value" in column.defaultValue)) {
		throw invalid(`Column ${column.name} uses a forbidden default value type.`);
	}
	assertJsonValue(column.defaultValue.value);
	const value = column.defaultValue.value;
	if (value === null) {
		if (column.primary || column.nullable === false) {
			throw invalid(`A null default is incompatible with column ${column.name}.`);
		}
		return;
	}
	const compatible =
		(column.type === "boolean" && typeof value === "boolean") ||
		(column.type === "integer" &&
			typeof value === "number" &&
			Number.isSafeInteger(value) &&
			value >= -2_147_483_648 &&
			value <= 2_147_483_647) ||
		(column.type === "bigint" && typeof value === "number" && Number.isSafeInteger(value)) ||
		(column.type === "decimal" && typeof value === "number" && Number.isFinite(value)) ||
		column.type === "json" ||
		(["text", "varchar"].includes(column.type) && typeof value === "string") ||
		(column.type === "uuid" &&
			typeof value === "string" &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) ||
		(column.type === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) ||
		(column.type === "timestamp" && typeof value === "string" && !Number.isNaN(Date.parse(value)));
	if (!compatible) throw invalid(`The default value is incompatible with column ${column.name}.`);
	if (column.type === "varchar" && typeof value === "string" && value.length > column.length!) {
		throw invalid(`The default value exceeds the length of column ${column.name}.`);
	}
}

function validateTransformation(
	transformation: TableTransformation,
	transformers: ReadonlySet<string>,
): void {
	if (!isRecord(transformation)) throw invalid("A transformation must be an object.");
	const batchSize = "batchSize" in transformation ? (transformation.batchSize ?? 1_000) : 1_000;
	if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100_000) {
		throw invalid("The batch size is invalid.");
	}
	switch (transformation.kind) {
		case "rename":
		case "copy":
			validateSqlIdentifier(transformation.from);
			validateSqlIdentifier(transformation.to);
			if (transformation.from === transformation.to) {
				throw invalid("A transformation must use two distinct columns.");
			}
			return;
		case "fill":
			validateSqlIdentifier(transformation.column);
			assertJsonValue(transformation.value);
			return;
		case "convert":
			validateSqlIdentifier(transformation.column);
			if (
				typeof transformation.transformer !== "string" ||
				!transformers.has(transformation.transformer)
			) {
				throw invalid("The requested transformer is not registered.");
			}
			return;
		case "merge": {
			assertRequiredArray(transformation.sources, "merge sources");
			if (
				transformation.sources.length < 2 ||
				new Set(transformation.sources).size !== transformation.sources.length
			) {
				throw invalid("A merge requires at least two distinct sources.");
			}
			transformation.sources.forEach(validateSqlIdentifier);
			validateSqlIdentifier(transformation.target);
			if (transformation.sources.includes(transformation.target)) {
				throw invalid("A merge target must be distinct from its sources.");
			}
			validateSeparator(transformation.separator, true);
			return;
		}
		case "split": {
			validateSqlIdentifier(transformation.source);
			assertRequiredArray(transformation.targets, "split targets");
			if (
				transformation.targets.length < 2 ||
				new Set(transformation.targets).size !== transformation.targets.length
			) {
				throw invalid("A split requires at least two distinct targets.");
			}
			transformation.targets.forEach(validateSqlIdentifier);
			if (transformation.targets.includes(transformation.source)) {
				throw invalid("Split targets must be distinct from the source.");
			}
			validateSeparator(transformation.separator, false);
			return;
		}
		default:
			throw invalid("The transformation type is forbidden.");
	}
}

function validateSeparator(value: unknown, optional: boolean): void {
	if (optional && value === undefined) return;
	if (typeof value !== "string" || (!optional && value.length === 0) || value.length > 256) {
		throw invalid("The transformation separator is invalid.");
	}
}

function assertTransformationColumns(
	transformation: Exclude<TableTransformation, { readonly kind: "rename" }>,
	available: ReadonlySet<string>,
): void {
	const required = (() => {
		switch (transformation.kind) {
			case "copy":
				return [transformation.from, transformation.to];
			case "fill":
			case "convert":
				return [transformation.column];
			case "merge":
				return [...transformation.sources, transformation.target];
			case "split":
				return [transformation.source, ...transformation.targets];
		}
	})();
	const missing = required.filter((column) => !available.has(column));
	if (missing.length > 0) {
		throw invalid(`The transformation references missing columns: ${missing.join(", ")}.`);
	}
}

function transformationOperation(
	name: string,
	transformation: Exclude<TableTransformation, { readonly kind: "rename" }>,
	transformers: ReadonlySet<string>,
): SchemaPlanOperation {
	const batchSize = transformation.batchSize ?? 1_000;
	switch (transformation.kind) {
		case "copy":
			return {
				kind: "copy-column",
				table: name,
				from: transformation.from,
				to: transformation.to,
				batchSize,
			};
		case "fill":
			return {
				kind: "fill-column",
				table: name,
				column: transformation.column,
				value: transformation.value,
				batchSize,
			};
		case "convert":
			if (!transformers.has(transformation.transformer)) {
				throw invalid("The transformer is not registered.");
			}
			return {
				kind: "transform-column",
				table: name,
				column: transformation.column,
				transformer: transformation.transformer,
				batchSize,
			};
		case "merge":
			return {
				kind: "merge-columns",
				table: name,
				sources: transformation.sources,
				target: transformation.target,
				separator: transformation.separator ?? "",
				batchSize,
			};
		case "split":
			return {
				kind: "split-column",
				table: name,
				source: transformation.source,
				targets: transformation.targets,
				separator: transformation.separator,
				batchSize,
			};
	}
}

function diffIndexes(
	name: string,
	observed: readonly PhysicalIndex[],
	desired: readonly PhysicalIndex[],
	operations: SchemaPlanOperation[],
): void {
	const current = new Map(observed.map((index) => [index.name, index]));
	const expected = new Map(desired.map((index) => [index.name, index]));
	for (const index of observed) {
		if (!expected.has(index.name) || !sameIndex(index, expected.get(index.name)!))
			operations.push({ kind: "drop-index", table: name, index: index.name });
	}
	for (const index of desired) {
		if (!current.has(index.name) || !sameIndex(index, current.get(index.name)!))
			operations.push({ kind: "create-index", table: name, index });
	}
}

function diffForeignKeys(
	name: string,
	observed: readonly PhysicalForeignKey[],
	desired: readonly PhysicalForeignKey[],
	operations: SchemaPlanOperation[],
): void {
	const current = new Map(observed.map((foreignKey) => [foreignKey.name, foreignKey]));
	const expected = new Map(desired.map((foreignKey) => [foreignKey.name, foreignKey]));
	for (const foreignKey of observed) {
		if (
			!expected.has(foreignKey.name) ||
			!sameForeignKey(foreignKey, expected.get(foreignKey.name)!)
		)
			operations.push({ kind: "drop-foreign-key", table: name, foreignKey: foreignKey.name });
	}
	for (const foreignKey of desired) {
		if (!current.has(foreignKey.name) || !sameForeignKey(foreignKey, current.get(foreignKey.name)!))
			operations.push({ kind: "add-foreign-key", table: name, foreignKey });
	}
}

function sameColumn(first: PhysicalColumn, second: PhysicalColumn): boolean {
	return (
		JSON.stringify({ ...first, primary: false }) === JSON.stringify({ ...second, primary: false })
	);
}

function sameIndex(first: PhysicalIndex, second: PhysicalIndex): boolean {
	return (
		first.unique === second.unique &&
		JSON.stringify(first.columns) === JSON.stringify(second.columns)
	);
}

function sameForeignKey(first: PhysicalForeignKey, second: PhysicalForeignKey): boolean {
	return (
		first.targetTable === second.targetTable &&
		first.onDelete === second.onDelete &&
		JSON.stringify(first.columns) === JSON.stringify(second.columns) &&
		JSON.stringify(first.targetColumns) === JSON.stringify(second.targetColumns)
	);
}

function desiredPlanState(
	contribution: TableSchemaContribution,
	desiredState: "active" | "withdrawn",
): SchemaPlan["desiredState"] {
	if (desiredState === "active") return "active";
	if (contribution.withdrawalPolicy === "archive") return "archived";
	if (contribution.withdrawalPolicy === "preserve-data") return "preserved";
	return "absent";
}

function archiveName(name: string): string {
	const suffix = Date.now().toString(36);
	return `${name.slice(0, 62 - suffix.length)}_${suffix}`;
}

function uniqueIdentifiers(values: readonly string[], label: string): ReadonlySet<string> {
	const unique = new Set<string>();
	for (const value of values) {
		validateSqlIdentifier(value);
		if (unique.has(value)) throw invalid(`The ${label} identifier ${value} is duplicated.`);
		unique.add(value);
	}
	return unique;
}

function validateSqlIdentifier(value: unknown): asserts value is string {
	if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
		throw invalid("A SQL identifier is invalid.");
	}
}

function validateRegistryIdentifier(value: unknown): asserts value is string {
	if (
		typeof value !== "string" ||
		!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value) ||
		value.length > 160
	) {
		throw invalid("A registry identifier is invalid.");
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRequiredArray(value: unknown, label: string): asserts value is readonly unknown[] {
	if (!Array.isArray(value)) throw invalid(`The ${label} declaration must be an array.`);
}

function assertOptionalArray(value: unknown, label: string): void {
	if (value !== undefined && !Array.isArray(value)) {
		throw invalid(`The ${label} declaration must be an array.`);
	}
}

function assertJsonValue(value: unknown, seen = new Set<object>()): asserts value is CoreJsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw invalid("A literal number must be finite.");
		return;
	}
	if (typeof value !== "object") throw invalid("A literal value must be serializable.");
	if (seen.has(value)) throw invalid("A literal value contains a cycle.");
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) assertJsonValue(item, seen);
	} else {
		const prototype = Object.getPrototypeOf(value) as object | null;
		if (prototype !== Object.prototype && prototype !== null) {
			throw invalid("A literal value must be a plain JSON object.");
		}
		for (const item of Object.values(value as Record<string, unknown>)) {
			assertJsonValue(item, seen);
		}
	}
	seen.delete(value);
}

function asJson(value: unknown): CoreJsonValue {
	return JSON.parse(JSON.stringify(value)) as CoreJsonValue;
}

function invalid(message: string): RegistryError {
	return new RegistryError("registry.contract_invalid", message);
}
