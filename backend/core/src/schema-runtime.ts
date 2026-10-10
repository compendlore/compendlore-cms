import { createHash, randomUUID } from "node:crypto";
import { CoreError } from "./errors.js";
import type { CoreJsonValue } from "./store.js";

export type SchemaValueType =
	| "bigint"
	| "boolean"
	| "date"
	| "decimal"
	| "integer"
	| "json"
	| "text"
	| "timestamp"
	| "uuid"
	| "varchar";

export interface PhysicalColumn {
	readonly name: string;
	readonly type: SchemaValueType;
	readonly nullable: boolean;
	readonly unique: boolean;
	readonly primary: boolean;
	readonly defaultValue?:
		| { readonly kind: "literal"; readonly value: CoreJsonValue }
		| { readonly kind: "now" }
		| { readonly kind: "uuid" };
	readonly length?: number;
	readonly precision?: number;
	readonly scale?: number;
}

export interface PhysicalIndex {
	readonly name: string;
	readonly columns: readonly string[];
	readonly unique: boolean;
}

export interface PhysicalForeignKey {
	readonly name: string;
	readonly columns: readonly string[];
	readonly targetTable: string;
	readonly targetColumns: readonly string[];
	readonly onDelete: "cascade" | "restrict" | "set-null";
}

export interface PhysicalTableState {
	readonly name: string;
	readonly columns: readonly PhysicalColumn[];
	readonly indexes: readonly PhysicalIndex[];
	readonly foreignKeys: readonly PhysicalForeignKey[];
	readonly archived: boolean;
}

export type SchemaPlanOperation =
	| { readonly kind: "create-table"; readonly table: PhysicalTableState }
	| { readonly kind: "archive-table"; readonly table: string; readonly archiveName: string }
	| { readonly kind: "drop-table"; readonly table: string }
	| { readonly kind: "add-column"; readonly table: string; readonly column: PhysicalColumn }
	| { readonly kind: "drop-column"; readonly table: string; readonly column: string }
	| {
			readonly kind: "rename-column";
			readonly table: string;
			readonly from: string;
			readonly to: string;
	  }
	| { readonly kind: "alter-column"; readonly table: string; readonly column: PhysicalColumn }
	| {
			readonly kind: "replace-primary-key";
			readonly table: string;
			readonly columns: readonly string[];
	  }
	| { readonly kind: "create-index"; readonly table: string; readonly index: PhysicalIndex }
	| { readonly kind: "drop-index"; readonly table: string; readonly index: string }
	| {
			readonly kind: "add-foreign-key";
			readonly table: string;
			readonly foreignKey: PhysicalForeignKey;
	  }
	| { readonly kind: "drop-foreign-key"; readonly table: string; readonly foreignKey: string }
	| {
			readonly kind: "copy-column";
			readonly table: string;
			readonly from: string;
			readonly to: string;
			readonly batchSize: number;
	  }
	| {
			readonly kind: "fill-column";
			readonly table: string;
			readonly column: string;
			readonly value: CoreJsonValue;
			readonly batchSize: number;
	  }
	| {
			readonly kind: "transform-column";
			readonly table: string;
			readonly column: string;
			readonly transformer: string;
			readonly batchSize: number;
	  }
	| {
			readonly kind: "merge-columns";
			readonly table: string;
			readonly sources: readonly string[];
			readonly target: string;
			readonly separator: string;
			readonly batchSize: number;
	  }
	| {
			readonly kind: "split-column";
			readonly table: string;
			readonly source: string;
			readonly targets: readonly string[];
			readonly separator: string;
			readonly batchSize: number;
	  };

export interface SchemaPlan {
	readonly id: string;
	readonly contributionKey: string;
	readonly resourceName: string;
	readonly ownerKind: "addon" | "core" | "instance" | "native-module";
	readonly ownerIdentifier: string;
	readonly version: string;
	readonly fingerprint: string;
	readonly desiredState: "absent" | "active" | "archived" | "preserved";
	readonly operations: readonly SchemaPlanOperation[];
	readonly destructive: boolean;
	readonly generatedAt: Date;
}

export interface SchemaJournalEntry {
	readonly id: string;
	readonly contributionKey: string;
	readonly ownerIdentifier: string;
	readonly version: string;
	readonly fingerprint: string;
	readonly desiredState: SchemaPlan["desiredState"];
	readonly appliedState: "applied" | "failed" | "pending" | "rolled-back";
	readonly observedState: "absent" | "active" | "archived" | "unknown";
	readonly plan: SchemaPlan;
	readonly requestedAt: Date;
	readonly appliedAt?: Date;
	readonly error?: string;
}

export interface SchemaRuntime {
	inspect(tableName: string): Promise<PhysicalTableState | undefined>;
	apply(plan: SchemaPlan): Promise<SchemaJournalEntry>;
	history(contributionKey: string): Promise<readonly SchemaJournalEntry[]>;
}

export interface SchemaApplyRequest {
	readonly plan: SchemaPlan;
	readonly destructiveApproved: boolean;
}

export class CoreSchemaGateway {
	constructor(private readonly runtime: SchemaRuntime) {}

	inspect(tableName: string): Promise<PhysicalTableState | undefined> {
		validateSqlIdentifier(tableName);
		return this.runtime.inspect(tableName);
	}

	async apply(request: SchemaApplyRequest): Promise<SchemaJournalEntry> {
		validatePlan(request.plan);
		if (request.plan.destructive && !request.destructiveApproved) {
			throw new CoreError(
				"authorization.denied",
				"Le plan contient des opérations destructrices non autorisées.",
			);
		}
		return this.runtime.apply(request.plan);
	}

	history(contributionKey: string): Promise<readonly SchemaJournalEntry[]> {
		validateRegistryKey(contributionKey);
		return this.runtime.history(contributionKey);
	}
}

export class InMemorySchemaRuntime implements SchemaRuntime {
	private tables = new Map<string, PhysicalTableState>();
	private entries: SchemaJournalEntry[] = [];

	constructor(private readonly failAfterOperations?: number) {}

	async inspect(tableName: string): Promise<PhysicalTableState | undefined> {
		return this.tables.get(tableName);
	}

	async apply(plan: SchemaPlan): Promise<SchemaJournalEntry> {
		const before = new Map(this.tables);
		const requestedAt = new Date();
		const pending: SchemaJournalEntry = {
			id: randomUUID(),
			contributionKey: plan.contributionKey,
			ownerIdentifier: plan.ownerIdentifier,
			version: plan.version,
			fingerprint: plan.fingerprint,
			desiredState: plan.desiredState,
			appliedState: "pending",
			observedState: observedState(this.tables, plan),
			plan,
			requestedAt,
		};
		this.entries.push(pending);
		try {
			for (const [index, operation] of plan.operations.entries()) {
				if (this.failAfterOperations !== undefined && index >= this.failAfterOperations) {
					throw new Error("Interruption simulée du moteur de schéma.");
				}
				this.applyOperation(operation);
			}
			const applied: SchemaJournalEntry = {
				...pending,
				appliedState: "applied",
				observedState: observedState(this.tables, plan),
				appliedAt: new Date(),
			};
			this.entries[this.entries.length - 1] = applied;
			return applied;
		} catch (error) {
			this.tables = before;
			const failed: SchemaJournalEntry = {
				...pending,
				appliedState: "rolled-back",
				observedState: observedState(this.tables, plan),
				error: error instanceof Error ? error.message : "Échec inconnu.",
			};
			this.entries[this.entries.length - 1] = failed;
			throw new CoreError("infrastructure.unavailable", "Le plan de schéma a été annulé.", {
				cause: error,
				retryable: true,
			});
		}
	}

	async history(contributionKey: string): Promise<readonly SchemaJournalEntry[]> {
		return this.entries.filter((entry) => entry.contributionKey === contributionKey);
	}

	private applyOperation(operation: SchemaPlanOperation): void {
		switch (operation.kind) {
			case "create-table":
				this.tables.set(operation.table.name, operation.table);
				return;
			case "archive-table": {
				const table = this.requireTable(operation.table);
				this.tables.delete(operation.table);
				this.tables.set(operation.archiveName, {
					...table,
					name: operation.archiveName,
					archived: true,
				});
				return;
			}
			case "drop-table":
				this.tables.delete(operation.table);
				return;
			case "add-column":
				this.updateTable(operation.table, (table) => ({
					...table,
					columns: [...table.columns, operation.column],
				}));
				return;
			case "drop-column":
				this.updateTable(operation.table, (table) => ({
					...table,
					columns: table.columns.filter((column) => column.name !== operation.column),
				}));
				return;
			case "rename-column":
				this.updateTable(operation.table, (table) => ({
					...table,
					columns: table.columns.map((column) =>
						column.name === operation.from ? { ...column, name: operation.to } : column,
					),
				}));
				return;
			case "alter-column":
				this.updateTable(operation.table, (table) => ({
					...table,
					columns: table.columns.map((column) =>
						column.name === operation.column.name ? operation.column : column,
					),
				}));
				return;
			case "replace-primary-key":
				this.updateTable(operation.table, (table) => ({
					...table,
					columns: table.columns.map((column) => ({
						...column,
						primary: operation.columns.includes(column.name),
					})),
				}));
				return;
			case "create-index":
				this.updateTable(operation.table, (table) => ({
					...table,
					indexes: [...table.indexes, operation.index],
				}));
				return;
			case "drop-index":
				this.updateTable(operation.table, (table) => ({
					...table,
					indexes: table.indexes.filter((index) => index.name !== operation.index),
				}));
				return;
			case "add-foreign-key":
				this.updateTable(operation.table, (table) => ({
					...table,
					foreignKeys: [...table.foreignKeys, operation.foreignKey],
				}));
				return;
			case "drop-foreign-key":
				this.updateTable(operation.table, (table) => ({
					...table,
					foreignKeys: table.foreignKeys.filter(
						(foreignKey) => foreignKey.name !== operation.foreignKey,
					),
				}));
				return;
			case "copy-column":
			case "fill-column":
			case "transform-column":
			case "merge-columns":
			case "split-column":
				return;
		}
	}

	private requireTable(name: string): PhysicalTableState {
		const table = this.tables.get(name);
		if (!table) throw new Error(`La table ${name} est absente.`);
		return table;
	}

	private updateTable(
		name: string,
		update: (table: PhysicalTableState) => PhysicalTableState,
	): void {
		this.tables.set(name, update(this.requireTable(name)));
	}
}

export function fingerprintSchema(value: CoreJsonValue): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function validatePlan(plan: SchemaPlan): void {
	validateRegistryKey(plan.contributionKey);
	validateRegistryKey(plan.ownerIdentifier);
	validateSqlIdentifier(plan.resourceName);
	if (!/^[a-f0-9]{64}$/.test(plan.fingerprint)) {
		throw new CoreError("configuration.invalid", "L’empreinte du schéma est invalide.");
	}
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(plan.version)) {
		throw new CoreError("configuration.invalid", "La version du plan est invalide.");
	}
	if (plan.operations.length > 10_000) {
		throw new CoreError("configuration.invalid", "Le plan contient trop d’opérations.");
	}
	for (const operation of plan.operations) validateOperation(operation);
	const destructive = plan.operations.some((operation) =>
		["drop-column", "drop-table", "alter-column", "replace-primary-key"].includes(operation.kind),
	);
	if (destructive !== plan.destructive) {
		throw new CoreError("configuration.invalid", "Le niveau de risque du plan est incohérent.");
	}
}

function validateOperation(operation: SchemaPlanOperation): void {
	if ("table" in operation) {
		validateSqlIdentifier(
			typeof operation.table === "string" ? operation.table : operation.table.name,
		);
	}
	switch (operation.kind) {
		case "create-table":
			operation.table.columns.forEach(validatePhysicalColumn);
			operation.table.indexes.forEach(validatePhysicalIndex);
			operation.table.foreignKeys.forEach(validatePhysicalForeignKey);
			return;
		case "archive-table":
			validateSqlIdentifier(operation.archiveName);
			return;
		case "drop-table":
			return;
		case "add-column":
		case "alter-column":
			validatePhysicalColumn(operation.column);
			return;
		case "drop-column":
			validateSqlIdentifier(operation.column);
			return;
		case "rename-column":
			validateSqlIdentifier(operation.from);
			validateSqlIdentifier(operation.to);
			return;
		case "replace-primary-key":
			operation.columns.forEach(validateSqlIdentifier);
			return;
		case "create-index":
			validatePhysicalIndex(operation.index);
			return;
		case "drop-index":
			validateSqlIdentifier(operation.index);
			return;
		case "add-foreign-key":
			validatePhysicalForeignKey(operation.foreignKey);
			return;
		case "drop-foreign-key":
			validateSqlIdentifier(operation.foreignKey);
			return;
		case "copy-column":
			validateSqlIdentifier(operation.from);
			validateSqlIdentifier(operation.to);
			validateBatchSize(operation.batchSize);
			return;
		case "fill-column":
			validateSqlIdentifier(operation.column);
			validateBatchSize(operation.batchSize);
			assertJson(operation.value);
			return;
		case "transform-column":
			validateSqlIdentifier(operation.column);
			validateBatchSize(operation.batchSize);
			if (!safeTransformers.has(operation.transformer)) {
				throw new CoreError("configuration.invalid", "Le transformateur est interdit.");
			}
			return;
		case "merge-columns":
			operation.sources.forEach(validateSqlIdentifier);
			validateSqlIdentifier(operation.target);
			validateBatchSize(operation.batchSize);
			return;
		case "split-column":
			validateSqlIdentifier(operation.source);
			operation.targets.forEach(validateSqlIdentifier);
			validateBatchSize(operation.batchSize);
	}
}

const safeTypes = new Set<SchemaValueType>([
	"bigint",
	"boolean",
	"date",
	"decimal",
	"integer",
	"json",
	"text",
	"timestamp",
	"uuid",
	"varchar",
]);

const safeTransformers = new Set([
	"integer.to-text",
	"json.to-text",
	"text.lowercase",
	"text.to-integer",
	"text.to-json",
	"text.uppercase",
]);

function validatePhysicalColumn(column: PhysicalColumn): void {
	validateSqlIdentifier(column.name);
	if (!safeTypes.has(column.type)) {
		throw new CoreError("configuration.invalid", "Le type de colonne est interdit.");
	}
	if (column.type === "varchar" && (!column.length || column.length > 10_000)) {
		throw new CoreError("configuration.invalid", "La longueur de colonne est invalide.");
	}
	if (column.type === "decimal" && (!column.precision || (column.scale ?? 0) > column.precision)) {
		throw new CoreError("configuration.invalid", "La précision de colonne est invalide.");
	}
	if (column.defaultValue?.kind === "literal") assertJson(column.defaultValue.value);
}

function validatePhysicalIndex(index: PhysicalIndex): void {
	validateSqlIdentifier(index.name);
	if (index.columns.length === 0) {
		throw new CoreError("configuration.invalid", "Un index vide est interdit.");
	}
	index.columns.forEach(validateSqlIdentifier);
}

function validatePhysicalForeignKey(foreignKey: PhysicalForeignKey): void {
	validateSqlIdentifier(foreignKey.name);
	validateSqlIdentifier(foreignKey.targetTable);
	foreignKey.columns.forEach(validateSqlIdentifier);
	foreignKey.targetColumns.forEach(validateSqlIdentifier);
	if (
		foreignKey.columns.length === 0 ||
		foreignKey.columns.length !== foreignKey.targetColumns.length
	) {
		throw new CoreError("configuration.invalid", "La relation est invalide.");
	}
}

function validateBatchSize(value: number): void {
	if (!Number.isInteger(value) || value < 1 || value > 100_000) {
		throw new CoreError("configuration.invalid", "La taille de lot est invalide.");
	}
}

function assertJson(value: unknown): void {
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined || serialized.length > 1_048_576) throw new Error("invalid");
	} catch {
		throw new CoreError("configuration.invalid", "La valeur déclarative est invalide.");
	}
}

function validateSqlIdentifier(value: string): void {
	if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
		throw new CoreError("configuration.invalid", `L’identifiant SQL ${value} est invalide.`);
	}
}

function validateRegistryKey(value: string): void {
	if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value) || value.length > 160) {
		throw new CoreError("configuration.invalid", "L’identifiant de registre est invalide.");
	}
}

function observedState(
	tables: ReadonlyMap<string, PhysicalTableState>,
	plan: SchemaPlan,
): SchemaJournalEntry["observedState"] {
	if (plan.desiredState === "archived") {
		const archived = plan.operations.find(
			(operation): operation is Extract<SchemaPlanOperation, { readonly kind: "archive-table" }> =>
				operation.kind === "archive-table",
		);
		return archived && tables.has(archived.archiveName) ? "archived" : "unknown";
	}
	if (!tables.has(plan.resourceName)) return "absent";
	return "active";
}

function stableJson(value: CoreJsonValue): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([first], [second]) => first.localeCompare(second))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
