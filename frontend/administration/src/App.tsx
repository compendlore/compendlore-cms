import { useEffect, useState } from "react";
import {
	ApplicationShell,
	Button,
	Card,
	DateTimePicker,
	Field,
	FrontendModuleRegistry,
	Icon,
	Modal,
	Notice,
	PageHost,
	PageHeader,
	SelectField,
	Switch,
	Table,
	Tabs,
	navigationFromCatalog,
	resolveCatalogPage,
	useNativeCatalog,
	type CatalogNavigationLink,
	type FrontendModuleProps,
	type NativeCatalogDocument,
} from "@compendlore/ui";

const registry = new FrontendModuleRegistry();
registry.register({
	identifier: "core.admin.dashboard",
	kind: "component",
	requiredCapability: "core.administration.access",
	component: DashboardPage,
});
registry.register({
	identifier: "core.admin.modules",
	kind: "component",
	requiredCapability: "core.administration.access",
	component: ModulesPage,
});
registry.register({
	identifier: "core.admin.interface",
	kind: "component",
	requiredCapability: "core.administration.access",
	component: InterfacePage,
});
registry.register({
	identifier: "core.admin.pages",
	kind: "component",
	requiredCapability: "core.administration.access",
	component: PageManagementPage,
});
registry.register({
	identifier: "core.system.unavailable",
	kind: "component",
	component: UnavailablePage,
});
const capabilities = new Set<string>(["core.administration.access"]);
const apiOrigin = import.meta.env.VITE_API_ORIGIN ?? "http://localhost:4000";

export function App() {
	const catalogState = useNativeCatalog("administration", apiOrigin);
	const [path, setPath] = useState(() =>
		window.location.pathname === "/admin/" ? "/admin" : window.location.pathname,
	);
	useEffect(() => {
		const update = () => setPath(window.location.pathname);
		window.addEventListener("popstate", update);
		return () => window.removeEventListener("popstate", update);
	}, []);
	const navigate = (href: string) => {
		if (!/^\/admin(?:\/|$)/.test(href)) {
			window.location.assign(href);
			return;
		}
		window.history.pushState(null, "", href);
		setPath(href);
	};
	const matchedPage =
		catalogState.status === "ready"
			? resolveCatalogPage(
					catalogState.catalog.pages,
					path,
					catalogState.catalog.routeParameterTypes,
				)
			: undefined;
	useEffect(() => {
		if (matchedPage?.alias && matchedPage.canonicalPath !== path) {
			window.history.replaceState(null, "", matchedPage.canonicalPath);
			setPath(matchedPage.canonicalPath);
		}
	}, [matchedPage?.alias, matchedPage?.canonicalPath, path]);
	if (catalogState.status !== "ready") {
		return (
			<ApplicationShell administration>
				<Notice
					tone={catalogState.status === "loading" ? "information" : "danger"}
					title={
						catalogState.status === "loading"
							? "Chargement de l’administration"
							: "Catalogue administratif indisponible"
					}
				>
					{catalogState.status === "loading"
						? "Les contributions autorisées sont en cours de résolution."
						: "Votre session n’est plus autorisée ou le Core est indisponible."}
				</Notice>
			</ApplicationShell>
		);
	}
	const navigation = navigationFromCatalog(catalogState.catalog, path);
	const fallbackPage = catalogState.catalog.pages.find(
		(candidate) => candidate.identifier === "core.system.unavailable",
	);
	const page = matchedPage?.page ?? fallbackPage;
	return (
		<ApplicationShell
			administration
			brand={navigation.brand}
			primaryNavigation={navigation.primary}
			sidebar={navigation.sidebar}
			onNavigate={navigate}
			actions={
				<>
					{navigation.actions.map((action) => (
						<CatalogAction key={action.identifier} action={action} />
					))}
				</>
			}
		>
			{page ? (
				<PageHost
					page={page}
					registry={registry}
					context={{ capabilities, locale: catalogState.catalog.locale }}
					state={{ catalog: catalogState.catalog, route: matchedPage }}
				/>
			) : null}
		</ApplicationShell>
	);
}

function UnavailablePage(_props: FrontendModuleProps) {
	return (
		<Notice tone="danger" title="Page administrative indisponible">
			Cette route n’est pas enregistrée, la contribution correspondante est indisponible ou votre
			session ne possède plus la capacité requise.
		</Notice>
	);
}

function CatalogAction({ action }: { readonly action: CatalogNavigationLink }) {
	const icon = action.iconIdentifier as "account" | "administration" | "logout" | undefined;
	if (action.mode === "route") {
		return (
			<a className="button button--secondary" href={action.target} title={action.tooltip}>
				{icon ? <Icon name={icon} /> : null}
				<span>{action.title}</span>
			</a>
		);
	}
	return (
		<Button data-action={action.target} title={action.tooltip} tone="danger">
			{icon ? <Icon name={icon} /> : null}
			<span>{action.title}</span>
		</Button>
	);
}

function DashboardPage(_props: FrontendModuleProps) {
	return (
		<>
			<PageHeader
				eyebrow="Administration · Pilotage"
				title="Tableau de bord"
				description="Le bundle administratif est construit et livré indépendamment du site public."
			/>
			<section className="content-grid">
				<Card
					eyebrow="Sécurité"
					title="Accès vérifié"
					description="La livraison nécessite un profil administrateur et une validation 2FA active."
				/>
				<Card
					eyebrow="Registre"
					title="Contributions"
					description="Les pages administratives seront résolues depuis le CMS Registry."
				/>
				<Card
					eyebrow="Build"
					title="Bundle isolé"
					description="Les sources maps de production sont désactivées et le manifeste est distinct."
				/>
			</section>
		</>
	);
}

function ModulesPage({ state }: FrontendModuleProps) {
	const catalog = (
		state as { readonly page?: { readonly catalog?: NativeCatalogDocument } } | undefined
	)?.page?.catalog;
	const contributions = catalog?.contributions ?? [];
	return (
		<>
			<PageHeader
				eyebrow="Administration · Registre"
				title="Contributions natives"
				description="Inspectez la provenance, la version, l’état et les éléments matérialisés par le CMS Registry."
			/>
			<Table
				caption="Contributions actives, désactivées ou retirées"
				columns={[
					{ key: "key", title: "Contribution", render: (row) => row.contributionKey },
					{
						key: "owner",
						title: "Propriétaire",
						render: (row) => `${row.owner.kind} · ${row.owner.identifier}`,
					},
					{ key: "version", title: "Version", render: (row) => row.version },
					{ key: "state", title: "État", render: (row) => row.state },
					{
						key: "content",
						title: "Éléments",
						render: (row) => Object.values(row.counts).reduce((total, count) => total + count, 0),
					},
					{
						key: "lock",
						title: "Protection",
						render: (row) => (row.locked ? "Verrouillée" : "Gérée"),
					},
				]}
				rows={contributions}
				rowKey={(row) => row.contributionKey}
				emptyLabel="Aucune contribution visible pour cette session."
			/>
		</>
	);
}

function InterfacePage(_props: FrontendModuleProps) {
	const [enabled, setEnabled] = useState(true);
	const [activeTab, setActiveTab] = useState("controls");
	const [modalOpen, setModalOpen] = useState(false);
	const [scheduledAt, setScheduledAt] = useState("");
	return (
		<>
			<PageHeader
				eyebrow="Administration · Interface"
				title="Fondation visuelle"
				description="Contrôlez les composants communs et leurs interactions avant leur utilisation par les parcours métier."
			/>
			<Tabs
				activeId={activeTab}
				onChange={setActiveTab}
				tabs={[
					{
						id: "controls",
						label: "Contrôles",
						content: (
							<section className="content-grid">
								<Card title="Champs et actions" eyebrow="Formulaire">
									<Field label="Nom du site" defaultValue="Compendlore CMS" />
									<SelectField
										label="Langue"
										options={[
											{ value: "fr-FR", label: "Français" },
											{ value: "en-GB", label: "English" },
										]}
									/>
									<Switch checked={enabled} label="Fonction active" onChange={setEnabled} />
									<Button tone="primary" onClick={() => setModalOpen(true)}>
										Ouvrir la fenêtre
									</Button>
								</Card>
								<Card title="Planification" eyebrow="Date et heure">
									<DateTimePicker locale="fr-FR" value={scheduledAt} onChange={setScheduledAt} />
								</Card>
							</section>
						),
					},
					{
						id: "data",
						label: "Données",
						content: (
							<Table
								caption="Exemple de tableau responsive"
								columns={[
									{ key: "name", title: "Nom", render: (row) => row.name },
									{ key: "type", title: "Type", render: (row) => row.type },
									{ key: "status", title: "État", render: (row) => row.status },
								]}
								rows={[
									{ id: "site", name: "Site public", type: "Bundle", status: "Prêt" },
									{
										id: "administration",
										name: "Administration",
										type: "Bundle protégé",
										status: "Prêt",
									},
								]}
								rowKey={(row) => row.id}
							/>
						),
					},
				]}
			/>
			<Modal
				open={modalOpen}
				eyebrow="Composant"
				title="Fenêtre de confirmation"
				onClose={() => setModalOpen(false)}
				actions={
					<Button tone="primary" onClick={() => setModalOpen(false)}>
						Confirmer
					</Button>
				}
			>
				Cette fenêtre vérifie le contraste, l’alignement et la fermeture par l’arrière-plan.
			</Modal>
		</>
	);
}

function PageManagementPage({ state }: FrontendModuleProps) {
	const catalog = (
		state as { readonly page?: { readonly catalog?: NativeCatalogDocument } } | undefined
	)?.page?.catalog;
	const pages = (catalog?.pages ?? []).filter((page) => page.surface !== "system");
	const [selectedIdentifier, setSelectedIdentifier] = useState(() => pages[0]?.identifier ?? "");
	const selected = pages.find((page) => page.identifier === selectedIdentifier) ?? pages[0];
	const [breakpoint, setBreakpoint] = useState(
		() => selected?.document.breakpoints[0]?.identifier ?? "",
	);
	const [placement, setPlacement] = useState({ column: 1, row: 1, columnSpan: 1, rowSpan: 1 });
	useEffect(() => {
		const firstBreakpoint = selected?.document.breakpoints[0]?.identifier ?? "";
		const firstPlacement = selected?.document.containers[0]?.placements.find(
			(candidate) => candidate.breakpoint === firstBreakpoint,
		);
		setBreakpoint(firstBreakpoint);
		setPlacement(
			firstPlacement
				? {
						column: firstPlacement.column,
						row: firstPlacement.row,
						columnSpan: firstPlacement.columnSpan,
						rowSpan: firstPlacement.rowSpan,
					}
				: { column: 1, row: 1, columnSpan: 1, rowSpan: 1 },
		);
	}, [selected?.identifier]);
	const move = (column: number, row: number) =>
		setPlacement((current) => ({
			...current,
			column: Math.max(1, current.column + column),
			row: Math.max(1, current.row + row),
		}));
	const resize = (columnSpan: number, rowSpan: number) => {
		const maximumColumns =
			selected?.document.breakpoints.find((candidate) => candidate.identifier === breakpoint)
				?.columns ?? 1;
		setPlacement((current) => ({
			...current,
			columnSpan: Math.min(
				maximumColumns - current.column + 1,
				Math.max(1, current.columnSpan + columnSpan),
			),
			rowSpan: Math.max(1, current.rowSpan + rowSpan),
		}));
	};
	return (
		<>
			<PageHeader
				eyebrow="Administration · Composition"
				title="Moteur de pages"
				description="Inspectez les routes, les versions publiées et les dispositions responsive issues du Registry."
			/>
			<section className="content-grid">
				<Card title="Catalogue" eyebrow="Pages enregistrées">
					<SelectField
						label="Page"
						options={pages.map((page) => ({ value: page.identifier, label: page.title }))}
						value={selected?.identifier ?? ""}
						onChange={(event) => setSelectedIdentifier(event.target.value)}
					/>
					{selected ? (
						<dl className="definition-list">
							<div>
								<dt>Provenance</dt>
								<dd>{selected.contributionKey}</dd>
							</div>
							<div>
								<dt>Révision publiée</dt>
								<dd>{selected.revision}</dd>
							</div>
							<div>
								<dt>Routes</dt>
								<dd>{selected.routes.map((route) => route.pattern).join(", ")}</dd>
							</div>
						</dl>
					) : null}
				</Card>
				<Card title="Prévisualisation responsive" eyebrow="Grille">
					<SelectField
						label="Palier"
						options={(selected?.document.breakpoints ?? []).map((item) => ({
							value: item.identifier,
							label: `${item.identifier} · ${item.columns} colonnes`,
						}))}
						value={breakpoint}
						onChange={(event) => setBreakpoint(event.target.value)}
					/>
					<div
						className="page-layout-preview"
						tabIndex={0}
						onKeyDown={(event) => {
							if (event.shiftKey && event.key === "ArrowLeft") resize(-1, 0);
							else if (event.shiftKey && event.key === "ArrowRight") resize(1, 0);
							else if (event.shiftKey && event.key === "ArrowUp") resize(0, -1);
							else if (event.shiftKey && event.key === "ArrowDown") resize(0, 1);
							else if (event.key === "ArrowLeft") move(-1, 0);
							else if (event.key === "ArrowRight") move(1, 0);
							else if (event.key === "ArrowUp") move(0, -1);
							else if (event.key === "ArrowDown") move(0, 1);
						}}
						aria-label="Conteneur sélectionné. Utilisez les flèches pour le déplacer et Maj avec les flèches pour le redimensionner."
					>
						<strong>{selected?.document.containers[0]?.identifier ?? "Aucun conteneur"}</strong>
						<span>
							Colonne {placement.column}, ligne {placement.row}, largeur {placement.columnSpan},
							hauteur {placement.rowSpan}
						</span>
					</div>
					<div className="button-row" aria-label="Déplacement accessible du conteneur">
						<Button onClick={() => move(-1, 0)}>Gauche</Button>
						<Button onClick={() => move(1, 0)}>Droite</Button>
						<Button onClick={() => move(0, -1)}>Haut</Button>
						<Button onClick={() => move(0, 1)}>Bas</Button>
					</div>
					<div className="button-row" aria-label="Redimensionnement accessible du conteneur">
						<Button onClick={() => resize(-1, 0)}>Rétrécir</Button>
						<Button onClick={() => resize(1, 0)}>Élargir</Button>
						<Button onClick={() => resize(0, -1)}>Réduire</Button>
						<Button onClick={() => resize(0, 1)}>Agrandir</Button>
					</div>
					<Notice tone="information" title="Prévisualisation sans publication">
						Les déplacements de cet inspecteur sont locaux. La publication atomique est assurée par
						le cycle de révisions du Core.
					</Notice>
				</Card>
			</section>
		</>
	);
}
