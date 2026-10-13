import { useEffect, useState, type CSSProperties } from "react";
import { FrontendModuleRegistry, ModuleOutlet, type FrontendModuleContext } from "./module-host.js";
import { Notice } from "./primitives.js";

export interface CatalogPageRoute {
	readonly identifier: string;
	readonly pattern: string;
	readonly aliases?: readonly string[];
	readonly canonical?: boolean;
	readonly active?: boolean;
	readonly priority?: number;
}

export interface CatalogPageDocument {
	readonly breakpoints: readonly {
		readonly identifier: string;
		readonly minimumWidth: number;
		readonly columns: number;
		readonly rowHeight: number;
		readonly gap: number;
		readonly inherits?: string;
	}[];
	readonly regions: readonly { readonly identifier: string; readonly order: number }[];
	readonly containers: readonly {
		readonly identifier: string;
		readonly regionIdentifier: string;
		readonly placements: readonly {
			readonly breakpoint: string;
			readonly column: number;
			readonly row: number;
			readonly columnSpan: number;
			readonly rowSpan: number;
		}[];
	}[];
	readonly components: readonly {
		readonly identifier: string;
		readonly componentIdentifier: string;
		readonly containerIdentifier: string;
		readonly order: number;
		readonly properties?: Readonly<Record<string, unknown>>;
		readonly sources?: Readonly<Record<string, unknown>>;
		readonly actionIdentifiers?: readonly string[];
	}[];
}

export interface CatalogPage {
	readonly identifier: string;
	readonly surface: "account" | "administration" | "site" | "system";
	readonly routes: readonly CatalogPageRoute[];
	readonly title: string;
	readonly description?: string;
	readonly contributionKey: string;
	readonly editable: boolean;
	readonly removable: boolean;
	readonly context: Readonly<Record<string, unknown>> & { readonly kind: string };
	readonly revision: number;
	readonly document: CatalogPageDocument;
}

export interface MatchedCatalogPage {
	readonly page: CatalogPage;
	readonly route: CatalogPageRoute;
	readonly parameters: Readonly<Record<string, string | number>>;
	readonly canonicalPath: string;
	readonly alias: boolean;
}

export function resolveCatalogPage(
	pages: readonly CatalogPage[],
	path: string,
	parameterTypes: readonly CatalogRouteParameterType[] = builtInRouteParameterTypes,
): MatchedCatalogPage | undefined {
	const normalized = normalizePath(path);
	const matches: (MatchedCatalogPage & { readonly staticSegments: number })[] = [];
	for (const page of pages) {
		for (const route of page.routes) {
			if (route.active === false) continue;
			for (const candidate of [
				{ pattern: route.pattern, alias: false },
				...(route.aliases ?? []).map((pattern) => ({ pattern, alias: true })),
			]) {
				const parameters = matchPattern(candidate.pattern, normalized, parameterTypes);
				if (!parameters) continue;
				const canonical = page.routes.find((item) => item.canonical) ?? route;
				matches.push({
					page,
					route,
					parameters,
					canonicalPath: buildPattern(canonical.pattern, parameters),
					alias: candidate.alias,
					staticSegments: candidate.pattern
						.split("/")
						.filter((segment) => segment && !segment.startsWith("{")).length,
				});
			}
		}
	}
	matches.sort(
		(left, right) =>
			right.staticSegments - left.staticSegments ||
			(right.route.priority ?? 0) - (left.route.priority ?? 0) ||
			left.route.identifier.localeCompare(right.route.identifier),
	);
	return matches[0];
}

export function PageHost({
	page,
	registry,
	context,
	state,
}: {
	readonly page: CatalogPage;
	readonly registry: FrontendModuleRegistry;
	readonly context: FrontendModuleContext;
	readonly state?: unknown;
}) {
	const width = useViewportWidth();
	const breakpoint = [...page.document.breakpoints]
		.filter((candidate) => candidate.minimumWidth <= width)
		.sort((left, right) => right.minimumWidth - left.minimumWidth)[0];
	if (!breakpoint) {
		return (
			<Notice tone="danger" title="Disposition indisponible">
				Cette page ne possède aucune disposition compatible avec cet écran.
			</Notice>
		);
	}
	const regions = [...page.document.regions].sort((left, right) => left.order - right.order);
	return (
		<div
			className="page-engine"
			data-page={page.identifier}
			data-page-revision={page.revision}
			data-page-breakpoint={breakpoint.identifier}
		>
			{regions.map((region) => (
				<section
					className="page-engine__region"
					data-page-region={region.identifier}
					key={region.identifier}
				>
					{page.document.containers
						.filter((container) => container.regionIdentifier === region.identifier)
						.map((container) => {
							const placement = resolvePlacement(
								container.placements,
								breakpoint.identifier,
								page.document.breakpoints,
							);
							if (!placement) return null;
							const style = {
								"--page-grid-columns": breakpoint.columns,
								"--page-grid-row-height": `${breakpoint.rowHeight}px`,
								"--page-grid-gap": `${breakpoint.gap}px`,
								"--page-grid-column": placement.column,
								"--page-grid-row": placement.row,
								"--page-grid-column-span": placement.columnSpan,
								"--page-grid-row-span": placement.rowSpan,
							} as CSSProperties;
							return (
								<div
									className="page-engine__container"
									data-page-container={container.identifier}
									key={container.identifier}
									style={style}
								>
									{page.document.components
										.filter((component) => component.containerIdentifier === container.identifier)
										.sort((left, right) => left.order - right.order)
										.map((component) => (
											<ModuleOutlet
												context={context}
												contribution={registry.resolve(
													component.componentIdentifier,
													context.capabilities,
												)}
												key={component.identifier}
												state={{ page: state, component }}
												fallback={
													<Notice tone="warning" title="Composant indisponible">
														Le composant {component.componentIdentifier} n’est pas disponible dans
														ce bundle.
													</Notice>
												}
											/>
										))}
								</div>
							);
						})}
				</section>
			))}
		</div>
	);
}

function useViewportWidth(): number {
	const [width, setWidth] = useState(() => window.innerWidth);
	useEffect(() => {
		const update = () => setWidth(window.innerWidth);
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, []);
	return width;
}

function resolvePlacement(
	placements: CatalogPageDocument["containers"][number]["placements"],
	breakpoint: string,
	breakpoints: CatalogPageDocument["breakpoints"],
) {
	let current: string | undefined = breakpoint;
	const visited = new Set<string>();
	while (current && !visited.has(current)) {
		visited.add(current);
		const placement = placements.find((candidate) => candidate.breakpoint === current);
		if (placement) return placement;
		current = breakpoints.find((candidate) => candidate.identifier === current)?.inherits;
	}
	return undefined;
}

function matchPattern(
	pattern: string,
	path: string,
	parameterTypes: readonly CatalogRouteParameterType[],
): Readonly<Record<string, string | number>> | undefined {
	const expected = splitPath(pattern);
	const actual = splitPath(path);
	if (expected.length !== actual.length) return undefined;
	const output: Record<string, string | number> = {};
	for (const [index, segment] of expected.entries()) {
		const value = actual[index]!;
		const parameter = /^\{([a-z][a-z0-9_-]*):([a-z][a-z0-9._-]*)\}$/.exec(segment);
		if (!parameter) {
			if (segment !== value) return undefined;
			continue;
		}
		const [, name, type] = parameter;
		const definition = parameterTypes.find((candidate) => candidate.identifier === type);
		if (!definition || !matchesType(definition, value)) return undefined;
		output[name!] = definition.base === "integer" ? Number(value) : value;
	}
	return output;
}

export interface CatalogRouteParameterType {
	readonly identifier: string;
	readonly base: "integer" | "locale" | "slug" | "string" | "uuid";
	readonly maximumLength?: number;
	readonly allowedValues?: readonly string[];
}

const builtInRouteParameterTypes: readonly CatalogRouteParameterType[] = [
	{ identifier: "integer", base: "integer" },
	{ identifier: "locale", base: "locale", maximumLength: 35 },
	{ identifier: "slug", base: "slug", maximumLength: 160 },
	{ identifier: "string", base: "string", maximumLength: 255 },
	{ identifier: "uuid", base: "uuid", maximumLength: 36 },
];

function matchesType(type: CatalogRouteParameterType, value: string): boolean {
	if (type.maximumLength !== undefined && value.length > type.maximumLength) return false;
	if (type.allowedValues && !type.allowedValues.includes(value)) return false;
	if (type.base === "integer")
		return /^-?(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
	if (type.base === "slug") return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
	if (type.base === "uuid")
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
	if (type.base === "locale") {
		try {
			return Intl.getCanonicalLocales(value).length === 1;
		} catch {
			return false;
		}
	}
	return Boolean(value) && !value.includes("/");
}

function buildPattern(
	pattern: string,
	parameters: Readonly<Record<string, string | number>>,
): string {
	return `/${splitPath(pattern)
		.map((segment) => {
			const parameter = /^\{([a-z][a-z0-9_-]*):[^}]+\}$/.exec(segment);
			return parameter ? encodeURIComponent(String(parameters[parameter[1]!] ?? "")) : segment;
		})
		.join("/")}`;
}

function splitPath(path: string): readonly string[] {
	return path === "/" ? [] : normalizePath(path).slice(1).split("/").map(decodeURIComponent);
}

function normalizePath(path: string): string {
	let value = new URL(path, window.location.origin).pathname;
	if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
	return value;
}
