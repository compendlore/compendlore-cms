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
	ModuleOutlet,
	Notice,
	PageHeader,
	SelectField,
	Switch,
	Table,
	Tabs,
	navigationFromCatalog,
	useNativeCatalog,
	type CatalogNavigationLink,
	type FrontendModuleProps,
	type NativeCatalogDocument,
} from "@compendlore/ui";

const registry = new FrontendModuleRegistry();
registry.register({
	identifier: "core.admin.dashboard",
	kind: "page",
	requiredCapability: "core.administration.access",
	component: DashboardPage,
});
registry.register({
	identifier: "core.admin.modules",
	kind: "page",
	requiredCapability: "core.administration.access",
	component: ModulesPage,
});
registry.register({
	identifier: "core.admin.interface",
	kind: "page",
	requiredCapability: "core.administration.access",
	component: InterfacePage,
});
const capabilities = new Set<string>(["core.administration.access"]);

export function App() {
	const catalogState = useNativeCatalog("administration");
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
	const page = catalogState.catalog.pages.find((candidate) => candidate.route === path);
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
			<ModuleOutlet
				contribution={page ? registry.resolve(page.identifier, capabilities) : undefined}
				context={{ capabilities, locale: catalogState.catalog.locale }}
				state={catalogState.catalog}
				fallback={
					<Notice tone="danger" title="Page administrative indisponible">
						Cette route n’est pas enregistrée ou votre session ne possède plus la capacité requise.
					</Notice>
				}
			/>
		</ApplicationShell>
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
	const catalog = state as NativeCatalogDocument | undefined;
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
