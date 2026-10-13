import type { CoreJsonValue } from "./store.js";
import { CoreError } from "./errors.js";
import type { LocalizationContext, LocalizationEngine } from "./localization.js";

export type PageSurface = "account" | "administration" | "site" | "system";
export type PageOwnerKind = "addon" | "core" | "instance" | "native-module";
export type PageRevisionState = "draft" | "published" | "scheduled" | "validated";

export type PageContextDefinition =
	| { readonly kind: "none" }
	| {
			readonly kind: "fixed-entity";
			readonly entityTypeIdentifier: string;
			readonly entityId: string;
	  }
	| { readonly kind: "entity-type"; readonly entityTypeIdentifier: string }
	| {
			readonly kind: "entity-collection";
			readonly entityTypeIdentifier: string;
			readonly queryIdentifier: string;
	  }
	| { readonly kind: "registered"; readonly contextTypeIdentifier: string };

export interface RouteParameterTypeDefinition {
	readonly identifier: string;
	readonly contributionKey: string;
	readonly base: "integer" | "locale" | "slug" | "string" | "uuid";
	readonly maximumLength?: number;
	readonly allowedValues?: readonly string[];
}

export interface PageRouteDefinition {
	readonly identifier: string;
	readonly pattern: string;
	readonly locale?: string;
	readonly aliases?: readonly string[];
	readonly priority?: number;
	readonly canonical?: boolean;
	readonly redirectToRouteIdentifier?: string;
	readonly active?: boolean;
}

export interface PageGridBreakpointDefinition {
	readonly identifier: string;
	readonly minimumWidth: number;
	readonly columns: number;
	readonly rowHeight: number;
	readonly gap: number;
	readonly inherits?: string;
}

export interface PageContainerPlacement {
	readonly breakpoint: string;
	readonly column: number;
	readonly row: number;
	readonly columnSpan: number;
	readonly rowSpan: number;
}

export interface PageContainerDefinition {
	readonly identifier: string;
	readonly regionIdentifier: string;
	readonly minimumColumnSpan?: number;
	readonly minimumRowSpan?: number;
	readonly placements: readonly PageContainerPlacement[];
}

export interface PageRegionDefinition {
	readonly identifier: string;
	readonly order: number;
}

export type PageContentSourceDefinition =
	| { readonly kind: "localized-text"; readonly textIdentifier: string }
	| { readonly kind: "media"; readonly mediaIdentifier: string }
	| { readonly kind: "entity-field"; readonly fieldIdentifier: string }
	| { readonly kind: "collection"; readonly providerIdentifier: string }
	| { readonly kind: "computed"; readonly providerIdentifier: string }
	| { readonly kind: "literal"; readonly value: CoreJsonValue };

export interface PageComponentInstanceDefinition {
	readonly identifier: string;
	readonly componentIdentifier: string;
	readonly containerIdentifier: string;
	readonly order: number;
	readonly properties?: Readonly<Record<string, CoreJsonValue>>;
	readonly sources?: Readonly<Record<string, PageContentSourceDefinition>>;
	readonly actionIdentifiers?: readonly string[];
}

export interface PageDocumentDefinition {
	readonly breakpoints: readonly PageGridBreakpointDefinition[];
	readonly regions: readonly PageRegionDefinition[];
	readonly containers: readonly PageContainerDefinition[];
	readonly components: readonly PageComponentInstanceDefinition[];
}

export interface PageComponentContractDefinition {
	readonly identifier: string;
	readonly contributionKey: string;
	readonly contractVersion: string;
	readonly frontendModuleIdentifier: string;
	readonly allowedProperties?: readonly string[];
	readonly slots?: readonly string[];
	readonly events?: readonly string[];
	readonly requiredCapabilities?: readonly string[];
}

export interface PageDataProviderContractDefinition {
	readonly identifier: string;
	readonly contributionKey: string;
	readonly contractVersion: string;
	readonly businessMethodIdentifier: string;
	readonly contextKinds: readonly PageContextDefinition["kind"][];
}

export interface PageActionContractDefinition {
	readonly identifier: string;
	readonly contributionKey: string;
	readonly contractVersion: string;
	readonly businessMethodIdentifier: string;
	readonly requiredCapability?: string;
}

export interface PageContextTypeDefinition {
	readonly identifier: string;
	readonly contributionKey: string;
	readonly contractVersion: string;
	readonly resolverMethodIdentifier: string;
	readonly parameterTypes: Readonly<Record<string, string>>;
}

export interface PageDefinition {
	readonly identifier: string;
	readonly contributionKey: string;
	readonly ownerKind: PageOwnerKind;
	readonly surface: PageSurface;
	readonly titleTextIdentifier: string;
	readonly descriptionTextIdentifier?: string;
	readonly requiredCapabilities: readonly string[];
	readonly editable: boolean;
	readonly removable: boolean;
	readonly archived?: boolean;
	readonly context: PageContextDefinition;
	readonly routes: readonly PageRouteDefinition[];
	readonly initialDocument: PageDocumentDefinition;
	readonly published: boolean;
	readonly canonicalFor?: {
		readonly entityTypeIdentifier: string;
		readonly usage: string;
	};
}

export interface PageRevision {
	readonly pageIdentifier: string;
	readonly revision: number;
	readonly state: PageRevisionState;
	readonly document: PageDocumentDefinition;
	readonly authorId?: string;
	readonly createdAt: Date;
	readonly validatedAt?: Date;
	readonly publishedAt?: Date;
	readonly scheduledAt?: Date;
}

export interface ResolvedPage {
	readonly identifier: string;
	readonly routeIdentifier: string;
	readonly route: string;
	readonly canonicalRoute: string;
	readonly surface: PageSurface;
	readonly routeParameters: Readonly<Record<string, string | number>>;
	readonly title: string;
	readonly description?: string;
	readonly contributionKey: string;
	readonly editable: boolean;
	readonly removable: boolean;
	readonly context: PageContextDefinition;
	readonly revision: number;
	readonly document: PageDocumentDefinition;
	readonly redirectedFrom?: string;
}

export interface ResolvedPageDescriptor {
	readonly identifier: string;
	readonly surface: PageSurface;
	readonly routes: readonly PageRouteDefinition[];
	readonly title: string;
	readonly description?: string;
	readonly contributionKey: string;
	readonly editable: boolean;
	readonly removable: boolean;
	readonly context: PageContextDefinition;
	readonly revision: number;
	readonly document: PageDocumentDefinition;
}

interface CompiledRoute {
	readonly definition: PageRouteDefinition;
	readonly pageIdentifier: string;
	readonly surface: PageSurface;
	readonly segments: readonly RouteSegment[];
	readonly aliases: readonly {
		readonly pattern: string;
		readonly segments: readonly RouteSegment[];
	}[];
}

type RouteSegment =
	| { readonly kind: "static"; readonly value: string }
	| { readonly kind: "parameter"; readonly name: string; readonly typeIdentifier: string };

const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const routeParameterPattern = /^\{([a-z][a-z0-9_-]*):([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)\}$/;

export class PageCatalog {
	private readonly pages = new Map<string, PageDefinition>();
	private readonly routes = new Map<string, CompiledRoute>();
	private readonly revisions = new Map<string, PageRevision[]>();
	private readonly publishedRevisions = new Map<string, number>();
	private readonly parameterTypes = new Map<string, RouteParameterTypeDefinition>();
	private readonly componentContracts = new Map<string, PageComponentContractDefinition>();
	private readonly dataProviderContracts = new Map<string, PageDataProviderContractDefinition>();
	private readonly actionContracts = new Map<string, PageActionContractDefinition>();
	private readonly contextTypes = new Map<string, PageContextTypeDefinition>();

	constructor(
		private readonly localization: LocalizationEngine,
		private readonly now: () => Date = () => new Date(),
	) {
		for (const definition of builtInParameterTypes) this.registerParameterType(definition);
	}

	registerParameterType(definition: RouteParameterTypeDefinition): void {
		validateIdentifier(definition.identifier, "type de paramètre");
		if (
			definition.maximumLength !== undefined &&
			(!Number.isSafeInteger(definition.maximumLength) ||
				definition.maximumLength < 1 ||
				definition.maximumLength > 512)
		) {
			invalid("La longueur maximale d’un paramètre de route est invalide.");
		}
		if (definition.allowedValues?.some((value) => !value || value.includes("/"))) {
			invalid("Une valeur autorisée de paramètre de route est invalide.");
		}
		const existing = this.parameterTypes.get(definition.identifier);
		if (existing && JSON.stringify(existing) !== JSON.stringify(definition)) {
			invalid(`Le type de paramètre ${definition.identifier} est déjà enregistré différemment.`);
		}
		this.parameterTypes.set(definition.identifier, Object.freeze(structuredClone(definition)));
	}

	registerComponentContract(definition: PageComponentContractDefinition): void {
		this.registerContract(this.componentContracts, definition, "composant");
	}

	registerDataProviderContract(definition: PageDataProviderContractDefinition): void {
		this.registerContract(this.dataProviderContracts, definition, "fournisseur de données");
	}

	registerActionContract(definition: PageActionContractDefinition): void {
		this.registerContract(this.actionContracts, definition, "action");
	}

	registerContextType(definition: PageContextTypeDefinition): void {
		this.registerContract(this.contextTypes, definition, "contexte");
		for (const typeIdentifier of Object.values(definition.parameterTypes)) {
			if (!this.parameterTypes.has(typeIdentifier)) {
				invalid(`Le type de paramètre ${typeIdentifier} du contexte est inconnu.`);
			}
		}
	}

	register(definition: PageDefinition): void {
		validateIdentifier(definition.identifier, "page");
		if (definition.routes.length === 0) invalid("Une page doit déclarer au moins une route.");
		if (definition.archived && definition.published) {
			invalid("Une page archivée ne peut pas être publiée.");
		}
		this.validateContext(definition.context);
		this.validateDocument(definition.initialDocument);
		this.validateCanonicalAssignment(definition);
		const compiled = definition.routes.map((route) => this.compileRoute(definition, route));
		for (const route of compiled) this.assertRouteAvailable(route, definition.identifier);
		const availableRouteIdentifiers = new Set([
			...this.routes.keys(),
			...compiled.map((route) => route.definition.identifier),
		]);
		for (const route of compiled) {
			if (
				route.definition.redirectToRouteIdentifier &&
				(!availableRouteIdentifiers.has(route.definition.redirectToRouteIdentifier) ||
					route.definition.redirectToRouteIdentifier === route.definition.identifier)
			) {
				invalid(`La redirection ${route.definition.identifier} possède une cible invalide.`);
			}
		}
		const previous = this.pages.get(definition.identifier);
		if (previous) {
			for (const route of previous.routes) this.routes.delete(route.identifier);
		}
		this.pages.set(definition.identifier, Object.freeze(structuredClone(definition)));
		for (const route of compiled) this.routes.set(route.definition.identifier, route);
		if (!this.revisions.has(definition.identifier)) {
			const createdAt = this.now();
			const revision: PageRevision = Object.freeze({
				pageIdentifier: definition.identifier,
				revision: 1,
				state: definition.published ? "published" : "draft",
				document: structuredClone(definition.initialDocument),
				createdAt,
				...(definition.published ? { publishedAt: createdAt } : {}),
			});
			this.revisions.set(definition.identifier, [revision]);
			if (definition.published) this.publishedRevisions.set(definition.identifier, 1);
		}
	}

	createDraft(pageIdentifier: string, authorId?: string): PageRevision {
		const definition = this.requirePage(pageIdentifier);
		if (!definition.editable) invalid(`La page ${pageIdentifier} n’est pas modifiable.`);
		const history = this.revisions.get(pageIdentifier)!;
		const source = this.currentRevision(pageIdentifier) ?? history.at(-1)!;
		const revision = this.newRevision(pageIdentifier, source.document, "draft", authorId);
		history.push(revision);
		return revision;
	}

	updateDraft(
		pageIdentifier: string,
		revisionNumber: number,
		expectedRevision: number,
		document: PageDocumentDefinition,
	): PageRevision {
		if (revisionNumber !== expectedRevision) invalid("La révision attendue ne correspond pas.");
		this.validateDocument(document);
		const history = this.revisions.get(pageIdentifier) ?? [];
		const index = history.findIndex((revision) => revision.revision === revisionNumber);
		const current = history[index];
		if (!current || current.state !== "draft") invalid("La révision modifiable est introuvable.");
		const updated = Object.freeze({ ...current, document: structuredClone(document) });
		history[index] = updated;
		return updated;
	}

	validateDraft(pageIdentifier: string, revisionNumber: number): PageRevision {
		return this.transitionRevision(pageIdentifier, revisionNumber, "draft", "validated", {
			validatedAt: this.now(),
		});
	}

	publish(
		pageIdentifier: string,
		revisionNumber: number,
		expectedPublishedRevision?: number,
	): PageRevision {
		const currentPublished = this.publishedRevisions.get(pageIdentifier);
		if (expectedPublishedRevision !== undefined && currentPublished !== expectedPublishedRevision) {
			invalid("La page publiée a changé depuis le début de l’édition.");
		}
		const history = this.revisions.get(pageIdentifier) ?? [];
		const index = history.findIndex((revision) => revision.revision === revisionNumber);
		const current = history[index];
		if (!current || !["draft", "scheduled", "validated"].includes(current.state)) {
			invalid("La révision ne peut pas être publiée.");
		}
		this.validateDocument(current.document);
		const published = Object.freeze({
			...current,
			state: "published" as const,
			publishedAt: this.now(),
		});
		history[index] = published;
		this.publishedRevisions.set(pageIdentifier, revisionNumber);
		return published;
	}

	schedule(pageIdentifier: string, revisionNumber: number, scheduledAt: Date): PageRevision {
		if (scheduledAt <= this.now()) invalid("La publication planifiée doit être future.");
		return this.transitionRevision(pageIdentifier, revisionNumber, "validated", "scheduled", {
			scheduledAt,
		});
	}

	publishScheduled(): readonly PageRevision[] {
		const published: PageRevision[] = [];
		for (const [pageIdentifier, history] of this.revisions) {
			for (const revision of history) {
				if (revision.state === "scheduled" && revision.scheduledAt! <= this.now()) {
					published.push(this.publish(pageIdentifier, revision.revision));
				}
			}
		}
		return published;
	}

	rollback(pageIdentifier: string, targetRevision: number, authorId?: string): PageRevision {
		const source = this.history(pageIdentifier).find(
			(revision) => revision.revision === targetRevision,
		);
		if (!source) invalid("La révision de restauration est inconnue.");
		const restored = this.newRevision(pageIdentifier, source.document, "validated", authorId);
		this.revisions.get(pageIdentifier)!.push(restored);
		return this.publish(
			pageIdentifier,
			restored.revision,
			this.publishedRevisions.get(pageIdentifier),
		);
	}

	resolve(
		path: string,
		capabilities: ReadonlySet<string>,
		context: LocalizationContext,
		surface?: PageSurface,
	): ResolvedPage | undefined {
		this.publishScheduled();
		const routeMatch = this.resolveRoute(path, surface);
		if (!routeMatch) return undefined;
		let resolvedRoute = routeMatch.route;
		const visitedRoutes = new Set<string>();
		while (resolvedRoute.definition.redirectToRouteIdentifier) {
			if (visitedRoutes.has(resolvedRoute.definition.identifier)) {
				invalid("Un cycle de redirections de pages a été détecté.");
			}
			visitedRoutes.add(resolvedRoute.definition.identifier);
			resolvedRoute = this.routes.get(resolvedRoute.definition.redirectToRouteIdentifier)!;
		}
		const page = this.pages.get(resolvedRoute.pageIdentifier)!;
		if (
			page.archived ||
			!page.requiredCapabilities.every(
				(capability) => capabilities.has("*") || capabilities.has(capability),
			)
		) {
			return undefined;
		}
		const revision = this.currentRevision(page.identifier);
		if (!revision) return undefined;
		const canonicalIdentifier =
			this.canonicalRoute(page.identifier, resolvedRoute.definition.locale)?.definition
				.identifier ?? resolvedRoute.definition.identifier;
		return {
			identifier: page.identifier,
			routeIdentifier: resolvedRoute.definition.identifier,
			route: path,
			canonicalRoute: this.buildRoute(canonicalIdentifier, routeMatch.parameters),
			surface: page.surface,
			routeParameters: routeMatch.parameters,
			title: this.localization.resolve(page.titleTextIdentifier, context).value,
			...(page.descriptionTextIdentifier
				? { description: this.localization.resolve(page.descriptionTextIdentifier, context).value }
				: {}),
			contributionKey: page.contributionKey,
			editable: page.editable,
			removable: page.removable,
			context: page.context,
			revision: revision.revision,
			document: structuredClone(revision.document),
			...(routeMatch.alias || visitedRoutes.size > 0 ? { redirectedFrom: path } : {}),
		};
	}

	resolveByIdentifier(
		pageIdentifier: string,
		capabilities: ReadonlySet<string>,
		context: LocalizationContext,
	): ResolvedPage | undefined {
		const page = this.pages.get(pageIdentifier);
		const route = page ? this.canonicalRoute(pageIdentifier) : undefined;
		if (!route || route.segments.some((segment) => segment.kind === "parameter")) return undefined;
		return this.resolve(
			this.buildRoute(route.definition.identifier, {}),
			capabilities,
			context,
			page!.surface,
		);
	}

	describe(
		pageIdentifier: string,
		capabilities: ReadonlySet<string>,
		context: LocalizationContext,
	): ResolvedPageDescriptor | undefined {
		this.publishScheduled();
		const page = this.pages.get(pageIdentifier);
		if (
			!page ||
			page.archived ||
			!page.requiredCapabilities.every(
				(capability) => capabilities.has("*") || capabilities.has(capability),
			)
		) {
			return undefined;
		}
		const revision = this.currentRevision(pageIdentifier);
		if (!revision) return undefined;
		return {
			identifier: page.identifier,
			surface: page.surface,
			routes: page.routes.map((route) => structuredClone(route)),
			title: this.localization.resolve(page.titleTextIdentifier, context).value,
			...(page.descriptionTextIdentifier
				? { description: this.localization.resolve(page.descriptionTextIdentifier, context).value }
				: {}),
			contributionKey: page.contributionKey,
			editable: page.editable,
			removable: page.removable,
			context: structuredClone(page.context),
			revision: revision.revision,
			document: structuredClone(revision.document),
		};
	}

	buildRoute(identifier: string, parameters: Readonly<Record<string, string | number>>): string {
		const route = this.routes.get(identifier);
		if (!route) invalid(`La route ${identifier} est inconnue.`);
		return `/${route.segments
			.map((segment) => {
				if (segment.kind === "static") return segment.value;
				const value = parameters[segment.name];
				if (value === undefined || !this.matchesParameter(segment.typeIdentifier, String(value))) {
					invalid(`Le paramètre ${segment.name} est absent ou invalide.`);
				}
				return encodeURIComponent(String(value));
			})
			.join("/")}`;
	}

	list(): readonly PageDefinition[] {
		return [...this.pages.values()].sort((left, right) =>
			left.identifier.localeCompare(right.identifier),
		);
	}

	listParameterTypes(): readonly RouteParameterTypeDefinition[] {
		return [...this.parameterTypes.values()].sort((left, right) =>
			left.identifier.localeCompare(right.identifier),
		);
	}

	history(pageIdentifier: string): readonly PageRevision[] {
		this.requirePage(pageIdentifier);
		return [...(this.revisions.get(pageIdentifier) ?? [])].sort(
			(left, right) => left.revision - right.revision,
		);
	}

	private registerContract<
		T extends { readonly identifier: string; readonly contractVersion: string },
	>(store: Map<string, T>, definition: T, label: string): void {
		validateIdentifier(definition.identifier, label);
		if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(definition.contractVersion)) {
			invalid(`La version du contrat ${definition.identifier} est invalide.`);
		}
		const existing = store.get(definition.identifier);
		if (existing && existing.contractVersion === definition.contractVersion) {
			invalid(`Le contrat ${definition.identifier}@${definition.contractVersion} existe déjà.`);
		}
		store.set(definition.identifier, Object.freeze(structuredClone(definition)));
	}

	private compileRoute(page: PageDefinition, definition: PageRouteDefinition): CompiledRoute {
		validateIdentifier(definition.identifier, "route");
		if (definition.locale && !isLocale(definition.locale)) {
			invalid("La locale de route est invalide.");
		}
		const segments = this.parsePattern(definition.pattern);
		const aliases = (definition.aliases ?? []).map((pattern) => ({
			pattern,
			segments: this.parsePattern(pattern),
		}));
		if (definition.redirectToRouteIdentifier && definition.canonical) {
			invalid("Une redirection ne peut pas être une route canonique.");
		}
		return {
			definition: Object.freeze({
				...definition,
				active: definition.active ?? true,
				priority: definition.priority ?? 0,
			}),
			pageIdentifier: page.identifier,
			surface: page.surface,
			segments,
			aliases,
		};
	}

	private parsePattern(pattern: string): readonly RouteSegment[] {
		if (
			!pattern.startsWith("/") ||
			pattern.includes("//") ||
			pattern.includes("?") ||
			pattern.includes("#")
		) {
			invalid(`Le motif de route ${pattern} est invalide.`);
		}
		if (pattern === "/") return [];
		const names = new Set<string>();
		return pattern
			.slice(1)
			.split("/")
			.map((rawSegment) => {
				let decoded: string;
				try {
					decoded = decodeURIComponent(rawSegment);
				} catch {
					invalid(`Le segment ${rawSegment} est invalide.`);
				}
				const parameter = routeParameterPattern.exec(decoded);
				if (!parameter) {
					if (decoded.includes("{") || decoded.includes("}")) {
						invalid("Un paramètre de route est mal formé.");
					}
					return { kind: "static" as const, value: decoded };
				}
				const [, name, typeIdentifier] = parameter;
				if (names.has(name!)) invalid(`Le paramètre ${name} est déclaré plusieurs fois.`);
				if (!this.parameterTypes.has(typeIdentifier!)) {
					invalid(`Le type ${typeIdentifier} est inconnu.`);
				}
				names.add(name!);
				return {
					kind: "parameter" as const,
					name: name!,
					typeIdentifier: typeIdentifier!,
				};
			});
	}

	private assertRouteAvailable(candidate: CompiledRoute, pageIdentifier: string): void {
		const patterns = [candidate.segments, ...candidate.aliases.map((alias) => alias.segments)];
		for (const existing of this.routes.values()) {
			if (existing.pageIdentifier === pageIdentifier || existing.surface !== candidate.surface) {
				continue;
			}
			const existingPatterns = [
				existing.segments,
				...existing.aliases.map((alias) => alias.segments),
			];
			for (const first of patterns) {
				for (const second of existingPatterns) {
					const firstStatic = first.filter((segment) => segment.kind === "static").length;
					const secondStatic = second.filter((segment) => segment.kind === "static").length;
					if (this.patternsOverlap(first, second) && firstStatic === secondStatic) {
						invalid(
							`La route ${candidate.definition.identifier} est ambiguë avec ${existing.definition.identifier}.`,
						);
					}
				}
			}
		}
	}

	private patternsOverlap(
		first: readonly RouteSegment[],
		second: readonly RouteSegment[],
	): boolean {
		if (first.length !== second.length) return false;
		return first.every((segment, index) => {
			const other = second[index]!;
			if (segment.kind === "static" && other.kind === "static") {
				return segment.value === other.value;
			}
			if (segment.kind === "static") {
				return (
					other.kind === "parameter" && this.matchesParameter(other.typeIdentifier, segment.value)
				);
			}
			if (other.kind === "static")
				return this.matchesParameter(segment.typeIdentifier, other.value);
			return parameterTypesOverlap(
				this.parameterTypes.get(segment.typeIdentifier)!,
				this.parameterTypes.get(other.typeIdentifier)!,
			);
		});
	}

	private resolveRoute(
		path: string,
		surface?: PageSurface,
	):
		| {
				readonly route: CompiledRoute;
				readonly parameters: Readonly<Record<string, string | number>>;
				readonly alias: boolean;
		  }
		| undefined {
		const normalized = normalizePath(path);
		const candidates: {
			readonly route: CompiledRoute;
			readonly parameters: Readonly<Record<string, string | number>>;
			readonly alias: boolean;
			readonly staticSegments: number;
		}[] = [];
		for (const route of this.routes.values()) {
			if (route.definition.active === false || (surface && route.surface !== surface)) continue;
			const patterns = [
				{ segments: route.segments, alias: false },
				...route.aliases.map((alias) => ({ segments: alias.segments, alias: true })),
			];
			for (const pattern of patterns) {
				const parameters = this.matchSegments(pattern.segments, normalized);
				if (parameters) {
					candidates.push({
						route,
						parameters,
						alias: pattern.alias,
						staticSegments: pattern.segments.filter((segment) => segment.kind === "static").length,
					});
				}
			}
		}
		candidates.sort(
			(left, right) =>
				right.staticSegments - left.staticSegments ||
				(right.route.definition.priority ?? 0) - (left.route.definition.priority ?? 0) ||
				left.route.definition.identifier.localeCompare(right.route.definition.identifier),
		);
		return candidates[0];
	}

	private matchSegments(
		pattern: readonly RouteSegment[],
		path: string,
	): Readonly<Record<string, string | number>> | undefined {
		const actual = path === "/" ? [] : path.slice(1).split("/").map(decodeURIComponent);
		if (pattern.length !== actual.length) return undefined;
		const parameters: Record<string, string | number> = {};
		for (const [index, segment] of pattern.entries()) {
			const value = actual[index]!;
			if (segment.kind === "static") {
				if (segment.value !== value) return undefined;
				continue;
			}
			if (!this.matchesParameter(segment.typeIdentifier, value)) return undefined;
			parameters[segment.name] =
				this.parameterTypes.get(segment.typeIdentifier)!.base === "integer" ? Number(value) : value;
		}
		return parameters;
	}

	private matchesParameter(typeIdentifier: string, value: string): boolean {
		const definition = this.parameterTypes.get(typeIdentifier);
		if (
			!definition ||
			!value ||
			(definition.maximumLength !== undefined && value.length > definition.maximumLength)
		) {
			return false;
		}
		if (definition.allowedValues && !definition.allowedValues.includes(value)) return false;
		switch (definition.base) {
			case "integer":
				return /^-?(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
			case "locale":
				return isLocale(value);
			case "slug":
				return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
			case "uuid":
				return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					value,
				);
			case "string":
				return !value.includes("/");
		}
	}

	private canonicalRoute(pageIdentifier: string, locale?: string): CompiledRoute | undefined {
		const candidates = [...this.routes.values()].filter(
			(route) => route.pageIdentifier === pageIdentifier && route.definition.active !== false,
		);
		return (
			candidates.find(
				(route) => route.definition.canonical && route.definition.locale === locale,
			) ??
			candidates.find((route) => route.definition.canonical && !route.definition.locale) ??
			candidates[0]
		);
	}

	private validateContext(context: PageContextDefinition): void {
		if (context.kind === "registered" && !this.contextTypes.has(context.contextTypeIdentifier)) {
			invalid(`Le contexte ${context.contextTypeIdentifier} n’est pas enregistré.`);
		}
		if (context.kind === "entity-collection" && !context.queryIdentifier) {
			invalid("Une collection d’entités exige une requête enregistrée.");
		}
	}

	private validateDocument(document: PageDocumentDefinition): void {
		if (document.breakpoints.length === 0) {
			invalid("Une page doit définir au moins un palier responsive.");
		}
		const breakpoints = new Map(document.breakpoints.map((item) => [item.identifier, item]));
		const regions = new Set(document.regions.map((item) => item.identifier));
		const containers = new Set(document.containers.map((item) => item.identifier));
		assertUnique(
			document.breakpoints.map((item) => item.identifier),
			"paliers responsive",
		);
		assertUnique(
			document.regions.map((item) => item.identifier),
			"régions",
		);
		assertUnique(
			document.containers.map((item) => item.identifier),
			"conteneurs",
		);
		assertUnique(
			document.components.map((item) => item.identifier),
			"composants de page",
		);
		for (const breakpoint of document.breakpoints) {
			validateIdentifier(breakpoint.identifier, "palier responsive");
			if (
				!Number.isSafeInteger(breakpoint.columns) ||
				breakpoint.columns < 1 ||
				breakpoint.columns > 24 ||
				breakpoint.minimumWidth < 0 ||
				breakpoint.rowHeight < 1 ||
				breakpoint.gap < 0
			) {
				invalid(`Le palier ${breakpoint.identifier} est invalide.`);
			}
			if (breakpoint.inherits && !breakpoints.has(breakpoint.inherits)) {
				invalid("Un palier hérite d’un palier inconnu.");
			}
		}
		for (const container of document.containers) {
			if (!regions.has(container.regionIdentifier)) {
				invalid(`La région ${container.regionIdentifier} est inconnue.`);
			}
			for (const placement of container.placements) {
				const breakpoint = breakpoints.get(placement.breakpoint);
				if (
					!breakpoint ||
					placement.column < 1 ||
					placement.row < 1 ||
					placement.columnSpan < (container.minimumColumnSpan ?? 1) ||
					placement.rowSpan < (container.minimumRowSpan ?? 1) ||
					placement.column + placement.columnSpan - 1 > breakpoint.columns
				) {
					invalid(`Le placement du conteneur ${container.identifier} est invalide.`);
				}
			}
		}
		for (const component of document.components) {
			const contract = this.componentContracts.get(component.componentIdentifier);
			if (!contract) {
				invalid(`Le composant ${component.componentIdentifier} n’est pas enregistré.`);
			}
			if (!containers.has(component.containerIdentifier)) {
				invalid("Le conteneur du composant est inconnu.");
			}
			if (
				contract.allowedProperties &&
				Object.keys(component.properties ?? {}).some(
					(key) => !contract.allowedProperties!.includes(key),
				)
			) {
				invalid(`Une propriété du composant ${component.identifier} n’est pas autorisée.`);
			}
			for (const source of Object.values(component.sources ?? {})) {
				if (
					(source.kind === "collection" || source.kind === "computed") &&
					!this.dataProviderContracts.has(source.providerIdentifier)
				) {
					invalid(`Le fournisseur ${source.providerIdentifier} n’est pas enregistré.`);
				}
			}
			for (const action of component.actionIdentifiers ?? []) {
				if (!this.actionContracts.has(action)) invalid(`L’action ${action} n’est pas enregistrée.`);
			}
		}
		for (const breakpoint of document.breakpoints) {
			this.assertNoGridCollision(document, breakpoint.identifier);
		}
	}

	private assertNoGridCollision(document: PageDocumentDefinition, breakpoint: string): void {
		const occupied = new Map<string, string>();
		for (const container of document.containers) {
			const placement = effectivePlacement(container, breakpoint, document.breakpoints);
			if (!placement) continue;
			for (let row = placement.row; row < placement.row + placement.rowSpan; row += 1) {
				for (
					let column = placement.column;
					column < placement.column + placement.columnSpan;
					column += 1
				) {
					const key = `${column}:${row}`;
					const existing = occupied.get(key);
					if (existing && existing !== container.identifier) {
						invalid(
							`Les conteneurs ${existing} et ${container.identifier} se chevauchent au palier ${breakpoint}.`,
						);
					}
					occupied.set(key, container.identifier);
				}
			}
		}
	}

	private validateCanonicalAssignment(definition: PageDefinition): void {
		if (!definition.canonicalFor) return;
		const collision = [...this.pages.values()].find(
			(page) =>
				page.identifier !== definition.identifier &&
				page.surface === definition.surface &&
				page.canonicalFor?.entityTypeIdentifier === definition.canonicalFor!.entityTypeIdentifier &&
				page.canonicalFor.usage === definition.canonicalFor!.usage,
		);
		if (collision) {
			invalid(`La page canonique ${collision.identifier} utilise déjà cette affectation.`);
		}
	}

	private requirePage(identifier: string): PageDefinition {
		const page = this.pages.get(identifier);
		if (!page) invalid(`La page ${identifier} est inconnue.`);
		return page;
	}

	private currentRevision(pageIdentifier: string): PageRevision | undefined {
		const revision = this.publishedRevisions.get(pageIdentifier);
		return revision === undefined
			? undefined
			: this.revisions.get(pageIdentifier)?.find((item) => item.revision === revision);
	}

	private newRevision(
		pageIdentifier: string,
		document: PageDocumentDefinition,
		state: PageRevisionState,
		authorId?: string,
	): PageRevision {
		const history = this.revisions.get(pageIdentifier) ?? [];
		return Object.freeze({
			pageIdentifier,
			revision: (history.at(-1)?.revision ?? 0) + 1,
			state,
			document: structuredClone(document),
			...(authorId ? { authorId } : {}),
			createdAt: this.now(),
		});
	}

	private transitionRevision(
		pageIdentifier: string,
		revisionNumber: number,
		from: PageRevisionState,
		to: PageRevisionState,
		extra: Partial<PageRevision>,
	): PageRevision {
		const history = this.revisions.get(pageIdentifier) ?? [];
		const index = history.findIndex((revision) => revision.revision === revisionNumber);
		const current = history[index];
		if (!current || current.state !== from) {
			invalid(`La révision doit être dans l’état ${from}.`);
		}
		const updated = Object.freeze({ ...current, ...extra, state: to });
		history[index] = updated;
		return updated;
	}
}

const builtInParameterTypes: readonly RouteParameterTypeDefinition[] = [
	{ identifier: "integer", contributionKey: "core.pages", base: "integer" },
	{ identifier: "locale", contributionKey: "core.pages", base: "locale", maximumLength: 35 },
	{ identifier: "slug", contributionKey: "core.pages", base: "slug", maximumLength: 160 },
	{ identifier: "string", contributionKey: "core.pages", base: "string", maximumLength: 255 },
	{ identifier: "uuid", contributionKey: "core.pages", base: "uuid", maximumLength: 36 },
];

function normalizePath(path: string): string {
	let pathname: string;
	try {
		pathname = new URL(path, "https://cms.invalid").pathname;
	} catch {
		invalid("Le chemin de page est invalide.");
	}
	if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
	return pathname;
}

function parameterTypesOverlap(
	first: RouteParameterTypeDefinition,
	second: RouteParameterTypeDefinition,
): boolean {
	if (first.allowedValues && second.allowedValues) {
		return first.allowedValues.some((value) => second.allowedValues!.includes(value));
	}
	if (first.base === second.base) return true;
	if (first.base === "string" || second.base === "string") return true;
	return (
		(first.base === "slug" && second.base === "locale") ||
		(first.base === "locale" && second.base === "slug")
	);
}

function effectivePlacement(
	container: PageContainerDefinition,
	breakpoint: string,
	breakpoints: readonly PageGridBreakpointDefinition[],
): PageContainerPlacement | undefined {
	let current: string | undefined = breakpoint;
	const visited = new Set<string>();
	while (current && !visited.has(current)) {
		visited.add(current);
		const direct = container.placements.find((placement) => placement.breakpoint === current);
		if (direct) return direct;
		current = breakpoints.find((candidate) => candidate.identifier === current)?.inherits;
	}
	return undefined;
}

function assertUnique(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length) {
		invalid(`La liste des ${label} contient un doublon.`);
	}
}

function isLocale(value: string): boolean {
	try {
		return Intl.getCanonicalLocales(value).length === 1;
	} catch {
		return false;
	}
}

function validateIdentifier(identifier: string, label: string): void {
	if (!identifierPattern.test(identifier)) {
		invalid(`L’identifiant de ${label} ${identifier} est invalide.`);
	}
}

function invalid(message: string): never {
	throw new CoreError("configuration.invalid", message);
}
