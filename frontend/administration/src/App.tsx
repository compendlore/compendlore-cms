import { useEffect, useState } from "react";
import {
	ApplicationShell,
	Button,
	Card,
	DateTimePicker,
	Field,
	FrontendModuleRegistry,
	Icon,
	MainNavigationRegistry,
	Modal,
	ModuleOutlet,
	NavigationResolver,
	Notice,
	PageHeader,
	SelectField,
	SidebarElementRegistry,
	SidebarRegistry,
	Switch,
	Table,
	Tabs,
	type FrontendModuleProps,
} from "@compendlore/ui";

const registry = new FrontendModuleRegistry();
registry.register({
	identifier: "core.admin.dashboard",
	kind: "route",
	path: "/admin",
	requiredCapability: "core.administration.access",
	component: DashboardPage,
});
registry.register({
	identifier: "core.admin.modules",
	kind: "route",
	path: "/admin/modules",
	requiredCapability: "core.administration.access",
	component: ModulesPage,
});
registry.register({
	identifier: "core.admin.interface",
	kind: "route",
	path: "/admin/interface",
	requiredCapability: "core.administration.access",
	component: InterfacePage,
});
const capabilities = new Set<string>(["core.administration.access"]);
const administrationSidebars = new SidebarRegistry();
const administrationSidebarElements = new SidebarElementRegistry();
const administrationNavigation = new NavigationResolver(
	new MainNavigationRegistry(),
	administrationSidebars,
	administrationSidebarElements,
);

administrationSidebars.register({
	identifier: "core.administration",
	eyebrow: "Explorer",
	title: "Administration",
	subtitle: "Accès protégé par rôle et second facteur",
	icon: "administration",
	requiredCapability: "core.administration.access",
});
administrationSidebarElements.register("core.administration", {
	identifier: "core.administration.dashboard",
	kind: "link",
	label: "Pilotage",
	href: "/admin",
	icon: "administration",
	description: "État du CMS",
	order: 10,
});
administrationSidebarElements.register("core.administration", {
	identifier: "core.administration.modules",
	kind: "link",
	label: "Modules",
	href: "/admin/modules",
	icon: "menu",
	description: "Contributions enregistrées",
	order: 20,
});
administrationSidebarElements.register("core.administration", {
	identifier: "core.administration.interface",
	kind: "link",
	label: "Interface",
	href: "/admin/interface",
	icon: "settings",
	description: "Composants du CMS",
	order: 30,
});

export function App() {
	const [path, setPath] = useState(() =>
		window.location.pathname === "/admin/" ? "/admin" : window.location.pathname,
	);
	useEffect(() => {
		const update = () => setPath(window.location.pathname);
		window.addEventListener("popstate", update);
		return () => window.removeEventListener("popstate", update);
	}, []);
	const navigate = (href: string) => {
		window.history.pushState(null, "", href);
		setPath(href);
	};
	const sidebar = administrationNavigation.resolveSidebar(
		"core.administration",
		path,
		capabilities,
	);
	return (
		<ApplicationShell
			administration
			sidebar={sidebar}
			onNavigate={navigate}
			actions={
				<>
					<a className="button" href="/">
						<span>Voir le site</span>
					</a>
					<Button tone="danger" aria-label="Se déconnecter">
						<Icon name="logout" />
					</Button>
				</>
			}
		>
			<ModuleOutlet
				contribution={registry.resolveRoute(path, capabilities)}
				context={{ capabilities, locale: navigator.language || "fr-FR" }}
				fallback={
					<Notice tone="danger" title="Page administrative indisponible">
						Cette route n’est pas enregistrée ou votre session ne possède plus la capacité requise.
					</Notice>
				}
			/>
		</ApplicationShell>
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

function ModulesPage(_props: FrontendModuleProps) {
	return (
		<>
			<PageHeader
				eyebrow="Administration · Registre"
				title="Modules frontend"
				description="Prévisualisation de l’hôte qui recevra les contributions métier à la phase suivante."
			/>
			<Notice tone="information" title="Fondation prête">
				Les contrats sont actifs. Le catalogue métier sera raccordé pendant le premier parcours
				vertical.
			</Notice>
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
