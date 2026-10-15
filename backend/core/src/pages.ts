import { createHash } from "node:crypto";
import { CoreError } from "./errors.js";

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const PATH = /^\/(?:[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9][a-z0-9._~-]*)*)?$/;

export type PageSurface = "account" | "administration" | "site" | "system";
export type PageExportPolicy = "exportable" | "locked";

export interface PageLifecyclePolicy {
	readonly canDisable: boolean;
	readonly canArchive: boolean;
	readonly canDelete: boolean;
}

export interface PageDefinition {
	readonly identifier: string;
	readonly ownerContributionKey: string;
	readonly version: string;
	readonly surface: PageSurface;
	readonly path: string;
	readonly component: string;
	readonly titleResource: string;
	readonly content: readonly PageContentBlock[];
	readonly requiredCapabilities: readonly string[];
	readonly lifecycle: PageLifecyclePolicy;
	readonly exportPolicy: PageExportPolicy;
	readonly enabledByDefault: boolean;
}

export type PageContentBlock =
	| {
			readonly kind: "header";
			readonly eyebrowResource?: string;
			readonly titleResource: string;
			readonly descriptionResource?: string;
	  }
	| {
			readonly kind: "card";
			readonly eyebrowResource?: string;
			readonly titleResource: string;
			readonly descriptionResource?: string;
	  };

export interface PageBundle {
	readonly sourceContributionKey: string;
	readonly pages: readonly PageDefinition[];
}

export interface PageVersion {
	readonly pageIdentifier: string;
	readonly revision: number;
	readonly definition: PageDefinition;
	readonly publishedAt?: string;
}

export interface PageSnapshot {
	readonly versions: readonly PageVersion[];
}

export interface PageRepository {
	materialize(bundle: PageBundle): Promise<void>;
	snapshot(): Promise<PageSnapshot>;
	replace(version: PageVersion): Promise<void>;
}

export interface PageMaterializationPort {
	materializePages(bundle: PageBundle): Promise<void>;
}

export interface PagePrincipal {
	readonly capabilities: ReadonlySet<string>;
}

export interface ResolvedPageProjection {
	readonly identifier: string;
	readonly surface: PageSurface;
	readonly path: string;
	readonly component: string;
	readonly title: string;
	readonly content: readonly ResolvedPageContentBlock[];
	readonly revision: number;
	readonly fingerprint: string;
}

export interface ResolvedPageContentBlock {
	readonly kind: "card" | "header";
	readonly eyebrow?: string;
	readonly title: string;
	readonly description?: string;
}

export interface PortablePageDocument {
	readonly format: "compendlore.page";
	readonly schemaVersion: 1;
	readonly page: Omit<PageDefinition, "ownerContributionKey" | "exportPolicy" | "lifecycle">;
}

export interface PageImportPreview {
	readonly identifier: string;
	readonly conflicts: readonly string[];
	readonly missingDependencies: readonly string[];
	readonly applicable: boolean;
}

export class InMemoryPageRepository implements PageRepository {
	private readonly versions = new Map<string, PageVersion[]>();

	async materialize(bundle: PageBundle): Promise<void> {
		for (const definition of bundle.pages) {
			const current = this.versions.get(definition.identifier) ?? [];
			if (
				current.some(
					(version) => version.definition.ownerContributionKey !== bundle.sourceContributionKey,
				)
			)
				throw conflict();
			if (current.some((version) => version.definition.version === definition.version)) continue;
			this.versions.set(definition.identifier, [
				...current,
				{ pageIdentifier: definition.identifier, revision: current.length + 1, definition },
			]);
		}
	}

	async snapshot(): Promise<PageSnapshot> {
		return { versions: [...this.versions.values()].flat().map(cloneVersion) };
	}

	async replace(version: PageVersion): Promise<void> {
		const current = this.versions.get(version.pageIdentifier) ?? [];
		const index = current.findIndex((candidate) => candidate.revision === version.revision);
		if (index < 0) this.versions.set(version.pageIdentifier, [...current, cloneVersion(version)]);
		else this.versions.set(version.pageIdentifier, current.with(index, cloneVersion(version)));
	}
}

export class PageService implements PageMaterializationPort {
	constructor(private readonly repository: PageRepository) {}

	async materializePages(bundle: PageBundle): Promise<void> {
		validateBundle(bundle);
		await this.repository.materialize(bundle);
	}

	async createPage(definition: PageDefinition): Promise<PageVersion> {
		validateDefinition(definition);
		if (definition.ownerContributionKey !== "instance") throw invalid();
		await this.repository.materialize({ sourceContributionKey: "instance", pages: [definition] });
		return this.requireLatest(definition.identifier);
	}

	async publish(identifier: string, expectedRevision: number): Promise<PageVersion> {
		const version = await this.requireLatest(identifier);
		if (version.revision !== expectedRevision) throw conflict();
		const published = { ...version, publishedAt: new Date().toISOString() };
		await this.repository.replace(published);
		return published;
	}

	async resolve(input: {
		readonly path: string;
		readonly surface: PageSurface;
		readonly principal: PagePrincipal;
		readonly resolveText: (resourceIdentifier: string) => Promise<string>;
	}): Promise<ResolvedPageProjection | undefined> {
		const published = (await this.repository.snapshot()).versions.filter(
			(version) =>
				version.publishedAt &&
				version.definition.enabledByDefault &&
				version.definition.path === input.path &&
				version.definition.surface === input.surface,
		);
		const version = published.sort((left, right) => right.revision - left.revision)[0];
		if (!version) return undefined;
		if (!hasCapabilities(input.principal.capabilities, version.definition.requiredCapabilities))
			return undefined;
		const title = await input.resolveText(version.definition.titleResource);
		const content = await Promise.all(
			version.definition.content.map(async (block) => ({
				kind: block.kind,
				...(block.eyebrowResource
					? { eyebrow: await input.resolveText(block.eyebrowResource) }
					: {}),
				title: await input.resolveText(block.titleResource),
				...(block.descriptionResource
					? { description: await input.resolveText(block.descriptionResource) }
					: {}),
			})),
		);
		return {
			identifier: version.pageIdentifier,
			surface: version.definition.surface,
			path: version.definition.path,
			component: version.definition.component,
			title,
			content,
			revision: version.revision,
			fingerprint: fingerprint(version),
		};
	}

	async exportPage(identifier: string): Promise<PortablePageDocument> {
		const version = await this.requireLatest(identifier);
		if (version.definition.exportPolicy !== "exportable") throw denied();
		const definition = version.definition;
		const page: PortablePageDocument["page"] = {
			identifier: definition.identifier,
			version: definition.version,
			surface: definition.surface,
			path: definition.path,
			component: definition.component,
			titleResource: definition.titleResource,
			content: definition.content,
			requiredCapabilities: definition.requiredCapabilities,
			enabledByDefault: definition.enabledByDefault,
		};
		return { format: "compendlore.page", schemaVersion: 1, page };
	}

	async previewImport(
		document: PortablePageDocument,
		availableComponents: ReadonlySet<string>,
	): Promise<PageImportPreview> {
		assertPortable(document);
		const existing = (await this.repository.snapshot()).versions.some(
			(version) => version.pageIdentifier === document.page.identifier,
		);
		const missingDependencies = availableComponents.has(document.page.component)
			? []
			: [document.page.component];
		const conflicts = existing ? ["identifier"] : [];
		return {
			identifier: document.page.identifier,
			conflicts,
			missingDependencies,
			applicable: conflicts.length === 0 && missingDependencies.length === 0,
		};
	}

	async importPage(
		document: PortablePageDocument,
		availableComponents: ReadonlySet<string>,
	): Promise<PageVersion> {
		const preview = await this.previewImport(document, availableComponents);
		if (!preview.applicable) throw conflict();
		return this.createPage({
			...document.page,
			ownerContributionKey: "instance",
			exportPolicy: "exportable",
			lifecycle: { canDisable: true, canArchive: true, canDelete: true },
		});
	}

	private async requireLatest(identifier: string): Promise<PageVersion> {
		const versions = (await this.repository.snapshot()).versions.filter(
			(version) => version.pageIdentifier === identifier,
		);
		const version = versions.sort((left, right) => right.revision - left.revision)[0];
		if (!version) throw invalid();
		return version;
	}
}

export function nativePageFoundation(): PageBundle {
	const locked = { canDisable: false, canArchive: false, canDelete: false } as const;
	return {
		sourceContributionKey: "module.site",
		pages: [
			page(
				"core.home",
				"site",
				"/",
				"core.page",
				"site.home.title",
				[
					{
						kind: "header",
						eyebrowResource: "site.home.eyebrow",
						titleResource: "site.home.title",
						descriptionResource: "site.home.description",
					},
					{
						kind: "card",
						eyebrowResource: "site.home.navigation.eyebrow",
						titleResource: "site.home.navigation.title",
						descriptionResource: "site.home.navigation.description",
					},
					{
						kind: "card",
						eyebrowResource: "site.home.session.eyebrow",
						titleResource: "site.home.session.title",
						descriptionResource: "site.home.session.description",
					},
					{
						kind: "card",
						eyebrowResource: "site.home.resilience.eyebrow",
						titleResource: "site.home.resilience.title",
						descriptionResource: "site.home.resilience.description",
					},
				],
				[],
				"exportable",
				locked,
			),
			page(
				"core.admin.dashboard",
				"administration",
				"/admin",
				"core.admin.dashboard",
				"administration.dashboard.title",
				[],
				["core.administration.access"],
				"locked",
				locked,
			),
			page(
				"core.admin.modules",
				"administration",
				"/admin/modules",
				"core.admin.modules",
				"administration.modules.title",
				[],
				["core.administration.access"],
				"locked",
				locked,
			),
			page(
				"core.admin.interface",
				"administration",
				"/admin/interface",
				"core.admin.interface",
				"administration.interface.title",
				[],
				["core.administration.access"],
				"locked",
				locked,
			),
		],
	};
}

function page(
	identifier: string,
	surface: PageSurface,
	path: string,
	component: string,
	titleResource: string,
	content: readonly PageContentBlock[],
	requiredCapabilities: readonly string[],
	exportPolicy: PageExportPolicy,
	lifecycle: PageLifecyclePolicy,
): PageDefinition {
	return {
		identifier,
		ownerContributionKey: "module.site",
		version: "1.0.0",
		surface,
		path,
		component,
		titleResource,
		content,
		requiredCapabilities,
		lifecycle,
		exportPolicy,
		enabledByDefault: true,
	};
}

function validateBundle(bundle: PageBundle): void {
	if (!IDENTIFIER.test(bundle.sourceContributionKey) || bundle.pages.length === 0) throw invalid();
	const identifiers = new Set<string>();
	const routes = new Set<string>();
	for (const definition of bundle.pages) {
		validateDefinition(definition);
		if (definition.ownerContributionKey !== bundle.sourceContributionKey) throw invalid();
		if (identifiers.has(definition.identifier)) throw conflict();
		const route = `${definition.surface}:${definition.path}`;
		if (routes.has(route)) throw conflict();
		identifiers.add(definition.identifier);
		routes.add(route);
	}
}

function validateDefinition(definition: PageDefinition): void {
	assertExactKeys(definition, [
		"identifier",
		"ownerContributionKey",
		"version",
		"surface",
		"path",
		"component",
		"titleResource",
		"content",
		"requiredCapabilities",
		"lifecycle",
		"exportPolicy",
		"enabledByDefault",
	]);
	if (!IDENTIFIER.test(definition.identifier) || !IDENTIFIER.test(definition.ownerContributionKey))
		throw invalid();
	if (!/^\d+\.\d+\.\d+$/.test(definition.version) || !PATH.test(definition.path)) throw invalid();
	if (!IDENTIFIER.test(definition.component) || !IDENTIFIER.test(definition.titleResource))
		throw invalid();
	if (!Array.isArray(definition.content) || definition.content.length > 100) throw invalid();
	for (const block of definition.content) {
		assertExactKeys(block, ["kind", "eyebrowResource", "titleResource", "descriptionResource"]);
		if (block.kind !== "card" && block.kind !== "header") throw invalid();
		if (!IDENTIFIER.test(block.titleResource)) throw invalid();
		if (block.eyebrowResource && !IDENTIFIER.test(block.eyebrowResource)) throw invalid();
		if (block.descriptionResource && !IDENTIFIER.test(block.descriptionResource)) throw invalid();
	}
	if (new Set(definition.requiredCapabilities).size !== definition.requiredCapabilities.length)
		throw invalid();
	if (definition.requiredCapabilities.some((capability) => !IDENTIFIER.test(capability)))
		throw invalid();
	if (
		definition.exportPolicy === "locked" &&
		(definition.lifecycle.canDisable ||
			definition.lifecycle.canArchive ||
			definition.lifecycle.canDelete)
	)
		throw invalid();
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
	const allowedKeys = new Set(allowed);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw invalid();
}

function assertPortable(document: PortablePageDocument): void {
	if (document.format !== "compendlore.page" || document.schemaVersion !== 1) throw invalid();
	validateDefinition({
		...document.page,
		ownerContributionKey: "instance",
		exportPolicy: "exportable",
		lifecycle: { canDisable: true, canArchive: true, canDelete: true },
	});
}

function hasCapabilities(actual: ReadonlySet<string>, required: readonly string[]): boolean {
	return actual.has("*") || required.every((capability) => actual.has(capability));
}

function fingerprint(version: PageVersion): string {
	return createHash("sha256").update(JSON.stringify(version)).digest("hex");
}

function cloneVersion(version: PageVersion): PageVersion {
	return structuredClone(version);
}

function invalid(): CoreError {
	return new CoreError("configuration.invalid", "The page contract is invalid.");
}

function conflict(): CoreError {
	return new CoreError(
		"infrastructure.conflict",
		"The page operation conflicts with current state.",
	);
}

function denied(): CoreError {
	return new CoreError("authorization.denied", "The page operation is not allowed.");
}
