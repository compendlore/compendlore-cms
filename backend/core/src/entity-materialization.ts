import { createHash, randomUUID } from "node:crypto";
import type { ResolvedEntityType } from "./entities.js";
import {
	fingerprintSchema,
	schemaPlanIntegrity,
	type CoreSchemaGateway,
	type PhysicalColumn,
	type PhysicalTableState,
	type SchemaJournalEntry,
	type SchemaPlan,
} from "./schema-runtime.js";
import type { CoreJsonValue } from "./store.js";

export type EntityDataSegment = "collections" | "records" | "relations" | "translations";

export interface EntityDataMaterializationPreview {
	readonly entityType: string;
	readonly tables: Readonly<Record<EntityDataSegment, string>>;
	readonly plans: readonly SchemaPlan[];
}

export class EntityDataMaterializer {
	constructor(private readonly schema: CoreSchemaGateway) {}

	async preview(type: ResolvedEntityType): Promise<EntityDataMaterializationPreview> {
		const tables = entityDataTables(type.identifier);
		const plans: SchemaPlan[] = [];
		for (const [segment, tableName] of Object.entries(tables) as [EntityDataSegment, string][]) {
			const observed = await this.schema.inspect(tableName);
			plans.push(createPlan(type, segment, tableName, observed));
		}
		return { entityType: type.identifier, tables, plans };
	}

	async materialize(type: ResolvedEntityType): Promise<{
		readonly preview: EntityDataMaterializationPreview;
		readonly journal: readonly SchemaJournalEntry[];
	}> {
		const preview = await this.preview(type);
		const journal: SchemaJournalEntry[] = [];
		for (const plan of preview.plans) {
			if (plan.operations.length === 0) continue;
			journal.push(await this.schema.apply({ plan, destructiveApproved: false }));
		}
		return { preview, journal };
	}
}

export function entityDataTables(entityType: string): Readonly<Record<EntityDataSegment, string>> {
	const digest = createHash("sha256").update(entityType).digest("hex").slice(0, 16);
	const prefix = `entity_${digest}`;
	return {
		records: prefix,
		translations: `${prefix}_i18n`,
		collections: `${prefix}_items`,
		relations: `${prefix}_relations`,
	};
}

function createPlan(
	type: ResolvedEntityType,
	segment: EntityDataSegment,
	tableName: string,
	observed: PhysicalTableState | undefined,
): SchemaPlan {
	const table = physicalTable(segment, tableName);
	const unsigned: Omit<SchemaPlan, "integrity"> = {
		id: randomUUID(),
		contributionKey: `${type.ownerContributionKey}.entity-data.${segment}`,
		resourceName: tableName,
		ownerKind: "native-module",
		ownerIdentifier: type.ownerContributionKey,
		version: `${type.version}.0.0`,
		fingerprint: fingerprintSchema(
			asJson({
				entityType: type.identifier,
				entityTypeVersion: type.version,
				segment,
				effectiveFields: type.effectiveFields,
				table,
			}),
		),
		observedFingerprint: fingerprintSchema(asJson(observed ?? null)),
		desiredState: "active",
		operations: observed ? [] : [{ kind: "create-table", table }],
		destructive: false,
		generatedAt: new Date(),
	};
	return { ...unsigned, integrity: schemaPlanIntegrity(unsigned) };
}

function physicalTable(segment: EntityDataSegment, name: string): PhysicalTableState {
	const baseColumns: readonly PhysicalColumn[] = [
		column("record_id", "uuid", false, true),
		column("entity_type_version", "integer", false),
		column("revision", "bigint", false),
		column("updated_at", "timestamp", false),
	];
	const segmentColumns: Record<EntityDataSegment, readonly PhysicalColumn[]> = {
		records: [
			...baseColumns,
			column("public_identifier", "text", false),
			column("editorial_status", "text", false),
			column("values", "json", false),
		],
		translations: [
			...baseColumns,
			column("locale", "varchar", false, true, 64),
			column("values", "json", false),
		],
		collections: [
			...baseColumns,
			column("field_key", "varchar", false, true, 128),
			column("position", "integer", false, true),
			column("value", "json", false),
		],
		relations: [
			...baseColumns,
			column("relation_key", "varchar", false, true, 128),
			column("target_record_id", "uuid", false, true),
			column("position", "integer", false),
		],
	};
	const uniqueColumns =
		segment === "records"
			? ["public_identifier"]
			: segment === "translations"
				? ["record_id", "locale"]
				: segment === "collections"
					? ["record_id", "field_key", "position"]
					: ["record_id", "relation_key", "target_record_id"];
	return {
		name,
		columns: segmentColumns[segment],
		indexes: [
			{
				name: `${name}_lookup_idx`,
				columns: uniqueColumns,
				unique: true,
			},
		],
		foreignKeys: [],
		archived: false,
	};
}

function column(
	name: string,
	type: PhysicalColumn["type"],
	primary: boolean,
	unique = false,
	length?: number,
): PhysicalColumn {
	return {
		name,
		type,
		nullable: false,
		unique,
		primary,
		...(length === undefined ? {} : { length }),
	};
}

function asJson(value: unknown): CoreJsonValue {
	return JSON.parse(JSON.stringify(value)) as CoreJsonValue;
}
