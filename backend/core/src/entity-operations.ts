import { createHash, randomUUID } from "node:crypto";
import { CoreError } from "./errors.js";
import type {
	EntityEditorialStatus,
	EntityOwnership,
	EntityPrincipal,
	EntityRecordRepository,
	EntityRecordSnapshot,
} from "./entity-records.js";
import type { CoreJsonValue } from "./store.js";

export interface EntityShare {
	readonly recordId: string;
	readonly principalKind: "group" | "user";
	readonly principalId: string;
	readonly capabilities: readonly ("read" | "update")[];
}

export interface EntityRecordRelation {
	readonly relationIdentifier: string;
	readonly sourceRecordId: string;
	readonly targetRecordId: string;
	readonly position: number;
	readonly createdBy: string;
}

export interface EntityRelationPolicy {
	readonly identifier: string;
	readonly sourceMaximum?: number;
	readonly targetMaximum?: number;
}

export interface EntityTaxonomyAssignment {
	readonly recordId: string;
	readonly fieldKey: string;
	readonly termIdentifier: string;
	readonly origin: "automatic" | "manual";
	readonly revision: number;
}

export interface EntitySearchDocument {
	readonly recordId: string;
	readonly locale: string;
	readonly audience: string;
	readonly revision: number;
	readonly text: string;
	readonly facets: Readonly<Record<string, readonly string[]>>;
	readonly fingerprint: string;
}

export interface RichContentAnchorProjection {
	readonly recordId: string;
	readonly fieldKey: string;
	readonly locale: string;
	readonly revision: number;
	readonly anchors: readonly string[];
}

export interface EntityOperationalRepository {
	listShares(recordId: string): Promise<readonly EntityShare[]>;
	replaceShares(recordId: string, shares: readonly EntityShare[]): Promise<void>;
	listRelations(relationIdentifier?: string): Promise<readonly EntityRecordRelation[]>;
	replaceRelations(relations: readonly EntityRecordRelation[]): Promise<void>;
	listAssignments(recordId: string): Promise<readonly EntityTaxonomyAssignment[]>;
	replaceAssignments(
		recordId: string,
		assignments: readonly EntityTaxonomyAssignment[],
	): Promise<void>;
	upsertSearchDocument(document: EntitySearchDocument): Promise<void>;
	listSearchDocuments(): Promise<readonly EntitySearchDocument[]>;
	upsertAnchors(projection: RichContentAnchorProjection): Promise<void>;
	listAnchors(recordId: string): Promise<readonly RichContentAnchorProjection[]>;
}

export class EntityOperationalService {
	constructor(
		private readonly records: EntityRecordRepository,
		private readonly repository: EntityOperationalRepository,
	) {}

	async share(recordId: string, share: Omit<EntityShare, "recordId">, principal: EntityPrincipal) {
		const record = await this.requireRecord(recordId);
		this.authorizeOwner(record, principal, "entity.share");
		if (
			share.capabilities.length === 0 ||
			share.capabilities.some((item) => !["read", "update"].includes(item))
		)
			throw invalid("An entity share contains invalid capabilities.");
		const shares = (await this.repository.listShares(recordId)).filter(
			(current) =>
				current.principalKind !== share.principalKind || current.principalId !== share.principalId,
		);
		await this.repository.replaceShares(recordId, [...shares, { recordId, ...share }]);
	}

	async transfer(
		recordId: string,
		owner: EntityOwnership,
		principal: EntityPrincipal,
	): Promise<void> {
		const record = await this.requireRecord(recordId);
		this.authorizeOwner(record, principal, "entity.transfer");
		await this.records.update(
			{
				...record,
				owner: structuredClone(owner),
				revision: record.revision + 1,
				updatedAt: new Date(),
			},
			{
				recordId,
				revision: record.revision + 1,
				snapshot: {
					...record,
					owner: structuredClone(owner),
					revision: record.revision + 1,
					updatedAt: new Date(),
				},
				createdBy: principal.id,
				createdAt: new Date(),
			},
		);
	}

	async listAccessible(principal: EntityPrincipal): Promise<readonly EntityRecordSnapshot[]> {
		const records = await this.records.list();
		const result: EntityRecordSnapshot[] = [];
		for (const record of records) {
			if (record.owner.kind === "instance" || record.owner.identifier === principal.id) {
				result.push(record);
				continue;
			}
			const shares = await this.repository.listShares(record.recordId);
			if (
				shares.some(
					(share) =>
						share.capabilities.includes("read") &&
						((share.principalKind === "user" && share.principalId === principal.id) ||
							(share.principalKind === "group" &&
								principal.capabilities.has(`group.${share.principalId}`))),
				)
			)
				result.push(record);
		}
		return structuredClone(result);
	}

	async relate(
		policy: EntityRelationPolicy,
		input: Omit<EntityRecordRelation, "createdBy" | "position">,
		principal: EntityPrincipal,
	): Promise<void> {
		this.authorize(principal, `entity.relation.${policy.identifier}.write`);
		await Promise.all([
			this.requireRecord(input.sourceRecordId),
			this.requireRecord(input.targetRecordId),
		]);
		const relations = await this.repository.listRelations(policy.identifier);
		if (
			relations.some(
				(relation) =>
					relation.sourceRecordId === input.sourceRecordId &&
					relation.targetRecordId === input.targetRecordId,
			)
		)
			return;
		if (
			policy.sourceMaximum !== undefined &&
			relations.filter((relation) => relation.sourceRecordId === input.sourceRecordId).length >=
				policy.sourceMaximum
		)
			throw conflict("The source relation cardinality is exceeded.");
		if (
			policy.targetMaximum !== undefined &&
			relations.filter((relation) => relation.targetRecordId === input.targetRecordId).length >=
				policy.targetMaximum
		)
			throw conflict("The target relation cardinality is exceeded.");
		await this.repository.replaceRelations([
			...relations,
			{
				...input,
				position: relations.filter((item) => item.sourceRecordId === input.sourceRecordId).length,
				createdBy: principal.id,
			},
		]);
	}

	async assignTerms(
		recordId: string,
		fieldKey: string,
		termIdentifiers: readonly string[],
		maximum: number | undefined,
		principal: EntityPrincipal,
	): Promise<void> {
		this.authorize(principal, `entity.field.${fieldKey}.write`);
		const record = await this.requireRecord(recordId);
		if (maximum !== undefined && termIdentifiers.length > maximum)
			throw invalid("The taxonomy assignment cardinality is exceeded.");
		if (new Set(termIdentifiers).size !== termIdentifiers.length)
			throw invalid("A taxonomy term is assigned more than once.");
		await this.repository.replaceAssignments(
			recordId,
			termIdentifiers.map((termIdentifier) => ({
				recordId,
				fieldKey,
				termIdentifier,
				origin: "manual",
				revision: record.revision,
			})),
		);
	}

	async rebuildSearchDocument(input: {
		readonly recordId: string;
		readonly locale: string;
		readonly audience: string;
		readonly text: string;
		readonly facets: Readonly<Record<string, readonly string[]>>;
	}): Promise<EntitySearchDocument> {
		const record = await this.requireRecord(input.recordId);
		const document: EntitySearchDocument = {
			...input,
			revision: record.revision,
			text: normalizeSearchText(input.text),
			facets: structuredClone(input.facets),
			fingerprint: digest({ ...input, revision: record.revision }),
		};
		await this.repository.upsertSearchDocument(document);
		return structuredClone(document);
	}

	async search(input: {
		readonly query: string;
		readonly locale: string;
		readonly audience: string;
		readonly limit: number;
		readonly afterRecordId?: string;
	}): Promise<readonly EntitySearchDocument[]> {
		if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
			throw invalid("The entity search limit is invalid.");
		const query = normalizeSearchText(input.query);
		let documents = (await this.repository.listSearchDocuments())
			.filter(
				(document) =>
					document.locale === input.locale &&
					document.audience === input.audience &&
					document.text.includes(query),
			)
			.sort((left, right) => left.recordId.localeCompare(right.recordId));
		if (input.afterRecordId) {
			const cursor = documents.findIndex((document) => document.recordId === input.afterRecordId);
			documents = cursor < 0 ? [] : documents.slice(cursor + 1);
		}
		return structuredClone(documents.slice(0, input.limit));
	}

	async projectRichContent(input: {
		readonly recordId: string;
		readonly fieldKey: string;
		readonly locale: string;
		readonly document: CoreJsonValue;
	}): Promise<RichContentAnchorProjection> {
		const record = await this.requireRecord(input.recordId);
		const projection: RichContentAnchorProjection = {
			recordId: input.recordId,
			fieldKey: input.fieldKey,
			locale: input.locale,
			revision: record.revision,
			anchors: collectAnchors(input.document),
		};
		await this.repository.upsertAnchors(projection);
		return structuredClone(projection);
	}

	private async requireRecord(recordId: string): Promise<EntityRecordSnapshot> {
		const record = await this.records.get(recordId);
		if (!record) throw invalid("The entity record does not exist.");
		return record;
	}

	private authorizeOwner(
		record: EntityRecordSnapshot,
		principal: EntityPrincipal,
		capability: string,
	): void {
		if (record.owner.kind === "user" && record.owner.identifier === principal.id) return;
		this.authorize(principal, capability);
	}

	private authorize(principal: EntityPrincipal, capability: string): void {
		if (!principal.capabilities.has("*") && !principal.capabilities.has(capability))
			throw new CoreError("authorization.denied", "The entity operation is not authorized.");
	}
}

export class InMemoryEntityOperationalRepository implements EntityOperationalRepository {
	private shares: EntityShare[] = [];
	private relations: EntityRecordRelation[] = [];
	private assignments: EntityTaxonomyAssignment[] = [];
	private searchDocuments: EntitySearchDocument[] = [];
	private anchors: RichContentAnchorProjection[] = [];

	async listShares(recordId: string) {
		return structuredClone(this.shares.filter((share) => share.recordId === recordId));
	}

	async replaceShares(recordId: string, shares: readonly EntityShare[]) {
		this.shares = [
			...this.shares.filter((share) => share.recordId !== recordId),
			...structuredClone(shares),
		];
	}

	async listRelations(relationIdentifier?: string) {
		return structuredClone(
			relationIdentifier
				? this.relations.filter((relation) => relation.relationIdentifier === relationIdentifier)
				: this.relations,
		);
	}

	async replaceRelations(relations: readonly EntityRecordRelation[]) {
		this.relations = structuredClone([...relations]);
	}

	async listAssignments(recordId: string) {
		return structuredClone(
			this.assignments.filter((assignment) => assignment.recordId === recordId),
		);
	}

	async replaceAssignments(recordId: string, assignments: readonly EntityTaxonomyAssignment[]) {
		this.assignments = [
			...this.assignments.filter((assignment) => assignment.recordId !== recordId),
			...structuredClone(assignments),
		];
	}

	async upsertSearchDocument(document: EntitySearchDocument) {
		this.searchDocuments = [
			...this.searchDocuments.filter(
				(current) =>
					current.recordId !== document.recordId ||
					current.locale !== document.locale ||
					current.audience !== document.audience,
			),
			structuredClone(document),
		];
	}

	async listSearchDocuments() {
		return structuredClone(this.searchDocuments);
	}

	async upsertAnchors(projection: RichContentAnchorProjection) {
		this.anchors = [
			...this.anchors.filter(
				(current) =>
					current.recordId !== projection.recordId ||
					current.fieldKey !== projection.fieldKey ||
					current.locale !== projection.locale,
			),
			structuredClone(projection),
		];
	}

	async listAnchors(recordId: string) {
		return structuredClone(this.anchors.filter((projection) => projection.recordId === recordId));
	}
}

export interface EntityImportRecord {
	readonly sourceId: string;
	readonly entityType: string;
	readonly publicIdentifier: string;
	readonly status: EntityEditorialStatus;
	readonly values: Readonly<Record<string, CoreJsonValue>>;
}

export interface EntityImportDocument {
	readonly format: "compendlore.entities";
	readonly version: 1;
	readonly records: readonly EntityImportRecord[];
}

export type EntityImportConflictPolicy = "reject" | "replace" | "skip";

export interface EntityImportPreview {
	readonly digest: string;
	readonly total: number;
	readonly creates: number;
	readonly conflicts: readonly string[];
	readonly requiresResumableApply: boolean;
}

export interface EntityImportRepository {
	listPublicIdentifiers(): Promise<readonly string[]>;
	applyAtomically(records: readonly EntityImportRecord[]): Promise<void>;
	applySegment(jobId: string, records: readonly EntityImportRecord[]): Promise<void>;
}

export class EntityImportService {
	constructor(
		private readonly repository: EntityImportRepository,
		private readonly transactionLimit = 100,
	) {}

	async preview(document: EntityImportDocument): Promise<EntityImportPreview> {
		validateImportDocument(document);
		const existing = new Set(await this.repository.listPublicIdentifiers());
		const conflicts = document.records
			.filter((record) => existing.has(record.publicIdentifier))
			.map((record) => record.publicIdentifier)
			.sort();
		return {
			digest: digest(document),
			total: document.records.length,
			creates: document.records.length - conflicts.length,
			conflicts,
			requiresResumableApply: document.records.length > this.transactionLimit,
		};
	}

	async apply(
		document: EntityImportDocument,
		previewDigest: string,
		policy: EntityImportConflictPolicy,
	): Promise<{ readonly jobId?: string; readonly applied: number }> {
		const preview = await this.preview(document);
		if (preview.digest !== previewDigest)
			throw conflict("The entity import changed after preview.");
		if (policy === "reject" && preview.conflicts.length > 0)
			throw conflict("The entity import contains unresolved conflicts.");
		const conflicts = new Set(preview.conflicts);
		const selected = document.records.filter(
			(record) => policy !== "skip" || !conflicts.has(record.publicIdentifier),
		);
		if (!preview.requiresResumableApply) {
			await this.repository.applyAtomically(selected);
			return { applied: selected.length };
		}
		const jobId = randomUUID();
		for (let index = 0; index < selected.length; index += this.transactionLimit) {
			await this.repository.applySegment(
				jobId,
				selected.slice(index, index + this.transactionLimit),
			);
		}
		return { jobId, applied: selected.length };
	}
}

export class InMemoryEntityImportRepository implements EntityImportRepository {
	private records = new Map<string, EntityImportRecord>();
	readonly completedSegments = new Set<string>();

	constructor(records: readonly EntityImportRecord[] = []) {
		for (const record of records)
			this.records.set(record.publicIdentifier, structuredClone(record));
	}

	async listPublicIdentifiers() {
		return [...this.records.keys()];
	}

	async applyAtomically(records: readonly EntityImportRecord[]) {
		const next = new Map(this.records);
		for (const record of records) next.set(record.publicIdentifier, structuredClone(record));
		this.records = next;
	}

	async applySegment(jobId: string, records: readonly EntityImportRecord[]) {
		const segmentDigest = digest(records);
		const segmentId = `${jobId}:${segmentDigest}`;
		if (this.completedSegments.has(segmentId)) return;
		await this.applyAtomically(records);
		this.completedSegments.add(segmentId);
	}
}

function validateImportDocument(document: EntityImportDocument): void {
	if (document.format !== "compendlore.entities" || document.version !== 1)
		throw invalid("The entity import format is unsupported.");
	if (document.records.length > 10_000) throw invalid("The entity import exceeds its quota.");
	const sourceIds = new Set<string>();
	for (const record of document.records) {
		if (sourceIds.has(record.sourceId)) throw invalid("An entity import source id is duplicated.");
		sourceIds.add(record.sourceId);
		if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(record.publicIdentifier))
			throw invalid("An imported public identifier is invalid.");
	}
}

function collectAnchors(value: CoreJsonValue): readonly string[] {
	const anchors = new Set<string>();
	const visit = (node: CoreJsonValue): void => {
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
			return;
		}
		if (node && typeof node === "object") {
			const record = node as Readonly<Record<string, CoreJsonValue>>;
			if (typeof record.anchor === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record.anchor))
				anchors.add(record.anchor);
			for (const child of Object.values(record)) visit(child);
		}
	};
	visit(value);
	return [...anchors].sort();
}

function normalizeSearchText(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function digest(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function invalid(message: string): CoreError {
	return new CoreError("configuration.invalid", message);
}

function conflict(message: string): CoreError {
	return new CoreError("infrastructure.conflict", message);
}
