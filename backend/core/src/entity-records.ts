import { randomUUID } from "node:crypto";
import { CoreError } from "./errors.js";
import type { CoreJsonValue } from "./store.js";
import type { EntityCatalogResolutionPort, ResolvedEntityType } from "./entities.js";

export type EntityEditorialStatus = "archived" | "draft" | "published" | "review";

export interface EntityPrincipal {
	readonly id: string;
	readonly capabilities: ReadonlySet<string>;
}

export interface EntityOwnership {
	readonly kind: "group" | "instance" | "user";
	readonly identifier: string;
}

export interface EntityRecordSnapshot {
	readonly recordId: string;
	readonly entityType: string;
	readonly entityTypeVersion: number;
	readonly publicIdentifier: string;
	readonly status: EntityEditorialStatus;
	readonly revision: number;
	readonly authorId: string;
	readonly owner: EntityOwnership;
	readonly values: Readonly<Record<string, CoreJsonValue>>;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly archivedAt?: Date;
}

export interface EntityRevision {
	readonly recordId: string;
	readonly revision: number;
	readonly snapshot: EntityRecordSnapshot;
	readonly createdBy: string;
	readonly createdAt: Date;
	readonly restoredFromRevision?: number;
}

export interface EntityRecordRepository {
	create(record: EntityRecordSnapshot, revision: EntityRevision): Promise<void>;
	get(recordId: string): Promise<EntityRecordSnapshot | undefined>;
	list(): Promise<readonly EntityRecordSnapshot[]>;
	update(record: EntityRecordSnapshot, revision: EntityRevision): Promise<void>;
	listRevisions(recordId: string): Promise<readonly EntityRevision[]>;
}

export interface EntityRecordEventPublisher {
	publish(event: {
		readonly kind: "created" | "restored" | "updated";
		readonly recordId: string;
		readonly revision: number;
		readonly entityType: string;
		readonly occurredAt: Date;
	}): Promise<void>;
}

export interface EntityQuery {
	readonly entityType: string;
	readonly filter?: Readonly<Record<string, CoreJsonValue>>;
	readonly sort?: { readonly field: string; readonly direction: "asc" | "desc" };
	readonly afterRecordId?: string;
	readonly limit: number;
}

export interface EntityQueryResult {
	readonly items: readonly EntityRecordSnapshot[];
	readonly nextCursor?: string;
}

export interface EntityExportDocument {
	readonly format: "compendlore.entities";
	readonly version: 1;
	readonly exportedAt: string;
	readonly records: readonly {
		readonly sourceId: string;
		readonly entityType: string;
		readonly publicIdentifier: string;
		readonly status: EntityEditorialStatus;
		readonly values: Readonly<Record<string, CoreJsonValue>>;
	}[];
}

export class EntityRecordService {
	constructor(
		private readonly catalog: EntityCatalogResolutionPort,
		private readonly repository: EntityRecordRepository,
		private readonly now: () => Date = () => new Date(),
		private readonly events?: EntityRecordEventPublisher,
	) {}

	async create(
		input: {
			readonly entityType: string;
			readonly publicIdentifier: string;
			readonly values: Readonly<Record<string, CoreJsonValue>>;
			readonly owner: EntityOwnership;
		},
		principal: EntityPrincipal,
	): Promise<EntityRecordSnapshot> {
		this.authorize(principal, "entity.create");
		const type = await this.catalog.resolveEntityType(input.entityType);
		if (type.abstract) throw invalid("An abstract entity type cannot create records.");
		validatePublicIdentifier(input.publicIdentifier);
		await this.assertPublicIdentifierUnique(type, input.publicIdentifier);
		validateValues(type, input.values, false);
		const timestamp = this.now();
		const record: EntityRecordSnapshot = {
			recordId: randomUUID(),
			entityType: type.identifier,
			entityTypeVersion: type.version,
			publicIdentifier: input.publicIdentifier,
			status: "draft",
			revision: 1,
			authorId: principal.id,
			owner: structuredClone(input.owner),
			values: structuredClone(input.values),
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		await this.repository.create(record, revisionOf(record, principal.id, timestamp));
		await this.events?.publish({
			kind: "created",
			recordId: record.recordId,
			revision: record.revision,
			entityType: record.entityType,
			occurredAt: timestamp,
		});
		return cloneRecord(record);
	}

	async update(
		recordId: string,
		input: {
			readonly expectedRevision: number;
			readonly values: Readonly<Record<string, CoreJsonValue>>;
			readonly status?: EntityEditorialStatus;
		},
		principal: EntityPrincipal,
	): Promise<EntityRecordSnapshot> {
		this.authorize(principal, "entity.update");
		const current = await this.requireRecord(recordId);
		if (current.revision !== input.expectedRevision) {
			throw conflict("The entity record revision is stale.");
		}
		this.authorizeOwnership(current, principal);
		const type = await this.catalog.resolveEntityType(current.entityType);
		const status = input.status ?? current.status;
		if (status === "published") this.authorize(principal, "entity.publish");
		validateValues(type, input.values, status === "published");
		const timestamp = this.now();
		const updated: EntityRecordSnapshot = {
			...current,
			status,
			revision: current.revision + 1,
			values: structuredClone(input.values),
			updatedAt: timestamp,
			...(status === "archived" ? { archivedAt: timestamp } : {}),
		};
		await this.repository.update(updated, revisionOf(updated, principal.id, timestamp));
		await this.events?.publish({
			kind: "updated",
			recordId: updated.recordId,
			revision: updated.revision,
			entityType: updated.entityType,
			occurredAt: timestamp,
		});
		return cloneRecord(updated);
	}

	async restore(
		recordId: string,
		revision: number,
		expectedRevision: number,
		principal: EntityPrincipal,
	): Promise<EntityRecordSnapshot> {
		this.authorize(principal, "entity.restore");
		const current = await this.requireRecord(recordId);
		if (current.revision !== expectedRevision)
			throw conflict("The entity record revision is stale.");
		const source = (await this.repository.listRevisions(recordId)).find(
			(candidate) => candidate.revision === revision,
		);
		if (!source) throw invalid("The entity revision does not exist.");
		const timestamp = this.now();
		const restored: EntityRecordSnapshot = {
			...cloneRecord(source.snapshot),
			revision: current.revision + 1,
			updatedAt: timestamp,
		};
		await this.repository.update(restored, {
			...revisionOf(restored, principal.id, timestamp),
			restoredFromRevision: revision,
		});
		await this.events?.publish({
			kind: "restored",
			recordId: restored.recordId,
			revision: restored.revision,
			entityType: restored.entityType,
			occurredAt: timestamp,
		});
		return cloneRecord(restored);
	}

	async query(query: EntityQuery, principal: EntityPrincipal): Promise<EntityQueryResult> {
		this.authorize(principal, "entity.read");
		if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) {
			throw invalid("The entity query limit is invalid.");
		}
		const type = await this.catalog.resolveEntityType(query.entityType);
		const fields = new Map(type.effectiveFields.map((field) => [field.key, field]));
		for (const key of Object.keys(query.filter ?? {})) {
			if (!fields.get(key)?.query.filterable) throw invalid("The entity filter is not allowed.");
		}
		if (query.sort && !fields.get(query.sort.field)?.query.sortable) {
			throw invalid("The entity sort is not allowed.");
		}
		let records = (await this.repository.list()).filter(
			(record) => record.entityType === query.entityType && record.status !== "archived",
		);
		for (const [key, expected] of Object.entries(query.filter ?? {})) {
			records = records.filter(
				(record) => JSON.stringify(record.values[key]) === JSON.stringify(expected),
			);
		}
		if (query.sort) {
			const { field, direction } = query.sort;
			records.sort((left, right) =>
				direction === "asc"
					? String(left.values[field]).localeCompare(String(right.values[field]))
					: String(right.values[field]).localeCompare(String(left.values[field])),
			);
		} else {
			records.sort((left, right) => left.recordId.localeCompare(right.recordId));
		}
		if (query.afterRecordId) {
			const cursor = records.findIndex((record) => record.recordId === query.afterRecordId);
			records = cursor < 0 ? [] : records.slice(cursor + 1);
		}
		const items = records.slice(0, query.limit);
		const nextCursor = records.length > items.length ? items.at(-1)?.recordId : undefined;
		return {
			items: items.map(cloneRecord),
			...(nextCursor ? { nextCursor } : {}),
		};
	}

	async exportRecords(
		recordIds: readonly string[],
		principal: EntityPrincipal,
	): Promise<EntityExportDocument> {
		this.authorize(principal, "entity.export");
		const records = await Promise.all(recordIds.map((recordId) => this.requireRecord(recordId)));
		return {
			format: "compendlore.entities",
			version: 1,
			exportedAt: this.now().toISOString(),
			records: records.map((record) => ({
				sourceId: record.recordId,
				entityType: record.entityType,
				publicIdentifier: record.publicIdentifier,
				status: record.status,
				values: structuredClone(record.values),
			})),
		};
	}

	private authorize(principal: EntityPrincipal, capability: string): void {
		if (!principal.capabilities.has("*") && !principal.capabilities.has(capability)) {
			throw new CoreError("authorization.denied", "The entity operation is not authorized.");
		}
	}

	private authorizeOwnership(record: EntityRecordSnapshot, principal: EntityPrincipal): void {
		if (record.owner.kind === "user" && record.owner.identifier !== principal.id) {
			this.authorize(principal, "entity.manage-ownership");
		}
	}

	private async requireRecord(recordId: string): Promise<EntityRecordSnapshot> {
		const record = await this.repository.get(recordId);
		if (!record) throw invalid("The entity record does not exist.");
		return record;
	}

	private async assertPublicIdentifierUnique(
		type: ResolvedEntityType,
		publicIdentifier: string,
	): Promise<void> {
		if (
			(await this.repository.list()).some(
				(record) =>
					record.entityType === type.identifier && record.publicIdentifier === publicIdentifier,
			)
		) {
			throw conflict("The public entity identifier is already used.");
		}
	}
}

export class InMemoryEntityRecordRepository implements EntityRecordRepository {
	private records = new Map<string, EntityRecordSnapshot>();
	private revisions = new Map<string, EntityRevision[]>();

	async create(record: EntityRecordSnapshot, revision: EntityRevision): Promise<void> {
		if (this.records.has(record.recordId)) throw conflict("The entity record already exists.");
		this.records.set(record.recordId, cloneRecord(record));
		this.revisions.set(record.recordId, [cloneRevision(revision)]);
	}

	async get(recordId: string): Promise<EntityRecordSnapshot | undefined> {
		const record = this.records.get(recordId);
		return record ? cloneRecord(record) : undefined;
	}

	async list(): Promise<readonly EntityRecordSnapshot[]> {
		return [...this.records.values()].map(cloneRecord);
	}

	async update(record: EntityRecordSnapshot, revision: EntityRevision): Promise<void> {
		const current = this.records.get(record.recordId);
		if (!current || record.revision !== current.revision + 1) {
			throw conflict("The entity record update is not sequential.");
		}
		this.records.set(record.recordId, cloneRecord(record));
		this.revisions.set(record.recordId, [
			...(this.revisions.get(record.recordId) ?? []),
			cloneRevision(revision),
		]);
	}

	async listRevisions(recordId: string): Promise<readonly EntityRevision[]> {
		return (this.revisions.get(recordId) ?? []).map(cloneRevision);
	}
}

function validateValues(
	type: ResolvedEntityType,
	values: Readonly<Record<string, CoreJsonValue>>,
	publishing: boolean,
): void {
	const fields = new Map(type.effectiveFields.map((field) => [field.key, field]));
	for (const key of Object.keys(values)) {
		if (!fields.has(key)) throw invalid("The entity value targets an unknown field.");
	}
	if (publishing) {
		for (const field of fields.values()) {
			if (field.required && (values[field.key] === undefined || values[field.key] === null)) {
				throw invalid("A required entity field is missing for publication.");
			}
		}
	}
}

function validatePublicIdentifier(value: string): void {
	if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(value)) {
		throw invalid("The public entity identifier is invalid.");
	}
}

function revisionOf(
	record: EntityRecordSnapshot,
	createdBy: string,
	createdAt: Date,
): EntityRevision {
	return {
		recordId: record.recordId,
		revision: record.revision,
		snapshot: cloneRecord(record),
		createdBy,
		createdAt,
	};
}

function cloneRecord(record: EntityRecordSnapshot): EntityRecordSnapshot {
	return structuredClone(record);
}

function cloneRevision(revision: EntityRevision): EntityRevision {
	return structuredClone(revision);
}

function invalid(message: string): CoreError {
	return new CoreError("configuration.invalid", message);
}

function conflict(message: string): CoreError {
	return new CoreError("infrastructure.conflict", message);
}
