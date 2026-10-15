import { useEffect, useState } from "react";
import {
	ApplicationShell,
	Button,
	Card,
	DateTimePicker,
	Field,
	FrontendModuleRegistry,
	List,
	ListItem,
	Modal,
	ModuleOutlet,
	usePageProjection,
	useNavigationProjection,
	Notice,
	PageHeader,
	SelectField,
	type FrontendModuleProps,
	type FrontendSessionContext,
	type NavigationItem,
	type NavigationProjectionView,
	type PageProjectionView,
	type RichBrandView,
	type SidebarView,
	Switch,
	Table,
	Tabs,
} from "@compendlore/ui";
import { siteMessage } from "./messages.js";

const registry = new FrontendModuleRegistry();
registry.register({ identifier: "core.page", kind: "page", component: DynamicPage });
const publicSession: FrontendSessionContext = Object.freeze({
	status: "anonymous",
	roles: Object.freeze([]),
	capabilities: new Set<string>(["core.site.view"]),
});
const capabilities = publicSession.capabilities;
const developmentSiteNavigation = Object.freeze({
	brand: Object.freeze({ label: "Compendlore CMS", href: "/" }),
	primary: Object.freeze([]),
	actions: Object.freeze([
		{ id: "core.profile", label: "Compte utilisateur", icon: "account", command: "core.profile" },
		{
			id: "core.administration",
			label: "Administration",
			icon: "administration",
			href: "/admin",
		},
	]),
} satisfies NavigationProjectionView);
const developmentThemeBrand: RichBrandView = Object.freeze({
	accessibleLabel: "Donjon & Dragon",
	segments: Object.freeze([
		{ identifier: "name-start", text: "Donjon ", styleSlot: "brand.primary" },
		{ identifier: "ampersand", text: "&", styleSlot: "brand.accent" },
		{ identifier: "name-end", text: " Dragon", styleSlot: "brand.primary" },
	]),
});
const developmentHomePage = Object.freeze({
	identifier: "core.home",
	component: "core.page",
	title: "Compendlore CMS",
	content: Object.freeze([
		{
			kind: "header" as const,
			eyebrow: "Portail public",
			title: "Compendlore CMS",
			description: "Une fondation modulaire pour publier et explorer des univers de jeu de rôle.",
		},
		{
			kind: "card" as const,
			eyebrow: "Navigation",
			title: "Contenus enregistrés",
			description:
				"Les pages, menus et interfaces apparaîtront ici lorsqu’un module autorisé les enregistrera.",
		},
		{
			kind: "card" as const,
			eyebrow: "Session",
			title: "Accès utilisateur",
			description:
				"La navigation adapte les modules visibles aux capacités de la session, sans exposer les outils administratifs.",
		},
		{
			kind: "card" as const,
			eyebrow: "Résilience",
			title: "Interface disponible",
			description:
				"Une contribution indisponible est isolée afin que le reste du site continue de fonctionner.",
		},
	]),
	revision: 1,
	fingerprint: "0".repeat(64),
});
const developmentCompactNavigation: readonly NavigationItem[] = Object.freeze([
	{
		id: "development.overview",
		label: "Vue d’ensemble",
		href: "/?compact-navigation=1",
		active: true,
	},
	{
		id: "development.library",
		label: "Bibliothèque",
		href: "/?compact-navigation=1#library",
		description: "Parcourir les contenus",
		active: false,
	},
]);
const developmentCompactSidebar: SidebarView = {
	id: "development.compact-sidebar",
	eyebrow: "Navigation locale",
	title: "Menu latéral",
	subtitle: "Catégories, sous-liens et séparateurs restent ordonnés.",
	icon: "menu",
	items: [
		{
			kind: "link",
			id: "development.link-one",
			label: "Lien 1",
			href: "/?compact-navigation=1#link-one",
			active: false,
			children: [],
		},
		{
			kind: "link",
			id: "development.link-two",
			label: "Lien 2",
			href: "/?compact-navigation=1#link-two",
			active: false,
			children: [
				{
					kind: "link",
					id: "development.link-three",
					label: "Lien 3",
					href: "/?compact-navigation=1#link-three",
					active: false,
					children: [],
				},
			],
		},
		{
			kind: "separator",
			id: "development.collection-separator",
			label: "Collection",
		},
		{
			kind: "category",
			id: "development.category-one",
			label: "Catégorie 1",
			initiallyExpanded: true,
			children: [
				{
					kind: "link",
					id: "development.link-four",
					label: "Lien 4",
					href: "/?compact-navigation=1#link-four",
					active: false,
					children: [],
				},
			],
		},
	],
};

export function App() {
	const [path, setPath] = useState(() => window.location.pathname);
	useEffect(() => {
		const update = () => setPath(window.location.pathname);
		window.addEventListener("popstate", update);
		return () => window.removeEventListener("popstate", update);
	}, []);
	const navigate = (href: string) => {
		window.history.pushState(null, "", href);
		setPath(window.location.pathname);
	};
	const locale = navigator.language || "fr-FR";
	const navigation = useNavigationProjection(
		{ path, surface: "site", locale },
		developmentSiteNavigation,
		!import.meta.env.DEV || new URLSearchParams(window.location.search).has("navigation-api"),
	);
	const page = usePageProjection(
		{ path, surface: "site", locale },
		path === "/" ? developmentHomePage : undefined,
		!import.meta.env.DEV || new URLSearchParams(window.location.search).has("page-api"),
	);
	const contribution = page ? registry.resolve(page.component, capabilities) : undefined;
	const showDesignSystem =
		import.meta.env.DEV && new URLSearchParams(window.location.search).has("design-system");
	const showModuleHost =
		import.meta.env.DEV && new URLSearchParams(window.location.search).has("module-host");
	const showThemeTokens =
		import.meta.env.DEV && new URLSearchParams(window.location.search).has("theme-tokens");
	const showThemeBrand =
		import.meta.env.DEV && new URLSearchParams(window.location.search).has("theme-brand");
	const showThemeProjection =
		import.meta.env.DEV && new URLSearchParams(window.location.search).has("theme-projection");
	const showCompactNavigation =
		import.meta.env.DEV && new URLSearchParams(window.location.search).has("compact-navigation");
	return (
		<ApplicationShell
			brand={showThemeBrand ? developmentThemeBrand : undefined}
			brandNavigation={navigation.brand}
			primaryNavigation={showCompactNavigation ? developmentCompactNavigation : navigation.primary}
			sidebar={showCompactNavigation ? developmentCompactSidebar : navigation.sidebar}
			onNavigate={navigate}
			navigationActions={navigation.actions}
		>
			{showCompactNavigation ? (
				<DevelopmentCompactNavigationPage />
			) : showThemeProjection ? (
				<DevelopmentThemeProjectionPage />
			) : showThemeBrand ? (
				<DevelopmentThemeBrandPage />
			) : showThemeTokens ? (
				<DevelopmentThemeTokensPage />
			) : showDesignSystem ? (
				<DevelopmentDesignSystemPage />
			) : showModuleHost ? (
				<DevelopmentModuleHostPage locale={locale} />
			) : (
				<ModuleOutlet
					contribution={contribution}
					context={{
						capabilities,
						locale,
						session: publicSession,
					}}
					state={page}
					fallback={
						<Notice
							tone="danger"
							title={siteMessage(locale, "site.notFound.title")}
							badge={siteMessage(locale, "site.notFound.code")}
						>
							{siteMessage(locale, "site.notFound.description")}
						</Notice>
					}
				/>
			)}
		</ApplicationShell>
	);
}

function DevelopmentCompactNavigationPage() {
	return (
		<>
			<PageHeader
				eyebrow="Validation locale"
				title="Navigation compacte"
				description="Les menus principal et latéral conservent leurs liens, actions, catégories et niveaux d’imbrication sur les tailles réduites."
			/>
			<section className="content-grid" aria-label="Contrat de navigation compacte">
				<Card
					title="Menu principal"
					description="Les liens de page et les actions partagent un panneau unique sans duplication."
				/>
				<Card
					title="Menu latéral"
					description="Les catégories, séparateurs et sous-liens conservent leur ordre déclaré, avec un seul niveau d’imbrication."
				/>
				<Card
					title="Interactions accessibles"
					description="Échap, clic extérieur, changement de route et changement de taille referment les panneaux."
				/>
			</section>
		</>
	);
}

function DevelopmentThemeProjectionPage() {
	return (
		<>
			<PageHeader
				eyebrow="Validation locale"
				title="Projection de thème"
				description="Une projection Site typée applique uniquement des variables connues avant le montage React et revient au thème Compendlore lorsqu’elle est invalide."
			/>
			<section className="content-grid" aria-label="Projection frontend du thème">
				<Card
					title="Surface Site"
					description="La projection administrative ne peut pas être appliquée à ce shell public."
				/>
				<Card
					title="Variables autorisées"
					description="Le fond, la surface, le texte, l’accent, les bordures et l’espacement utilisent un catalogue fermé."
				/>
				<Card
					title="Repli Compendlore"
					description="Une version incompatible ou une valeur active restaure automatiquement les valeurs sûres compilées."
				/>
			</section>
		</>
	);
}

function DevelopmentThemeBrandPage() {
	return (
		<>
			<PageHeader
				eyebrow="Validation locale"
				title="Brand riche"
				description="La barre principale compose une identité localisable à partir de segments textuels sûrs, tout en conservant un nom accessible unique."
			/>
			<section className="content-grid" aria-label="Contrat du Brand riche">
				<Card
					title="Segments ordonnés"
					description="Donjon, l’esperluette et Dragon restent du texte ; seul leur emplacement de style déclaré varie."
				/>
				<Card
					title="Navigation détenue par le shell"
					description="Le Brand reste l’unique lien vers l’accueil, quelle que soit son apparence."
				/>
				<Card
					title="Repli déterministe"
					description="Un texte Compendlore lisible remplace tout asset ou segment indisponible."
				/>
			</section>
		</>
	);
}

function DevelopmentThemeTokensPage() {
	return (
		<>
			<PageHeader
				eyebrow="Validation locale"
				title="Jetons de thème"
				description="Cette vitrine vérifie les familles visuelles typées et les surcharges responsive sans réduire la surface pleine page."
			/>
			<section className="theme-token-showcase" aria-label="Jetons de thème">
				<article className="theme-token-showcase__frame">
					<p className="theme-role theme-role--title">Titre d’interface</p>
					<h2 className="theme-role theme-role--h1">Titre H1</h2>
					<h3 className="theme-role theme-role--h2">Titre H2</h3>
					<h4 className="theme-role theme-role--h3">Titre H3</h4>
					<h5 className="theme-role theme-role--h4">Titre H4</h5>
					<h6 className="theme-role theme-role--h5">Titre H5</h6>
					<p className="theme-role theme-role--body">
						Texte courant utilisant la pile de polices classique et les valeurs globales du thème.
					</p>
					<a className="theme-role theme-role--link" href="#theme-token-details">
						Lien non bouton
					</a>
					<Button className="theme-role theme-role--button">Texte de bouton</Button>
					<p className="theme-role theme-role--brand">Compendlore CMS</p>
				</article>
				<div id="theme-token-details" className="content-grid">
					<Card title="Couleurs" description="Fond, surface, texte et états sémantiques." />
					<Card title="Bordures" description="Épaisseur, couleur, style et rayon bornés." />
					<Card
						title="Polices"
						description="Piles système ou assets locaux analysés avec police de repli."
					/>
				</div>
			</section>
		</>
	);
}

function DevelopmentModuleHostPage({ locale }: { readonly locale: string }) {
	const [draft, setDraft] = useState("Brouillon conservé");
	const [capabilityEnabled, setCapabilityEnabled] = useState(true);
	const developmentRegistry = new FrontendModuleRegistry();
	developmentRegistry.register({
		identifier: "development.module-host",
		kind: "component",
		requiredCapability: "development.module-host.view",
		component: DevelopmentStatefulModule,
	});
	const developmentCapabilities = capabilityEnabled
		? new Set(["development.module-host.view"])
		: new Set<string>();
	const contribution = developmentRegistry.resolve(
		"development.module-host",
		developmentCapabilities,
	);

	return (
		<>
			<PageHeader
				eyebrow="Validation locale"
				title="Hôte de modules"
				description="Cette vitrine vérifie l’isolation par capacité et la conservation d’un état détenu par le shell."
			/>
			<ModuleOutlet
				contribution={contribution}
				context={{
					capabilities: developmentCapabilities,
					locale,
					session: publicSession,
				}}
				state={draft}
				onStateChange={(nextState) => setDraft(String(nextState))}
				fallback={
					<Notice tone="warning" title="Contribution indisponible">
						Le shell reste disponible et conserve le brouillon « {draft} ».
					</Notice>
				}
			/>
			<Button onClick={() => setCapabilityEnabled((enabled) => !enabled)}>
				{capabilityEnabled ? "Retirer la capacité" : "Restaurer la capacité"}
			</Button>
		</>
	);
}

function DevelopmentStatefulModule({ state, onStateChange }: FrontendModuleProps) {
	return (
		<Card title="Contribution autorisée" description="Le champ appartient à l’état du shell.">
			<Field
				label="Brouillon de validation"
				value={typeof state === "string" ? state : ""}
				onChange={(event) => onStateChange?.(event.currentTarget.value)}
			/>
		</Card>
	);
}

function DevelopmentDesignSystemPage() {
	const [activeTab, setActiveTab] = useState("general");
	const [modalOpen, setModalOpen] = useState(false);
	const [notificationsEnabled, setNotificationsEnabled] = useState(true);
	return (
		<>
			<PageHeader
				eyebrow="Validation locale"
				title="Design system partagé"
				description="Cette vitrine existe uniquement en développement pour vérifier les états, le clavier et l’accessibilité des primitives partagées."
				actions={<Button onClick={() => setModalOpen(true)}>Ouvrir la modale</Button>}
			/>
			<Notice title="Mode développement">
				Cette vue n’est pas incluse dans la navigation et reste inaccessible dans un build de
				production.
			</Notice>
			<section className="content-grid" aria-label="Composants fondamentaux">
				<Card title="Actions" description="Variantes et états des boutons partagés.">
					<div className="page-header__actions">
						<Button tone="primary">Primaire</Button>
						<Button tone="secondary">Secondaire</Button>
						<Button tone="danger">Dangereux</Button>
						<Button disabled>Désactivé</Button>
					</div>
				</Card>
				<Card title="Formulaire" description="Libellés, aides, erreurs et sélection.">
					<Field label="Nom affiché" hint="Visible publiquement" defaultValue="Compendlore" />
					<Field label="Champ en erreur" error="Une valeur est obligatoire" />
					<SelectField
						label="Langue"
						hint="Langue de l’interface"
						defaultValue="fr"
						options={[
							{ value: "fr", label: "Français" },
							{ value: "en", label: "English" },
						]}
					/>
					<Switch
						checked={notificationsEnabled}
						label="Notifications activées"
						onChange={setNotificationsEnabled}
					/>
				</Card>
				<Card title="Contenu structuré" description="Listes et informations sémantiques.">
					<List ordered>
						<ListItem>Ouvrir la vitrine</ListItem>
						<ListItem>Parcourir les contrôles au clavier</ListItem>
						<ListItem>Inspecter l’arbre d’accessibilité</ListItem>
					</List>
					<Notice tone="success">Notification accessible disponible.</Notice>
				</Card>
			</section>
			<Tabs
				tabs={[
					{ id: "general", label: "Général", content: "Panneau général actif." },
					{ id: "security", label: "Sécurité", content: "Panneau de sécurité actif." },
					{ id: "disabled", label: "Indisponible", content: "", disabled: true },
				]}
				activeId={activeTab}
				onChange={setActiveTab}
			/>
			<Table
				caption="Exemple de tableau partagé"
				columns={[
					{ key: "component", title: "Composant", render: (row) => row.component },
					{ key: "state", title: "État", render: (row) => row.state },
				]}
				rows={[
					{ id: "tabs", component: "Onglets", state: "Interactif" },
					{ id: "modal", component: "Modale", state: "Fermée" },
				]}
				rowKey={(row) => row.id}
			/>
			<DateTimePicker locale="fr-FR" onChange={() => undefined} />
			<Modal
				open={modalOpen}
				eyebrow="Contrôle clavier"
				title="Modale accessible"
				onClose={() => setModalOpen(false)}
				actions={
					<>
						<Button onClick={() => setModalOpen(false)}>Annuler</Button>
						<Button tone="primary" onClick={() => setModalOpen(false)}>
							Confirmer
						</Button>
					</>
				}
			>
				<Field label="Valeur de contrôle" hint="Le focus doit rester dans cette fenêtre." />
			</Modal>
		</>
	);
}

function DynamicPage({ state }: FrontendModuleProps) {
	const page = state as PageProjectionView;
	const header = page.content.find((block) => block.kind === "header");
	const cards = page.content.filter((block) => block.kind === "card");
	return (
		<>
			{header ? (
				<PageHeader
					eyebrow={header.eyebrow ?? ""}
					title={header.title}
					description={header.description}
				/>
			) : null}
			{cards.length > 0 ? (
				<section className="content-grid">
					{cards.map((card, index) => (
						<Card key={`${page.identifier}.${index}`} {...card} />
					))}
				</section>
			) : null}
		</>
	);
}
