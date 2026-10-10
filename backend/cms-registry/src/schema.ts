import { randomUUID } from "node:crypto";
import {
	fingerprintSchema,
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
		if (destructive && !options.allowDestructive) {
			throw new RegistryError(
				"registry.contract_invalid",
				"Le changement de schéma est destructeur et exige une autorisation explicite.",
			);
		}
		return {
			id: randomUUID(),
			contributionKey: contribution.contributionKey,
			resourceName: contribution.schema.name,
			ownerKind: contribution.owner.kind,
			ownerIdentifier: contribution.owner.identifier,
			version: contribution.version,
			fingerprint: fingerprintSchema(asJson(contribution.schema)),
			desiredState: desiredPlanState(contribution, desiredState),
			operations,
			destructive,
			generatedAt: new Date(),
		};
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
		const observed = await this.core.inspect(contribution.schema.name);
		const plan = this.planner.plan(contribution, observed, options);
		const journal = await this.core.apply({
			plan,
			destructiveApproved: options.allowDestructive ?? false,
		});
		return { plan, journal };
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
				throw invalid(
					`Le renommage ${transformation.from} vers ${transformation.to} est impossible.`,
				);
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
						`La nouvelle colonne ${column.name} exige une valeur par défaut ou une transformation de remplissage.`,
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
				`La table ${contribution.schema.name} interdit son retrait.`,
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
	validateRegistryIdentifier(contribution.contributionKey);
	validateRegistryIdentifier(contribution.owner.identifier);
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(contribution.version)) {
		throw invalid("La version de table est invalide.");
	}
	const definition = contribution.schema;
	validateSqlIdentifier(definition.name);
	if (definition.columns.length === 0)
		throw invalid("Une table doit posséder au moins une colonne.");
	const columns = uniqueIdentifiers(
		definition.columns.map((column) => column.name),
		"colonne",
	);
	const primaryColumns = definition.columns.filter((column) => column.primary);
	if (primaryColumns.length === 0) throw invalid("Une table doit posséder une clé primaire.");
	for (const column of definition.columns) {
		validateColumn(column);
		if (column.primary && column.nullable)
			throw invalid("Une clé primaire ne peut pas être nullable.");
	}
	uniqueIdentifiers(
		(definition.indexes ?? []).map((index) => index.name),
		"index",
	);
	for (const index of definition.indexes ?? []) {
		if (index.columns.length === 0 || index.columns.some((column) => !columns.has(column))) {
			throw invalid(`L’index ${index.name} référence une colonne invalide.`);
		}
	}
	uniqueIdentifiers(
		(definition.foreignKeys ?? []).map((foreignKey) => foreignKey.name),
		"relation",
	);
	for (const foreignKey of definition.foreignKeys ?? []) {
		validateSqlIdentifier(foreignKey.targetTable);
		if (
			foreignKey.columns.length === 0 ||
			foreignKey.columns.length !== foreignKey.targetColumns.length ||
			foreignKey.columns.some((column) => !columns.has(column))
		) {
			throw invalid(`La relation ${foreignKey.name} est invalide.`);
		}
		foreignKey.targetColumns.forEach(validateSqlIdentifier);
	}
	for (const transformation of definition.transformations ?? []) {
		validateTransformation(transformation, transformers);
	}
}

function validateColumn(column: TableColumnDefinition): void {
	validateSqlIdentifier(column.name);
	if (column.type === "varchar" && (!column.length || column.length > 10_000)) {
		throw invalid(`La longueur de ${column.name} est invalide.`);
	}
	if (column.type === "decimal") {
		if (!column.precision || column.precision > 1_000 || (column.scale ?? 0) > column.precision) {
			throw invalid(`La précision de ${column.name} est invalide.`);
		}
	}
	if (column.defaultValue?.kind === "now" && !["date", "timestamp"].includes(column.type)) {
		throw invalid(`La valeur now n’est pas compatible avec ${column.name}.`);
	}
	if (column.defaultValue?.kind === "uuid" && column.type !== "uuid") {
		throw invalid(`La valeur uuid n’est pas compatible avec ${column.name}.`);
	}
}

function validateTransformation(
	transformation: TableTransformation,
	transformers: ReadonlySet<string>,
): void {
	const batchSize = "batchSize" in transformation ? (transformation.batchSize ?? 1_000) : 1_000;
	if (batchSize < 1 || batchSize > 100_000) throw invalid("La taille de lot est invalide.");
	switch (transformation.kind) {
		case "rename":
		case "copy":
			validateSqlIdentifier(transformation.from);
			validateSqlIdentifier(transformation.to);
			return;
		case "fill":
			validateSqlIdentifier(transformation.column);
			return;
		case "convert":
			validateSqlIdentifier(transformation.column);
			if (!transformers.has(transformation.transformer)) {
				throw invalid(`Le transformateur ${transformation.transformer} n’est pas enregistré.`);
			}
			return;
		case "merge":
			if (transformation.sources.length < 2) throw invalid("Une fusion exige deux sources.");
			transformation.sources.forEach(validateSqlIdentifier);
			validateSqlIdentifier(transformation.target);
			return;
		case "split":
			validateSqlIdentifier(transformation.source);
			if (transformation.targets.length < 2 || !transformation.separator) {
				throw invalid("Une séparation exige des cibles et un séparateur.");
			}
			transformation.targets.forEach(validateSqlIdentifier);
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
		throw invalid(`La transformation référence des colonnes absentes : ${missing.join(", ")}.`);
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
			if (!transformers.has(transformation.transformer)) throw invalid("Transformateur absent.");
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
		if (unique.has(value)) throw invalid(`L’identifiant de ${label} ${value} est dupliqué.`);
		unique.add(value);
	}
	return unique;
}

function validateSqlIdentifier(value: string): void {
	if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
		throw invalid(`L’identifiant SQL ${value} est invalide.`);
}

function validateRegistryIdentifier(value: string): void {
	if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value) || value.length > 160)
		throw invalid(`L’identifiant ${value} est invalide.`);
}

function asJson(value: unknown): CoreJsonValue {
	return JSON.parse(JSON.stringify(value)) as CoreJsonValue;
}

function invalid(message: string): RegistryError {
	return new RegistryError("registry.contract_invalid", message);
}
