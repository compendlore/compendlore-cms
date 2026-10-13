import { randomUUID } from "node:crypto";
import { CoreError } from "./errors.js";

export type EntityFieldFamily =
	| "boolean"
	| "choice"
	| "identifier"
	| "integer"
	| "measurement"
	| "media"
	| "number"
	| "relation"
	| "rich-text"
	| "short-text"
	| "structured-collection"
	| "taxonomy";

export interface EntityFieldDefinition {
	readonly identifier: string;
	readonly family: EntityFieldFamily | (string & {});
	readonly labelTextIdentifier: string;
	readonly descriptionTextIdentifier?: string;
	readonly required: boolean;
	readonly localized: boolean;
	readonly collection: boolean;
	readonly immutable: boolean;
	readonly configuration: Readonly<Record<string, unknown>>;
}

export interface EntityTypeDefinition {
	readonly identifier: string;
	readonly contributionKey: string;
	readonly parentIdentifier?: string;
	readonly abstract: boolean;
	readonly required: boolean;
	readonly allowsExtensions: boolean;
	readonly nameTextIdentifier: string;
	readonly descriptionTextIdentifier?: string;
	readonly fields: readonly EntityFieldDefinition[];
}

export interface EntityRelationDefinition {
	readonly identifier: string;
	readonly contributionKey: string;
	readonly sourceTypeIdentifier: string;
	readonly targetTypeIdentifier: string;
	readonly sourceCardinality: "many" | "one";
	readonly targetCardinality: "many" | "one";
	readonly onTargetRemoval: "block" | "nullify" | "preserve";
}

export interface EntityInterfaceDefinition {
	readonly identifier: string;
	readonly contributionKey: string;
	readonly entityTypeIdentifier: string;
	readonly purpose: "create" | "detail" | "edit" | "list" | "select" | "summary";
	readonly fieldIdentifiers: readonly string[];
}

export interface MeasurementUnitDefinition {
	readonly identifier: string;
	readonly dimensionIdentifier: string;
	readonly symbol: string;
	readonly scale: number;
	readonly offset: number;
}

export interface TaxonomyTermDefinition {
	readonly identifier: string;
	readonly vocabularyIdentifier: string;
	readonly labelTextIdentifier: string;
	readonly aliases: readonly string[];
}

export type EntityWorkflowState = "archived" | "draft" | "published" | "review";

export interface EntityRecord {
	readonly recordId: string;
	readonly typeIdentifier: string;
	readonly publicId: string;
	readonly values: Readonly<Record<string, unknown>>;
	readonly workflowState: EntityWorkflowState;
	readonly authorId: string;
	readonly owner: { readonly kind: "group" | "user"; readonly identifier: string };
	readonly revision: number;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

export interface EntityRevision {
	readonly recordId: string;
	readonly revision: number;
	readonly values: Readonly<Record<string, unknown>>;
	readonly workflowState: EntityWorkflowState;
	readonly createdAt: Date;
	readonly createdBy: string;
}

export interface EntityQuery {
	readonly typeIdentifier: string;
	readonly filters?: Readonly<Record<string, unknown>>;
	readonly orderBy?: string;
	readonly direction?: "asc" | "desc";
	readonly limit: number;
	readonly cursor?: string;
}

export interface EntityQueryResult {
	readonly records: readonly EntityRecord[];
	readonly nextCursor?: string;
}

export interface EntityImportPreview {
	readonly accepted: number;
	readonly conflicts: readonly { readonly publicId: string; readonly reason: string }[];
	readonly fingerprint: string;
}

const nativeFieldFamilies = new Set<EntityFieldFamily>([
	"boolean",
	"choice",
	"identifier",
	"integer",
	"measurement",
	"media",
	"number",
	"relation",
	"rich-text",
	"short-text",
	"structured-collection",
	"taxonomy",
]);

export class EntityEngine {
	private readonly fieldFamilies = new Set<string>(nativeFieldFamilies);
	private readonly types = new Map<string, EntityTypeDefinition>();
	private readonly relations = new Map<string, EntityRelationDefinition>();
	private readonly interfaces = new Map<string, EntityInterfaceDefinition>();
	private readonly units = new Map<string, MeasurementUnitDefinition>();
	private readonly taxonomyTerms = new Map<string, TaxonomyTermDefinition>();
	private readonly records = new Map<string, EntityRecord>();
	private readonly revisions = new Map<string, EntityRevision[]>();

	registerFieldFamily(identifier: string): void {
		validateIdentifier(identifier);
		this.fieldFamilies.add(identifier);
	}

	registerType(definition: EntityTypeDefinition): void {
		validateIdentifier(definition.identifier);
		if (definition.identifier === "entity" && definition.parentIdentifier) {
			invalid("Le type racine entity ne possède aucun parent.");
		}
		if (definition.identifier !== "entity" && !definition.parentIdentifier) {
			invalid(`Le type ${definition.identifier} doit hériter d’un parent.`);
		}
		if (definition.parentIdentifier && !this.types.has(definition.parentIdentifier)) {
			invalid(`Le parent ${definition.parentIdentifier} est inconnu.`);
		}
		if (
			new Set(definition.fields.map((field) => field.identifier)).size !== definition.fields.length
		) {
			invalid(`Le type ${definition.identifier} contient des champs dupliqués.`);
		}
		for (const field of definition.fields) {
			validateIdentifier(field.identifier);
			if (!this.fieldFamilies.has(field.family))
				invalid(`Le type de champ ${field.family} est inconnu.`);
		}
		const current = this.types.get(definition.identifier);
		if (current && current.contributionKey !== definition.contributionKey) {
			invalid(`Le type ${definition.identifier} appartient à une autre contribution.`);
		}
		this.assertNoFieldCollision(definition);
		this.types.set(definition.identifier, Object.freeze({ ...definition }));
		try {
			this.inheritanceChain(definition.identifier);
		} catch (error) {
			if (current) this.types.set(definition.identifier, current);
			else this.types.delete(definition.identifier);
			throw error;
		}
	}

	registerRelation(definition: EntityRelationDefinition): void {
		if (
			!this.types.has(definition.sourceTypeIdentifier) ||
			!this.types.has(definition.targetTypeIdentifier)
		) {
			invalid("Une relation référence un type d’entité inconnu.");
		}
		this.relations.set(definition.identifier, Object.freeze({ ...definition }));
	}

	registerInterface(definition: EntityInterfaceDefinition): void {
		const fields = this.effectiveFields(definition.entityTypeIdentifier);
		for (const identifier of definition.fieldIdentifiers) {
			if (!fields.some((field) => field.identifier === identifier)) {
				invalid(`Le champ ${identifier} n’existe pas sur ${definition.entityTypeIdentifier}.`);
			}
		}
		this.interfaces.set(definition.identifier, Object.freeze({ ...definition }));
	}

	registerUnit(definition: MeasurementUnitDefinition): void {
		if (
			!Number.isFinite(definition.scale) ||
			definition.scale === 0 ||
			!Number.isFinite(definition.offset)
		) {
			invalid("La conversion de l’unité est invalide.");
		}
		this.units.set(definition.identifier, Object.freeze({ ...definition }));
	}

	registerTaxonomyTerm(definition: TaxonomyTermDefinition): void {
		this.taxonomyTerms.set(definition.identifier, Object.freeze({ ...definition }));
	}

	effectiveFields(typeIdentifier: string): readonly EntityFieldDefinition[] {
		const chain = this.inheritanceChain(typeIdentifier).reverse();
		const fields = new Map<string, EntityFieldDefinition>();
		for (const type of chain) for (const field of type.fields) fields.set(field.identifier, field);
		return [...fields.values()];
	}

	create(input: {
		readonly typeIdentifier: string;
		readonly values: Readonly<Record<string, unknown>>;
		readonly authorId: string;
		readonly owner?: { readonly kind: "group" | "user"; readonly identifier: string };
	}): EntityRecord {
		const type = this.requireType(input.typeIdentifier);
		if (type.abstract) invalid(`Le type ${type.identifier} est abstrait.`);
		this.validateValues(type.identifier, input.values);
		const publicId = String(input.values.id ?? "");
		if (!publicId || [...this.records.values()].some((record) => record.publicId === publicId)) {
			invalid("L’identifiant public de l’entité est absent ou déjà utilisé.");
		}
		const now = new Date();
		const owner: EntityRecord["owner"] = input.owner ?? {
			kind: "user",
			identifier: input.authorId,
		};
		const record: EntityRecord = Object.freeze({
			recordId: randomUUID(),
			typeIdentifier: type.identifier,
			publicId,
			values: structuredClone(input.values),
			workflowState: "draft",
			authorId: input.authorId,
			owner,
			revision: 1,
			createdAt: now,
			updatedAt: now,
		});
		this.records.set(record.recordId, record);
		this.appendRevision(record, input.authorId);
		return record;
	}

	update(
		recordId: string,
		expectedRevision: number,
		values: Readonly<Record<string, unknown>>,
		actorId: string,
	): EntityRecord {
		const current = this.requireRecord(recordId);
		if (current.revision !== expectedRevision) {
			throw new CoreError("configuration.invalid", "La révision de l’entité a changé.");
		}
		this.validateValues(current.typeIdentifier, values);
		for (const field of this.effectiveFields(current.typeIdentifier)) {
			if (field.immutable && current.values[field.identifier] !== values[field.identifier]) {
				invalid(`Le champ ${field.identifier} est immuable.`);
			}
		}
		const updated = Object.freeze({
			...current,
			values: structuredClone(values),
			revision: current.revision + 1,
			updatedAt: new Date(),
		});
		this.records.set(recordId, updated);
		this.appendRevision(updated, actorId);
		return updated;
	}

	transition(
		recordId: string,
		expectedRevision: number,
		state: EntityWorkflowState,
		actorId: string,
	): EntityRecord {
		const current = this.requireRecord(recordId);
		if (current.revision !== expectedRevision) invalid("La révision de l’entité a changé.");
		const allowed: Readonly<Record<EntityWorkflowState, readonly EntityWorkflowState[]>> = {
			draft: ["review", "archived"],
			review: ["draft", "published", "archived"],
			published: ["draft", "archived"],
			archived: ["draft"],
		};
		if (!allowed[current.workflowState].includes(state))
			invalid("Cette transition éditoriale est interdite.");
		const updated = Object.freeze({
			...current,
			workflowState: state,
			revision: current.revision + 1,
			updatedAt: new Date(),
		});
		this.records.set(recordId, updated);
		this.appendRevision(updated, actorId);
		return updated;
	}

	restore(recordId: string, revision: number, actorId: string): EntityRecord {
		const snapshot = (this.revisions.get(recordId) ?? []).find(
			(item) => item.revision === revision,
		);
		if (!snapshot) invalid("La révision demandée est introuvable.");
		const current = this.requireRecord(recordId);
		const restored = Object.freeze({
			...current,
			values: structuredClone(snapshot.values),
			workflowState: snapshot.workflowState,
			revision: current.revision + 1,
			updatedAt: new Date(),
		});
		this.records.set(recordId, restored);
		this.appendRevision(restored, actorId);
		return restored;
	}

	query(query: EntityQuery): EntityQueryResult {
		if (query.limit < 1 || query.limit > 100)
			invalid("La pagination doit contenir entre 1 et 100 éléments.");
		const fields = this.effectiveFields(query.typeIdentifier);
		if (query.orderBy && !fields.some((field) => field.identifier === query.orderBy)) {
			invalid("Le champ de tri est inconnu.");
		}
		for (const key of Object.keys(query.filters ?? {})) {
			if (!fields.some((field) => field.identifier === key))
				invalid(`Le filtre ${key} est inconnu.`);
		}
		const offset = query.cursor
			? Number.parseInt(Buffer.from(query.cursor, "base64url").toString(), 10)
			: 0;
		if (!Number.isSafeInteger(offset) || offset < 0) invalid("Le curseur est invalide.");
		let records = [...this.records.values()].filter(
			(record) =>
				record.typeIdentifier === query.typeIdentifier &&
				Object.entries(query.filters ?? {}).every(([key, value]) => record.values[key] === value),
		);
		if (query.orderBy) {
			const key = query.orderBy;
			records = records.sort((left, right) =>
				String(left.values[key] ?? "").localeCompare(String(right.values[key] ?? "")),
			);
			if (query.direction === "desc") records.reverse();
		}
		const page = records.slice(offset, offset + query.limit);
		const next = offset + page.length;
		return {
			records: page,
			...(next < records.length
				? { nextCursor: Buffer.from(String(next)).toString("base64url") }
				: {}),
		};
	}

	previewImport(records: readonly { readonly publicId: string }[]): EntityImportPreview {
		const conflicts = records
			.filter((input) =>
				[...this.records.values()].some((record) => record.publicId === input.publicId),
			)
			.map((input) => ({ publicId: input.publicId, reason: "identifier-already-exists" }));
		return {
			accepted: records.length - conflicts.length,
			conflicts,
			fingerprint: Buffer.from(JSON.stringify(records)).toString("base64url"),
		};
	}

	impactOfTypeRemoval(typeIdentifier: string): Readonly<Record<string, number>> {
		return {
			children: [...this.types.values()].filter((type) => type.parentIdentifier === typeIdentifier)
				.length,
			records: [...this.records.values()].filter(
				(record) => record.typeIdentifier === typeIdentifier,
			).length,
			relations: [...this.relations.values()].filter(
				(relation) =>
					relation.sourceTypeIdentifier === typeIdentifier ||
					relation.targetTypeIdentifier === typeIdentifier,
			).length,
			interfaces: [...this.interfaces.values()].filter(
				(item) => item.entityTypeIdentifier === typeIdentifier,
			).length,
		};
	}

	private validateValues(typeIdentifier: string, values: Readonly<Record<string, unknown>>): void {
		const fields = this.effectiveFields(typeIdentifier);
		const allowed = new Set(fields.map((field) => field.identifier));
		for (const key of Object.keys(values))
			if (!allowed.has(key)) invalid(`Le champ ${key} est inconnu.`);
		for (const field of fields) {
			const value = values[field.identifier];
			if (field.required && (value === undefined || value === null || value === "")) {
				invalid(`Le champ ${field.identifier} est obligatoire.`);
			}
			if (value !== undefined) validateFieldValue(field, value);
		}
	}

	private assertNoFieldCollision(definition: EntityTypeDefinition): void {
		if (!definition.parentIdentifier) return;
		const inherited = new Set(
			this.effectiveFields(definition.parentIdentifier).map((field) => field.identifier),
		);
		for (const field of definition.fields) {
			if (inherited.has(field.identifier))
				invalid(`Le champ hérité ${field.identifier} ne peut pas être redéfini.`);
		}
	}

	private inheritanceChain(identifier: string): EntityTypeDefinition[] {
		const chain: EntityTypeDefinition[] = [];
		const seen = new Set<string>();
		let current: string | undefined = identifier;
		while (current) {
			if (seen.has(current)) invalid(`L’héritage de ${identifier} contient un cycle.`);
			seen.add(current);
			const type = this.requireType(current);
			chain.push(type);
			current = type.parentIdentifier;
		}
		if (chain.at(-1)?.identifier !== "entity")
			invalid(`Le type ${identifier} ne descend pas de entity.`);
		return chain;
	}

	private requireType(identifier: string): EntityTypeDefinition {
		const type = this.types.get(identifier);
		if (!type) invalid(`Le type ${identifier} est inconnu.`);
		return type;
	}

	private requireRecord(recordId: string): EntityRecord {
		const record = this.records.get(recordId);
		if (!record) invalid("L’entité est introuvable.");
		return record;
	}

	private appendRevision(record: EntityRecord, actorId: string): void {
		const revisions = this.revisions.get(record.recordId) ?? [];
		revisions.push(
			Object.freeze({
				recordId: record.recordId,
				revision: record.revision,
				values: structuredClone(record.values),
				workflowState: record.workflowState,
				createdAt: new Date(),
				createdBy: actorId,
			}),
		);
		this.revisions.set(record.recordId, revisions);
	}
}

function validateFieldValue(field: EntityFieldDefinition, value: unknown): void {
	if (field.collection && !Array.isArray(value))
		invalid(`Le champ ${field.identifier} attend une collection.`);
	const candidate = field.collection && Array.isArray(value) ? value : [value];
	for (const item of candidate) {
		if (["integer", "number"].includes(field.family) && typeof item !== "number") {
			invalid(`Le champ ${field.identifier} attend un nombre.`);
		}
		if (field.family === "integer" && !Number.isSafeInteger(item)) {
			invalid(`Le champ ${field.identifier} attend un entier.`);
		}
		if (field.family === "boolean" && typeof item !== "boolean") {
			invalid(`Le champ ${field.identifier} attend un booléen.`);
		}
		if (
			["choice", "identifier", "media", "rich-text", "short-text", "taxonomy"].includes(
				field.family,
			) &&
			typeof item !== "string"
		) {
			invalid(`Le champ ${field.identifier} attend un texte.`);
		}
	}
}

function validateIdentifier(identifier: string): void {
	if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(identifier)) {
		invalid(`L’identifiant ${identifier} est invalide.`);
	}
}

function invalid(message: string): never {
	throw new CoreError("configuration.invalid", message);
}
