import { createHash } from "node:crypto";
import { CoreError } from "./errors.js";
import type { CoreJsonValue } from "./store.js";

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAXIMUM_INHERITANCE_DEPTH = 32;

export const entityFieldStorageFamilies = [
	"boolean",
	"date",
	"decimal",
	"integer",
	"json",
	"relation",
	"text",
	"time",
	"timestamp",
	"uuid",
] as const;
export type EntityFieldStorageFamily = (typeof entityFieldStorageFamilies)[number];

export interface EntityFieldTypeDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly storageFamily: EntityFieldStorageFamily;
	readonly configurationSchema: Readonly<Record<string, CoreJsonValue>>;
	readonly allowsLocalization: boolean;
	readonly allowsMultiple: boolean;
	readonly extensible: boolean;
}

export interface EntityFieldDefinition {
	readonly key: string;
	readonly fieldType: string;
	readonly required: boolean;
	readonly localized: boolean;
	readonly multiple: boolean;
	readonly position: number;
	readonly configuration: Readonly<Record<string, CoreJsonValue>>;
	readonly query: {
		readonly filterable: boolean;
		readonly sortable: boolean;
		readonly searchable: boolean;
	};
}

export interface EntityIdentifierPolicy {
	readonly scope: "global" | "parent" | "type";
	readonly namespaceRequired: boolean;
	readonly generated: boolean;
	readonly mutableUntilPublication: boolean;
}

export interface EntityAddressingPolicy {
	readonly strategy: "identifier" | "localized-slug" | "none";
	readonly localized: boolean;
	readonly routeOwner?: string;
}

export interface EntityTypeDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly parentIdentifier?: string;
	readonly abstract: boolean;
	readonly final: boolean;
	readonly allowsExtensions: boolean;
	readonly locked: boolean;
	readonly identifierPolicy: EntityIdentifierPolicy;
	readonly addressingPolicy?: EntityAddressingPolicy;
	readonly fields: readonly EntityFieldDefinition[];
}

export interface StoredEntityType extends EntityTypeDefinition {
	readonly version: number;
	readonly fingerprint: string;
	readonly active: boolean;
}

export interface ResolvedEntityType extends StoredEntityType {
	readonly ancestors: readonly string[];
	readonly effectiveFields: readonly EntityFieldDefinition[];
}

export interface EntityCatalogMaterialization {
	readonly sourceContributionKey: string;
	readonly fieldTypes: readonly EntityFieldTypeDefinition[];
	readonly entityTypes: readonly EntityTypeDefinition[];
}

export interface EntityCatalogRepository {
	materialize(input: EntityCatalogMaterialization): Promise<void>;
	listFieldTypes(): Promise<readonly EntityFieldTypeDefinition[]>;
	listEntityTypes(): Promise<readonly StoredEntityType[]>;
}

export interface EntityCatalogMaterializationPort {
	materializeEntityCatalog(input: EntityCatalogMaterialization): Promise<void>;
}

export interface EntityCatalogResolutionPort {
	resolveEntityType(identifier: string): Promise<ResolvedEntityType>;
	listEntityTypes(): Promise<readonly ResolvedEntityType[]>;
}

export class EntityCatalogService
	implements EntityCatalogMaterializationPort, EntityCatalogResolutionPort
{
	constructor(private readonly repository: EntityCatalogRepository) {}

	async materializeEntityCatalog(input: EntityCatalogMaterialization): Promise<void> {
		assertIdentifier(input.sourceContributionKey, "contribution key");
		const existingFieldTypes = new Map(
			(await this.repository.listFieldTypes()).map((definition) => [
				definition.identifier,
				definition,
			]),
		);
		for (const definition of input.fieldTypes) {
			validateFieldType(definition);
			if (definition.ownerContributionKey !== input.sourceContributionKey) {
				throw invalid("A contribution can only register its own entity field types.");
			}
			const current = existingFieldTypes.get(definition.identifier);
			if (current && stableJson(current) !== stableJson(definition)) {
				throw conflict("The entity field type definition is immutable.");
			}
			existingFieldTypes.set(definition.identifier, definition);
		}

		const existingTypes = await this.repository.listEntityTypes();
		const desired = new Map(existingTypes.map((definition) => [definition.identifier, definition]));
		for (const definition of input.entityTypes) {
			validateEntityType(definition, existingFieldTypes);
			if (definition.ownerContributionKey !== input.sourceContributionKey) {
				throw invalid("A contribution can only register its own entity types.");
			}
			const current = desired.get(definition.identifier);
			if (current?.locked && fingerprint(definition) !== current.fingerprint) {
				throw conflict("A locked entity type cannot be changed.");
			}
			desired.set(definition.identifier, {
				...definition,
				version: current
					? current.version + (fingerprint(definition) === current.fingerprint ? 0 : 1)
					: 1,
				fingerprint: fingerprint(definition),
				active: true,
			});
		}
		validateGraph(desired);
		await this.repository.materialize(input);
	}

	async resolveEntityType(identifier: string): Promise<ResolvedEntityType> {
		const definitions = new Map(
			(await this.repository.listEntityTypes())
				.filter((definition) => definition.active)
				.map((definition) => [definition.identifier, definition]),
		);
		const definition = definitions.get(identifier);
		if (!definition) throw invalid("The entity type is not registered.");
		const chain: StoredEntityType[] = [];
		let current: StoredEntityType | undefined = definition;
		while (current) {
			chain.unshift(current);
			current = current.parentIdentifier ? definitions.get(current.parentIdentifier) : undefined;
		}
		const effectiveFields = new Map<string, EntityFieldDefinition>();
		for (const type of chain) {
			for (const field of type.fields) {
				if (effectiveFields.has(field.key)) {
					throw conflict("An entity field collides with an inherited field.");
				}
				effectiveFields.set(field.key, field);
			}
		}
		return {
			...definition,
			ancestors: chain.slice(0, -1).map((candidate) => candidate.identifier),
			effectiveFields: [...effectiveFields.values()],
		};
	}

	async listEntityTypes(): Promise<readonly ResolvedEntityType[]> {
		const definitions = await this.repository.listEntityTypes();
		return Promise.all(
			definitions
				.filter((definition) => definition.active)
				.sort((left, right) => left.identifier.localeCompare(right.identifier))
				.map((definition) => this.resolveEntityType(definition.identifier)),
		);
	}
}

export class InMemoryEntityCatalogRepository implements EntityCatalogRepository {
	private fieldTypes = new Map<string, EntityFieldTypeDefinition>();
	private entityTypes = new Map<string, StoredEntityType>();

	async materialize(input: EntityCatalogMaterialization): Promise<void> {
		const fieldTypes = new Map(this.fieldTypes);
		const entityTypes = new Map(this.entityTypes);
		for (const definition of input.fieldTypes) {
			fieldTypes.set(definition.identifier, structuredClone(definition));
		}
		for (const definition of input.entityTypes) {
			const current = entityTypes.get(definition.identifier);
			const nextFingerprint = fingerprint(definition);
			entityTypes.set(definition.identifier, {
				...structuredClone(definition),
				version: current ? current.version + (current.fingerprint === nextFingerprint ? 0 : 1) : 1,
				fingerprint: nextFingerprint,
				active: true,
			});
		}
		this.fieldTypes = fieldTypes;
		this.entityTypes = entityTypes;
	}

	async listFieldTypes(): Promise<readonly EntityFieldTypeDefinition[]> {
		return [...this.fieldTypes.values()].map((definition) => structuredClone(definition));
	}

	async listEntityTypes(): Promise<readonly StoredEntityType[]> {
		return [...this.entityTypes.values()].map((definition) => structuredClone(definition));
	}
}

export function nativeEntityFoundation(): EntityCatalogMaterialization {
	const sourceContributionKey = "module.site";
	const fieldTypes: EntityFieldTypeDefinition[] = [
		fieldType("boolean", "boolean", false, false),
		fieldType("collection", "json", true, true),
		fieldType("date", "date", false, false),
		fieldType("datetime", "timestamp", false, false),
		fieldType("decimal", "decimal", false, false),
		fieldType("document", "json", true, false),
		fieldType("duration", "decimal", false, false),
		fieldType("enum", "text", true, false),
		fieldType("identifier", "text", false, false),
		fieldType("integer", "integer", false, false),
		fieldType("media", "relation", false, true),
		fieldType("measure", "json", false, false),
		fieldType("object", "json", true, false),
		fieldType("reference", "relation", false, true),
		fieldType("short-text", "text", true, false),
		fieldType("rich-text", "json", true, false),
		fieldType("icon", "text", false, false),
		fieldType("tags", "relation", false, true),
		fieldType("text-collection", "text", true, true),
		fieldType("time", "time", false, false),
	];
	return {
		sourceContributionKey,
		fieldTypes,
		entityTypes: [
			{
				identifier: "entity",
				ownerContributionKey: sourceContributionKey,
				abstract: true,
				final: false,
				allowsExtensions: true,
				locked: true,
				identifierPolicy: {
					scope: "global",
					namespaceRequired: false,
					generated: false,
					mutableUntilPublication: false,
				},
				addressingPolicy: {
					strategy: "none",
					localized: false,
				},
				fields: [
					field("id", "identifier", true, false, false, 0, true, true, true),
					field("name", "short-text", true, true, false, 1, true, true, true),
					field("abbreviation", "short-text", false, true, false, 2, true, true, true),
					field("summary", "rich-text", false, true, false, 3, false, false, true),
					field("description", "rich-text", false, true, false, 4, false, false, true),
					field("icon", "icon", false, false, false, 5, true, false, false),
					field("tags", "tags", false, false, true, 6, true, false, true),
					field("aliases", "text-collection", false, true, true, 7, true, false, true),
				],
			},
		],
	};
}

function fieldType(
	identifier: string,
	storageFamily: EntityFieldStorageFamily,
	allowsLocalization: boolean,
	allowsMultiple: boolean,
): EntityFieldTypeDefinition {
	return {
		identifier,
		ownerContributionKey: "module.site",
		storageFamily,
		configurationSchema: {},
		allowsLocalization,
		allowsMultiple,
		extensible: true,
	};
}

function field(
	key: string,
	fieldTypeIdentifier: string,
	required: boolean,
	localized: boolean,
	multiple: boolean,
	position: number,
	filterable: boolean,
	sortable: boolean,
	searchable: boolean,
): EntityFieldDefinition {
	return {
		key,
		fieldType: fieldTypeIdentifier,
		required,
		localized,
		multiple,
		position,
		configuration: {},
		query: { filterable, sortable, searchable },
	};
}

function validateFieldType(definition: EntityFieldTypeDefinition): void {
	assertIdentifier(definition.identifier, "entity field type");
	assertIdentifier(definition.ownerContributionKey, "contribution key");
	if (!entityFieldStorageFamilies.includes(definition.storageFamily)) {
		throw invalid("The entity field storage family is invalid.");
	}
}

function validateEntityType(
	definition: EntityTypeDefinition,
	fieldTypes: ReadonlyMap<string, EntityFieldTypeDefinition>,
): void {
	assertIdentifier(definition.identifier, "entity type");
	assertIdentifier(definition.ownerContributionKey, "contribution key");
	if (definition.identifier === "entity" && definition.parentIdentifier) {
		throw invalid("The root entity type cannot have a parent.");
	}
	if (definition.identifier !== "entity" && !definition.parentIdentifier) {
		throw invalid("Every entity type except the root needs a parent.");
	}
	if (
		definition.addressingPolicy?.localized &&
		definition.addressingPolicy.strategy !== "localized-slug"
	) {
		throw invalid("Only localized slug addressing can be localized.");
	}
	if (definition.addressingPolicy?.routeOwner) {
		assertIdentifier(definition.addressingPolicy.routeOwner, "route owner");
	}
	const keys = new Set<string>();
	for (const candidate of definition.fields) {
		assertIdentifier(candidate.key, "entity field");
		if (keys.has(candidate.key)) throw invalid("An entity field key is duplicated.");
		keys.add(candidate.key);
		const fieldTypeDefinition = fieldTypes.get(candidate.fieldType);
		if (!fieldTypeDefinition) throw invalid("The entity field type is not registered.");
		if (candidate.localized && !fieldTypeDefinition.allowsLocalization) {
			throw invalid("The entity field type does not support localized values.");
		}
		if (candidate.multiple && !fieldTypeDefinition.allowsMultiple) {
			throw invalid("The entity field type does not support multiple values.");
		}
		if (!Number.isSafeInteger(candidate.position) || candidate.position < 0) {
			throw invalid("The entity field position is invalid.");
		}
	}
}

function validateGraph(definitions: ReadonlyMap<string, StoredEntityType>): void {
	const root = definitions.get("entity");
	if (
		!root?.active ||
		!root.abstract ||
		!root.locked ||
		root.parentIdentifier ||
		root.ownerContributionKey !== "module.site"
	) {
		throw invalid("The locked abstract root entity type is required.");
	}
	for (const definition of definitions.values()) {
		if (!definition.active || definition.identifier === "entity") continue;
		const visited = new Set([definition.identifier]);
		let current = definition;
		let depth = 0;
		while (current.parentIdentifier) {
			if (++depth > MAXIMUM_INHERITANCE_DEPTH) throw invalid("Entity inheritance is too deep.");
			if (visited.has(current.parentIdentifier))
				throw invalid("Entity inheritance contains a cycle.");
			visited.add(current.parentIdentifier);
			const parent = definitions.get(current.parentIdentifier);
			if (!parent?.active) throw invalid("The entity parent type is not active.");
			if (parent.final) throw invalid("A final entity type cannot be extended.");
			current = parent;
		}
		if (current.identifier !== "entity")
			throw invalid("Every entity type must inherit from entity.");
	}
}

function assertIdentifier(value: string, label: string): void {
	if (!IDENTIFIER_PATTERN.test(value)) throw invalid(`The ${label} identifier is invalid.`);
}

function fingerprint(value: EntityTypeDefinition): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, sortValue(entry)]),
		);
	}
	return value;
}

function invalid(message: string): CoreError {
	return new CoreError("configuration.invalid", message);
}

function conflict(message: string): CoreError {
	return new CoreError("infrastructure.conflict", message);
}
