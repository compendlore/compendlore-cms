import { createHash, randomUUID } from "node:crypto";
import { CoreError } from "./errors.js";
import {
	compendloreRecoveryThemeIdentifier,
	resolveThemeFoundationPlan,
	themeSurfaces,
	type ThemeContractDefinition,
	type ThemeLayerReference,
	type ThemeSurface,
} from "./theme-foundation.js";
import { resolveThemeBrand, type ResolvedThemeBrand } from "./theme-brand.js";
import { compileThemeCssProjection, type ThemeCssProjection } from "./theme-projection.js";
import type {
	ThemeMediaQuery,
	ThemeTokenMediaOverride,
	ThemeTokenSetDefinition,
	ThemeTokenValue,
} from "./theme-tokens.js";

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+$/;

export const themeProjectionModes = ["default", "light", "dark", "high-contrast"] as const;
export type ThemeProjectionMode = (typeof themeProjectionModes)[number];

export interface AnalyzedThemeAsset {
	readonly identifier: string;
	readonly digest: string;
	readonly evidenceId: string;
	readonly status: "allowed";
}

export interface ThemeAssetCatalogPort {
	resolveAnalyzedAsset(identifier: string): Promise<AnalyzedThemeAsset | undefined>;
}

export interface ThemePersistenceContractValidator {
	validateThemeContract(contract: ThemeContractDefinition): void;
	validateThemeTokens(tokens: ThemeTokenSetDefinition): void;
}

export interface ThemeRevisionRecord {
	readonly id: string;
	readonly themeIdentifier: string;
	readonly ownerIdentifier: string;
	readonly revision: number;
	readonly contract: ThemeContractDefinition;
	readonly assets: readonly AnalyzedThemeAsset[];
	readonly fingerprint: string;
	readonly createdAt: string;
}

export interface ThemePublicationRecord {
	readonly id: string;
	readonly themeIdentifier: string;
	readonly revision: number;
	readonly publishedAt: string;
	readonly restoredFromRevision?: number;
}

export interface ThemeOverrideDocument {
	readonly identifier: string;
	readonly kind: "instance-override" | "user-preference" | "accessibility-preference";
	readonly priority: number;
	readonly tokens: ThemeTokenSetDefinition;
}

export interface ThemeAssignmentDefinition {
	readonly identifier: string;
	readonly surface: ThemeSurface;
	readonly mode: ThemeProjectionMode;
	readonly baseThemeIdentifier: string;
	readonly extensions?: readonly ThemeLayerReference[];
	readonly componentStyles?: readonly ThemeLayerReference[];
	readonly overrides?: readonly ThemeOverrideDocument[];
}

export interface ThemeAssignmentRecord extends ThemeAssignmentDefinition {
	readonly id: string;
	readonly revision: number;
	readonly updatedAt: string;
}

export interface ThemePersistenceSnapshot {
	readonly revisions: readonly ThemeRevisionRecord[];
	readonly publications: readonly ThemePublicationRecord[];
	readonly assignments: readonly ThemeAssignmentRecord[];
}

export interface ThemePersistenceRepository {
	snapshot(): Promise<ThemePersistenceSnapshot>;
	appendRevision(record: ThemeRevisionRecord): Promise<void>;
	publish(record: ThemePublicationRecord): Promise<void>;
	assign(record: ThemeAssignmentRecord): Promise<void>;
}

export interface CanonicalThemeProjection {
	readonly schemaVersion: 1;
	readonly surface: ThemeSurface;
	readonly mode: ThemeProjectionMode;
	readonly compatibility: {
		readonly designSystemVersion: string;
		readonly status: "compatible";
	};
	readonly assignmentRevision: number;
	readonly fingerprint: string;
	readonly layers: readonly {
		readonly kind: string;
		readonly sourceIdentifier: string;
		readonly sourceRevision?: number;
	}[];
	readonly css: ThemeCssProjection;
	readonly brand?: ResolvedThemeBrand;
}

export interface ThemeProjectionCacheStatus {
	readonly hits: number;
	readonly misses: number;
	readonly entries: readonly string[];
}

export class InMemoryThemePersistenceRepository implements ThemePersistenceRepository {
	private readonly revisions: ThemeRevisionRecord[] = [];
	private readonly publications = new Map<string, ThemePublicationRecord>();
	private readonly assignments = new Map<string, ThemeAssignmentRecord>();

	async snapshot(): Promise<ThemePersistenceSnapshot> {
		return structuredClone({
			revisions: this.revisions,
			publications: [...this.publications.values()],
			assignments: [...this.assignments.values()],
		});
	}

	async appendRevision(record: ThemeRevisionRecord): Promise<void> {
		if (
			this.revisions.some(
				(candidate) =>
					candidate.themeIdentifier === record.themeIdentifier &&
					candidate.revision === record.revision,
			)
		)
			throw conflict();
		this.revisions.push(structuredClone(record));
	}

	async publish(record: ThemePublicationRecord): Promise<void> {
		this.publications.set(record.themeIdentifier, structuredClone(record));
	}

	async assign(record: ThemeAssignmentRecord): Promise<void> {
		this.assignments.set(record.identifier, structuredClone(record));
	}
}

export class ThemePersistenceService {
	private readonly cache = new Map<string, CanonicalThemeProjection>();
	private hits = 0;
	private misses = 0;

	constructor(
		private readonly repository: ThemePersistenceRepository,
		private readonly validator: ThemePersistenceContractValidator,
		private readonly assets: ThemeAssetCatalogPort,
		private readonly designSystemVersion: string,
		private readonly now: () => Date = () => new Date(),
	) {
		if (!VERSION.test(designSystemVersion)) throw invalid();
	}

	async createRevision(input: {
		readonly themeIdentifier: string;
		readonly ownerIdentifier: string;
		readonly contract: ThemeContractDefinition;
	}): Promise<ThemeRevisionRecord> {
		validateIdentifier(input.themeIdentifier);
		validateIdentifier(input.ownerIdentifier);
		this.validator.validateThemeContract(input.contract);
		assertContractCompatibility(input.contract, this.designSystemVersion);
		const assetIdentifiers = collectAssetIdentifiers(input.contract);
		const assets = await Promise.all(
			assetIdentifiers.map(async (identifier) => {
				const asset = await this.assets.resolveAnalyzedAsset(identifier);
				if (!asset || asset.status !== "allowed") throw invalid();
				if (!/^[a-f0-9]{64}$/.test(asset.digest) || !asset.evidenceId.trim()) throw invalid();
				return asset;
			}),
		);
		const snapshot = await this.repository.snapshot();
		const existing = snapshot.revisions.filter(
			(revision) => revision.themeIdentifier === input.themeIdentifier,
		);
		if (existing.some((revision) => revision.ownerIdentifier !== input.ownerIdentifier))
			throw denied();
		const record: ThemeRevisionRecord = {
			id: randomUUID(),
			themeIdentifier: input.themeIdentifier,
			ownerIdentifier: input.ownerIdentifier,
			revision: Math.max(0, ...existing.map((revision) => revision.revision)) + 1,
			contract: structuredClone(input.contract),
			assets,
			fingerprint: digest({ contract: input.contract, assets }),
			createdAt: this.now().toISOString(),
		};
		await this.repository.appendRevision(record);
		return structuredClone(record);
	}

	async publish(input: {
		readonly themeIdentifier: string;
		readonly revision: number;
		readonly restoredFromRevision?: number;
	}): Promise<ThemePublicationRecord> {
		const snapshot = await this.repository.snapshot();
		const revision = snapshot.revisions.find(
			(candidate) =>
				candidate.themeIdentifier === input.themeIdentifier &&
				candidate.revision === input.revision,
		);
		if (!revision) throw invalid();
		if (
			input.restoredFromRevision !== undefined &&
			!snapshot.revisions.some(
				(candidate) =>
					candidate.themeIdentifier === input.themeIdentifier &&
					candidate.revision === input.restoredFromRevision,
			)
		)
			throw invalid();
		const publication: ThemePublicationRecord = {
			id: randomUUID(),
			themeIdentifier: input.themeIdentifier,
			revision: input.revision,
			publishedAt: this.now().toISOString(),
			...(input.restoredFromRevision === undefined
				? {}
				: { restoredFromRevision: input.restoredFromRevision }),
		};
		await this.repository.publish(publication);
		await this.invalidateTheme(input.themeIdentifier);
		return publication;
	}

	async assign(definition: ThemeAssignmentDefinition): Promise<ThemeAssignmentRecord> {
		validateAssignment(definition);
		const snapshot = await this.repository.snapshot();
		if (!publishedRevision(snapshot, definition.baseThemeIdentifier)) throw invalid();
		for (const reference of [
			...(definition.extensions ?? []),
			...(definition.componentStyles ?? []),
		]) {
			if (!publishedRevision(snapshot, reference.sourceIdentifier)) throw invalid();
		}
		for (const override of definition.overrides ?? []) {
			this.validator.validateThemeTokens(override.tokens);
			assertTokensProjectable(override.tokens, definition.surface, this.designSystemVersion);
		}
		const current = snapshot.assignments.find(
			(assignment) => assignment.identifier === definition.identifier,
		);
		const record: ThemeAssignmentRecord = {
			...structuredClone(definition),
			id: current?.id ?? randomUUID(),
			revision: (current?.revision ?? 0) + 1,
			updatedAt: this.now().toISOString(),
		};
		await this.repository.assign(record);
		this.invalidateAssignment(record.identifier);
		return record;
	}

	async project(input: {
		readonly surface: ThemeSurface;
		readonly mode?: ThemeProjectionMode;
		readonly locale: string;
	}): Promise<CanonicalThemeProjection> {
		if (!themeSurfaces.includes(input.surface)) throw invalid();
		const mode = input.mode ?? "default";
		if (!themeProjectionModes.includes(mode)) throw invalid();
		const snapshot = await this.repository.snapshot();
		const assignment = snapshot.assignments.find(
			(candidate) => candidate.surface === input.surface && candidate.mode === mode,
		);
		if (!assignment) throw invalid();
		const key = cacheKey(assignment, input.locale);
		const cached = this.cache.get(key);
		if (cached) {
			this.hits += 1;
			return structuredClone(cached);
		}
		this.misses += 1;
		const projection = buildProjection(
			snapshot,
			assignment,
			input.locale,
			this.designSystemVersion,
		);
		this.cache.set(key, projection);
		return structuredClone(projection);
	}

	cacheStatus(): ThemeProjectionCacheStatus {
		return { hits: this.hits, misses: this.misses, entries: [...this.cache.keys()].sort() };
	}

	private async invalidateTheme(themeIdentifier: string): Promise<void> {
		const snapshot = await this.repository.snapshot();
		const affected = new Set(
			snapshot.assignments
				.filter((assignment) => assignmentReferences(assignment, themeIdentifier))
				.map((assignment) => assignment.identifier),
		);
		for (const key of this.cache.keys()) {
			if (affected.has(key.split(":", 1)[0]!)) this.cache.delete(key);
		}
	}

	private invalidateAssignment(identifier: string): void {
		for (const key of this.cache.keys()) {
			if (key.startsWith(`${identifier}:`)) this.cache.delete(key);
		}
	}
}

function buildProjection(
	snapshot: ThemePersistenceSnapshot,
	assignment: ThemeAssignmentRecord,
	locale: string,
	designSystemVersion: string,
): CanonicalThemeProjection {
	const plan = resolveThemeFoundationPlan({
		surface: assignment.surface,
		baseThemeIdentifier: assignment.baseThemeIdentifier,
		...(assignment.extensions ? { extensions: assignment.extensions } : {}),
		...(assignment.componentStyles ? { componentStyles: assignment.componentStyles } : {}),
		instanceOverrides: overrideReferences(assignment, "instance-override"),
		userPreferences: overrideReferences(assignment, "user-preference"),
		accessibilityPreferences: overrideReferences(assignment, "accessibility-preference"),
	});
	let tokens: ThemeTokenSetDefinition = {};
	let brand: ResolvedThemeBrand | undefined;
	const layers: CanonicalThemeProjection["layers"][number][] = [];
	for (const layer of plan.layers) {
		const override = assignment.overrides?.find(
			(candidate) =>
				candidate.identifier === layer.sourceIdentifier && candidate.kind === layer.kind,
		);
		if (override) {
			tokens = mergeTokenSets(tokens, override.tokens);
			layers.push({ kind: layer.kind, sourceIdentifier: layer.sourceIdentifier });
			continue;
		}
		if (layer.kind === "core-invariant" || layer.kind === "design-system") {
			layers.push({ kind: layer.kind, sourceIdentifier: layer.sourceIdentifier });
			continue;
		}
		const revision = publishedRevision(snapshot, layer.sourceIdentifier);
		if (!revision) throw invalid();
		if (!revision.contract.surfaces.includes(assignment.surface)) throw invalid();
		tokens = mergeTokenSets(tokens, revision.contract.tokens ?? {});
		if (revision.contract.brand) brand = resolveThemeBrand(revision.contract.brand, locale);
		layers.push({
			kind: layer.kind,
			sourceIdentifier: layer.sourceIdentifier,
			sourceRevision: revision.revision,
		});
	}
	const revisionIdentifier = `assignment.${assignment.revision}`;
	const css = compileThemeCssProjection({
		surface: assignment.surface,
		designSystemVersion,
		revision: revisionIdentifier,
		tokens,
	});
	const unsigned = {
		schemaVersion: 1 as const,
		surface: assignment.surface,
		mode: assignment.mode,
		compatibility: { designSystemVersion, status: "compatible" as const },
		assignmentRevision: assignment.revision,
		layers,
		css,
		...(brand ? { brand } : {}),
	};
	return { ...unsigned, fingerprint: digest(unsigned) };
}

function mergeTokenSets(
	base: ThemeTokenSetDefinition,
	override: ThemeTokenSetDefinition,
): ThemeTokenSetDefinition {
	const media = new Map<string, ThemeTokenMediaOverride>();
	for (const entry of [...(base.media ?? []), ...(override.media ?? [])]) {
		const key = stableJson(entry.media);
		const current = media.get(key);
		media.set(key, {
			media: entry.media,
			values: { ...(current?.values ?? {}), ...entry.values },
		});
	}
	return {
		global: { ...(base.global ?? {}), ...(override.global ?? {}) },
		media: [...media.values()].sort((left, right) =>
			stableJson(left.media).localeCompare(stableJson(right.media)),
		),
	};
}

function publishedRevision(
	snapshot: ThemePersistenceSnapshot,
	themeIdentifier: string,
): ThemeRevisionRecord | undefined {
	const publication = snapshot.publications.find(
		(candidate) => candidate.themeIdentifier === themeIdentifier,
	);
	return snapshot.revisions.find(
		(revision) =>
			revision.themeIdentifier === themeIdentifier && revision.revision === publication?.revision,
	);
}

function validateAssignment(definition: ThemeAssignmentDefinition): void {
	validateIdentifier(definition.identifier);
	validateIdentifier(definition.baseThemeIdentifier);
	if (
		!themeSurfaces.includes(definition.surface) ||
		!themeProjectionModes.includes(definition.mode)
	)
		throw invalid();
	if (
		definition.surface === "recovery" &&
		definition.baseThemeIdentifier !== compendloreRecoveryThemeIdentifier
	)
		throw invalid();
	for (const reference of [
		...(definition.extensions ?? []),
		...(definition.componentStyles ?? []),
	]) {
		validateIdentifier(reference.sourceIdentifier);
	}
	for (const override of definition.overrides ?? []) {
		validateIdentifier(override.identifier);
		if (!Number.isSafeInteger(override.priority) || override.priority < 0) throw invalid();
	}
	resolveThemeFoundationPlan({
		surface: definition.surface,
		baseThemeIdentifier: definition.baseThemeIdentifier,
		...(definition.extensions ? { extensions: definition.extensions } : {}),
		...(definition.componentStyles ? { componentStyles: definition.componentStyles } : {}),
		instanceOverrides: overrideReferences(definition, "instance-override"),
		userPreferences: overrideReferences(definition, "user-preference"),
		accessibilityPreferences: overrideReferences(definition, "accessibility-preference"),
	});
}

function overrideReferences(
	assignment: Pick<ThemeAssignmentDefinition, "overrides">,
	kind: ThemeOverrideDocument["kind"],
): ThemeLayerReference[] {
	return (assignment.overrides ?? [])
		.filter((override) => override.kind === kind)
		.map(({ identifier, priority }) => ({ kind, sourceIdentifier: identifier, priority }));
}

function assertContractCompatibility(
	contract: ThemeContractDefinition,
	designSystemVersion: string,
): void {
	if (
		!contract.surfaces.length ||
		!contract.surfaces.every((surface) => themeSurfaces.includes(surface))
	)
		throw invalid();
	const required = contract.designSystemVersion.replace(/^\^/, "");
	if (!VERSION.test(required) || required.split(".")[0] !== designSystemVersion.split(".")[0])
		throw invalid();
	for (const value of Object.values(contract.tokens?.global ?? {})) assertSafeTokenValue(value);
	for (const media of contract.tokens?.media ?? []) {
		assertMediaQuery(media.media);
		for (const value of Object.values(media.values)) assertSafeTokenValue(value);
	}
	assertTokensProjectable(contract.tokens ?? {}, contract.surfaces[0]!, designSystemVersion);
}

function assertTokensProjectable(
	tokens: ThemeTokenSetDefinition,
	surface: ThemeSurface,
	designSystemVersion: string,
): void {
	compileThemeCssProjection({ surface, designSystemVersion, revision: "validation", tokens });
}

function collectAssetIdentifiers(contract: ThemeContractDefinition): string[] {
	const identifiers = new Set<string>();
	for (const value of Object.values(contract.tokens?.global ?? {}))
		collectTokenAsset(value, identifiers);
	for (const override of contract.tokens?.media ?? []) {
		for (const value of Object.values(override.values)) collectTokenAsset(value, identifiers);
	}
	if (contract.brand?.logo) identifiers.add(contract.brand.logo.assetIdentifier);
	for (const identifier of identifiers) validateIdentifier(identifier);
	return [...identifiers].sort();
}

function collectTokenAsset(value: ThemeTokenValue, identifiers: Set<string>): void {
	if (value.kind === "font-family" && value.source === "asset")
		identifiers.add(value.assetIdentifier);
}

function assertSafeTokenValue(value: ThemeTokenValue): void {
	if (value.kind === "font-family" && value.source === "asset")
		validateIdentifier(value.assetIdentifier);
	const serialized = stableJson(value).toLowerCase();
	if (serialized.includes("url(") || serialized.includes("javascript:") || serialized.includes("<"))
		throw invalid();
}

function assertMediaQuery(media: ThemeMediaQuery): void {
	if (Object.keys(media).some((key) => !["minWidth", "maxWidth", "orientation"].includes(key)))
		throw invalid();
}

function assignmentReferences(assignment: ThemeAssignmentRecord, themeIdentifier: string): boolean {
	return (
		assignment.baseThemeIdentifier === themeIdentifier ||
		[...(assignment.extensions ?? []), ...(assignment.componentStyles ?? [])].some(
			(reference) => reference.sourceIdentifier === themeIdentifier,
		)
	);
}

function cacheKey(assignment: ThemeAssignmentRecord, locale: string): string {
	return `${assignment.identifier}:${assignment.revision}:${locale.toLowerCase()}`;
}

function validateIdentifier(value: string): void {
	if (!IDENTIFIER.test(value) || value.length > 160) throw invalid();
}

function digest(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function invalid(): CoreError {
	return new CoreError("configuration.invalid", "The persisted theme contract is invalid.");
}

function conflict(): CoreError {
	return new CoreError("infrastructure.conflict", "The theme revision already exists.");
}

function denied(): CoreError {
	return new CoreError("authorization.denied", "The theme owner cannot be changed.");
}
