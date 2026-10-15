import { createHash } from "node:crypto";
import { CoreError } from "./errors.js";
import type { CoreJsonValue } from "./store.js";

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAXIMUM_CONDITION_DEPTH = 16;

export type EntityStructuredNode =
	| {
			readonly kind: "field";
			readonly key: string;
			readonly fieldType: string;
			readonly required: boolean;
			readonly configuration: Readonly<Record<string, CoreJsonValue>>;
	  }
	| {
			readonly kind: "object";
			readonly key: string;
			readonly children: readonly EntityStructuredNode[];
	  }
	| {
			readonly kind: "collection";
			readonly key: string;
			readonly minimum: number;
			readonly maximum: number;
			readonly childTable: boolean;
			readonly item: EntityStructuredNode;
	  }
	| {
			readonly kind: "variant";
			readonly key: string;
			readonly discriminator: string;
			readonly choices: Readonly<Record<string, EntityStructuredNode>>;
	  };

export interface EntityChoiceSourceDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly kind: "method" | "static" | "taxonomy";
	readonly multiple: boolean;
	readonly options?: readonly {
		readonly key: string;
		readonly labelResource: string;
	}[];
	readonly methodIdentifier?: string;
	readonly vocabularyIdentifier?: string;
}

export interface EntityFieldExtensionDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly fieldType: string;
	readonly schema: EntityStructuredNode;
	readonly choiceSource?: string;
}

export interface EntityRelationDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly sourceType: string;
	readonly targetType: string;
	readonly sourceMaximum?: number;
	readonly targetMaximum?: number;
	readonly directed: boolean;
	readonly withdrawalPolicy: "archive" | "detach" | "restrict";
	readonly permissions: readonly string[];
}

export interface EntityProjectionDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly entityType: string;
	readonly sourceFields: readonly string[];
	readonly dependencies: readonly string[];
	readonly localized: boolean;
	readonly indexed: boolean;
	readonly outputType: "boolean" | "decimal" | "identifier" | "integer" | "text";
}

export type EntityInterfaceUsage =
	"create" | "detail" | "edit" | "list-item" | "preview" | "select" | "summary" | "table-row";

export type EntityCondition =
	| { readonly operation: "exists"; readonly field: string }
	| {
			readonly operation: "equals" | "includes";
			readonly field: string;
			readonly value: CoreJsonValue;
	  }
	| { readonly operation: "and" | "or"; readonly conditions: readonly EntityCondition[] }
	| { readonly operation: "not"; readonly condition: EntityCondition };

export interface EntityInterfaceDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly entityType: string;
	readonly usage: EntityInterfaceUsage;
	readonly version: number;
	readonly permissions: readonly string[];
	readonly primitives: readonly {
		readonly kind: "action" | "category" | "field" | "frame" | "region" | "separator" | "text";
		readonly key: string;
		readonly field?: string;
		readonly condition?: EntityCondition;
	}[];
	readonly authorityRules: readonly {
		readonly identifier: string;
		readonly effect: "force-value" | "publish-requirement" | "required";
		readonly field: string;
		readonly condition: EntityCondition;
	}[];
}

export interface MeasurementDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly dimension: string;
	readonly canonicalUnit: string;
	readonly precision: number;
}

export interface MeasurementUnitDefinition {
	readonly identifier: string;
	readonly measurementIdentifier: string;
	readonly ownerContributionKey: string;
	readonly symbolResource: string;
	readonly system: string;
	readonly conversion:
		| { readonly kind: "none" }
		| {
				readonly kind: "affine" | "rational";
				readonly numerator: string;
				readonly denominator: string;
				readonly offset: string;
				readonly version: number;
		  };
}

export interface TaxonomyVocabularyDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly hierarchical: boolean;
	readonly extensibility: "closed" | "open" | "proposal";
	readonly maximumAssignments?: number;
	readonly resourceTypes: readonly string[];
}

export interface TaxonomyTermDefinition {
	readonly identifier: string;
	readonly vocabularyIdentifier: string;
	readonly ownerContributionKey: string;
	readonly parentIdentifier?: string;
	readonly labelResource: string;
	readonly aliases: readonly string[];
}

export interface EntityEcosystemBundle {
	readonly sourceContributionKey: string;
	readonly choices?: readonly EntityChoiceSourceDefinition[];
	readonly fieldExtensions?: readonly EntityFieldExtensionDefinition[];
	readonly relations?: readonly EntityRelationDefinition[];
	readonly projections?: readonly EntityProjectionDefinition[];
	readonly interfaces?: readonly EntityInterfaceDefinition[];
	readonly measurements?: readonly MeasurementDefinition[];
	readonly measurementUnits?: readonly MeasurementUnitDefinition[];
	readonly vocabularies?: readonly TaxonomyVocabularyDefinition[];
	readonly terms?: readonly TaxonomyTermDefinition[];
}

export type EntitySchemaChangeClassification = "additive" | "conditional" | "incompatible";

export interface EntitySchemaChange {
	readonly resourceKind: "extension" | "field" | "interface" | "relation" | "type";
	readonly resourceIdentifier: string;
	readonly operation: "add" | "archive" | "change-storage" | "purge" | "remove-required";
	readonly usages: number;
}

export interface EntitySchemaEvolutionPlan {
	readonly classification: EntitySchemaChangeClassification;
	readonly requiresExplicitPlan: boolean;
	readonly blockers: readonly string[];
}

export interface StoredEntityEcosystem {
	readonly bundle: EntityEcosystemBundle;
	readonly fingerprint: string;
}

export interface EntityEcosystemRepository {
	list(): Promise<readonly StoredEntityEcosystem[]>;
	replace(bundle: EntityEcosystemBundle, fingerprint: string): Promise<void>;
}

export interface EntityEcosystemMaterializationPort {
	materializeEntityEcosystem(bundle: EntityEcosystemBundle): Promise<void>;
}

export class EntityEcosystemService implements EntityEcosystemMaterializationPort {
	constructor(private readonly repository: EntityEcosystemRepository) {}

	async register(bundle: EntityEcosystemBundle): Promise<void> {
		assertIdentifier(bundle.sourceContributionKey, "contribution key");
		validateOwned(bundle);
		const current = await this.repository.list();
		const combined = [
			...current.filter(
				(entry) => entry.bundle.sourceContributionKey !== bundle.sourceContributionKey,
			),
			{ bundle, fingerprint: fingerprint(bundle) },
		];
		validateReferences(combined.map((entry) => entry.bundle));
		await this.repository.replace(bundle, fingerprint(bundle));
	}

	materializeEntityEcosystem(bundle: EntityEcosystemBundle): Promise<void> {
		return this.register(bundle);
	}

	async list(): Promise<readonly StoredEntityEcosystem[]> {
		return this.repository.list();
	}

	analyzeSchemaChange(change: EntitySchemaChange): EntitySchemaEvolutionPlan {
		if (change.operation === "add") {
			return { classification: "additive", requiresExplicitPlan: false, blockers: [] };
		}
		const classification =
			change.operation === "archive" || change.operation === "remove-required"
				? "conditional"
				: "incompatible";
		const blockers = change.usages > 0 ? [`${change.usages} active usage(s)`] : [];
		return {
			classification,
			requiresExplicitPlan: true,
			blockers,
		};
	}
}

export class InMemoryEntityEcosystemRepository implements EntityEcosystemRepository {
	private entries = new Map<string, StoredEntityEcosystem>();

	async list(): Promise<readonly StoredEntityEcosystem[]> {
		return structuredClone([...this.entries.values()]);
	}

	async replace(bundle: EntityEcosystemBundle, bundleFingerprint: string): Promise<void> {
		this.entries.set(bundle.sourceContributionKey, {
			bundle: structuredClone(bundle),
			fingerprint: bundleFingerprint,
		});
	}
}

export function nativeEntityEcosystem(): EntityEcosystemBundle {
	return {
		sourceContributionKey: "module.site",
		measurements: [
			{
				identifier: "duration",
				ownerContributionKey: "module.site",
				dimension: "time",
				canonicalUnit: "second",
				precision: 6,
			},
		],
		measurementUnits: [
			{
				identifier: "second",
				measurementIdentifier: "duration",
				ownerContributionKey: "module.site",
				symbolResource: "core.measurement.second.symbol",
				system: "metric",
				conversion: {
					kind: "rational",
					numerator: "1",
					denominator: "1",
					offset: "0",
					version: 1,
				},
			},
		],
		vocabularies: [
			{
				identifier: "entity-tags",
				ownerContributionKey: "module.site",
				hierarchical: false,
				extensibility: "open",
				resourceTypes: ["entity"],
			},
		],
		interfaces: nativeInterfaceUsages.map((usage) => ({
			identifier: `entity.${usage}`,
			ownerContributionKey: "module.site",
			entityType: "entity",
			usage,
			version: 1,
			permissions: [`entity.${usage}`],
			primitives: [{ kind: "region", key: "content" }],
			authorityRules: [],
		})),
	};
}

const nativeInterfaceUsages: readonly EntityInterfaceUsage[] = [
	"create",
	"edit",
	"detail",
	"summary",
	"list-item",
	"select",
];

function validateOwned(bundle: EntityEcosystemBundle): void {
	const owned = [
		...(bundle.choices ?? []),
		...(bundle.fieldExtensions ?? []),
		...(bundle.relations ?? []),
		...(bundle.projections ?? []),
		...(bundle.interfaces ?? []),
		...(bundle.measurements ?? []),
		...(bundle.measurementUnits ?? []),
		...(bundle.vocabularies ?? []),
		...(bundle.terms ?? []),
	];
	for (const definition of owned) {
		assertIdentifier(definition.identifier, "entity ecosystem identifier");
		if (definition.ownerContributionKey !== bundle.sourceContributionKey) {
			throw invalid("A contribution can only register its own entity ecosystem definitions.");
		}
	}
	for (const choice of bundle.choices ?? []) validateChoice(choice);
	for (const extension of bundle.fieldExtensions ?? []) validateNode(extension.schema, 0);
	for (const relation of bundle.relations ?? []) {
		if (relation.sourceMaximum !== undefined && relation.sourceMaximum < 1)
			throw invalid("A relation cardinality must be positive.");
		if (relation.targetMaximum !== undefined && relation.targetMaximum < 1)
			throw invalid("A relation cardinality must be positive.");
		if (relation.withdrawalPolicy === "detach" && relation.permissions.length === 0) {
			throw invalid("A detachable relation requires an explicit permission.");
		}
	}
	for (const definition of bundle.interfaces ?? []) {
		if (!Number.isSafeInteger(definition.version) || definition.version < 1)
			throw invalid("An entity interface version must be positive.");
		for (const primitive of definition.primitives) {
			assertIdentifier(primitive.key, "interface primitive key");
			if (primitive.condition) validateCondition(primitive.condition, 0);
		}
		for (const rule of definition.authorityRules) validateCondition(rule.condition, 0);
	}
	for (const measurement of bundle.measurements ?? []) {
		if (
			!Number.isSafeInteger(measurement.precision) ||
			measurement.precision < 0 ||
			measurement.precision > 18
		)
			throw invalid("A measurement precision must be between zero and eighteen.");
	}
	for (const unit of bundle.measurementUnits ?? []) validateUnit(unit);
}

function validateReferences(bundles: readonly EntityEcosystemBundle[]): void {
	const choices = uniqueMap(
		bundles.flatMap((bundle) => bundle.choices ?? []),
		"choice source",
	);
	const measurements = uniqueMap(
		bundles.flatMap((bundle) => bundle.measurements ?? []),
		"measurement",
	);
	const vocabularies = uniqueMap(
		bundles.flatMap((bundle) => bundle.vocabularies ?? []),
		"taxonomy vocabulary",
	);
	const terms = uniqueMap(
		bundles.flatMap((bundle) => bundle.terms ?? []),
		"taxonomy term",
	);
	const projections = uniqueMap(
		bundles.flatMap((bundle) => bundle.projections ?? []),
		"entity projection",
	);
	for (const extension of bundles.flatMap((bundle) => bundle.fieldExtensions ?? [])) {
		if (extension.choiceSource && !choices.has(extension.choiceSource))
			throw invalid("An entity field extension references an unknown choice source.");
	}
	for (const unit of bundles.flatMap((bundle) => bundle.measurementUnits ?? [])) {
		if (!measurements.has(unit.measurementIdentifier))
			throw invalid("A measurement unit references an unknown measurement.");
	}
	for (const measurement of measurements.values()) {
		if (
			!bundles
				.flatMap((bundle) => bundle.measurementUnits ?? [])
				.some(
					(unit) =>
						unit.measurementIdentifier === measurement.identifier &&
						unit.identifier === measurement.canonicalUnit,
				)
		)
			throw invalid("A measurement canonical unit is missing.");
	}
	for (const term of terms.values()) {
		const vocabulary = vocabularies.get(term.vocabularyIdentifier);
		if (!vocabulary) throw invalid("A taxonomy term references an unknown vocabulary.");
		if (term.parentIdentifier) {
			if (!vocabulary.hierarchical) throw invalid("A flat taxonomy cannot contain nested terms.");
			const parent = terms.get(term.parentIdentifier);
			if (!parent || parent.vocabularyIdentifier !== term.vocabularyIdentifier)
				throw invalid("A taxonomy parent is invalid.");
		}
	}
	assertAcyclic(
		projections,
		(projection) => projection.dependencies,
		"The entity projection graph contains a cycle.",
	);
}

function validateChoice(choice: EntityChoiceSourceDefinition): void {
	if (choice.kind === "static" && (!choice.options || choice.options.length === 0))
		throw invalid("A static choice source requires options.");
	if (choice.kind === "method" && !choice.methodIdentifier)
		throw invalid("A method choice source requires a registered method.");
	if (choice.kind === "taxonomy" && !choice.vocabularyIdentifier)
		throw invalid("A taxonomy choice source requires a vocabulary.");
}

function validateNode(node: EntityStructuredNode, depth: number): void {
	if (depth > MAXIMUM_CONDITION_DEPTH) throw invalid("An entity field schema is too deep.");
	assertIdentifier(node.key, "structured field key");
	if (node.kind === "field") assertIdentifier(node.fieldType, "structured field type");
	if (node.kind === "object") {
		if (node.children.length === 0) throw invalid("An object field requires children.");
		for (const child of node.children) validateNode(child, depth + 1);
	}
	if (node.kind === "collection") {
		if (node.minimum < 0 || node.maximum < node.minimum || node.maximum > 10_000)
			throw invalid("A structured collection has invalid bounds.");
		validateNode(node.item, depth + 1);
	}
	if (node.kind === "variant") {
		assertIdentifier(node.discriminator, "variant discriminator");
		if (Object.keys(node.choices).length < 2)
			throw invalid("A variant field requires at least two choices.");
		for (const child of Object.values(node.choices)) validateNode(child, depth + 1);
	}
}

function validateCondition(condition: EntityCondition, depth: number): void {
	if (depth > MAXIMUM_CONDITION_DEPTH) throw invalid("An entity condition is too deep.");
	if ("field" in condition) assertIdentifier(condition.field, "condition field");
	if (condition.operation === "and" || condition.operation === "or") {
		if (condition.conditions.length < 1) throw invalid("A compound condition cannot be empty.");
		for (const child of condition.conditions) validateCondition(child, depth + 1);
	}
	if (condition.operation === "not") validateCondition(condition.condition, depth + 1);
}

function validateUnit(unit: MeasurementUnitDefinition): void {
	if (unit.conversion.kind === "none") return;
	if (!/^[-+]?\d+(?:\.\d+)?$/u.test(unit.conversion.numerator))
		throw invalid("A measurement numerator must be an exact decimal.");
	if (!/^[-+]?\d+(?:\.\d+)?$/u.test(unit.conversion.denominator))
		throw invalid("A measurement denominator must be an exact decimal.");
	if (Number(unit.conversion.denominator) === 0)
		throw invalid("A measurement denominator cannot be zero.");
	if (!/^[-+]?\d+(?:\.\d+)?$/u.test(unit.conversion.offset))
		throw invalid("A measurement offset must be an exact decimal.");
	if (!Number.isSafeInteger(unit.conversion.version) || unit.conversion.version < 1)
		throw invalid("A measurement conversion version must be positive.");
}

function uniqueMap<T extends { readonly identifier: string }>(
	definitions: readonly T[],
	label: string,
): Map<string, T> {
	const result = new Map<string, T>();
	for (const definition of definitions) {
		if (result.has(definition.identifier)) throw invalid(`A ${label} identifier is duplicated.`);
		result.set(definition.identifier, definition);
	}
	return result;
}

function assertAcyclic<T extends { readonly identifier: string }>(
	definitions: ReadonlyMap<string, T>,
	dependencies: (definition: T) => readonly string[],
	message: string,
): void {
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (identifier: string): void => {
		if (visiting.has(identifier)) throw invalid(message);
		if (visited.has(identifier)) return;
		const definition = definitions.get(identifier);
		if (!definition) throw invalid("An entity ecosystem dependency is unknown.");
		visiting.add(identifier);
		for (const dependency of dependencies(definition)) visit(dependency);
		visiting.delete(identifier);
		visited.add(identifier);
	};
	for (const identifier of definitions.keys()) visit(identifier);
}

function assertIdentifier(value: string, label: string): void {
	if (!IDENTIFIER_PATTERN.test(value)) throw invalid(`The ${label} is invalid.`);
}

function fingerprint(value: unknown): string {
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
