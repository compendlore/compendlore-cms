import { useEffect, useState } from "react";
import {
	ApplicationShell,
	Button,
	Card,
	FrontendModuleRegistry,
	Icon,
	MainNavigationRegistry,
	ModuleOutlet,
	NavigationResolver,
	PageHeader,
	SidebarElementRegistry,
	SidebarRegistry,
	type FrontendModuleProps,
} from "@compendlore/ui";

const registry = new FrontendModuleRegistry();
registry.register({ identifier: "core.home", kind: "route", path: "/", component: HomePage });
const capabilities = new Set<string>(["core.site.view"]);
const mainNavigation = new MainNavigationRegistry();
mainNavigation.register({
	identifier: "core.home",
	label: "Accueil",
	href: "/",
	visibility: "hidden",
	systemRole: "home",
});
const navigationResolver = new NavigationResolver(
	mainNavigation,
	new SidebarRegistry(),
	new SidebarElementRegistry(),
);

export function App() {
	const [path, setPath] = useState(() => window.location.pathname);
	useEffect(() => {
		const update = () => setPath(window.location.pathname);
		window.addEventListener("popstate", update);
		return () => window.removeEventListener("popstate", update);
	}, []);
	const navigate = (href: string) => {
		window.history.pushState(null, "", href);
		setPath(href);
	};
	const navigation = navigationResolver.resolve(path, capabilities);
	return (
		<ApplicationShell
			primaryNavigation={navigation.mainLinks}
			sidebar={navigation.sidebar}
			onNavigate={navigate}
			actions={
				<>
					<Button aria-label="Compte utilisateur">
						<Icon name="account" />
					</Button>
					<a className="button button--secondary" href="/administration">
						<Icon name="administration" />
						<span>Administration</span>
					</a>
				</>
			}
		>
			<ModuleOutlet
				contribution={registry.resolveRoute(path, capabilities)}
				context={{ capabilities, locale: navigator.language || "fr-FR" }}
			/>
		</ApplicationShell>
	);
}

function HomePage(_props: FrontendModuleProps) {
	return (
		<>
			<PageHeader
				eyebrow="Portail public"
				title="Compendlore CMS"
				description="Une fondation modulaire pour publier et explorer des univers de jeu de rôle."
			/>
			<section className="content-grid">
				<Card
					eyebrow="Navigation"
					title="Contenus enregistrés"
					description="Les pages, menus et interfaces apparaîtront ici lorsqu’un module autorisé les enregistrera."
				/>
				<Card
					eyebrow="Session"
					title="Accès utilisateur"
					description="La navigation adapte les modules visibles aux capacités de la session, sans exposer les outils administratifs."
				/>
				<Card
					eyebrow="Résilience"
					title="Interface disponible"
					description="Une contribution indisponible est isolée afin que le reste du site continue de fonctionner."
				/>
			</section>
		</>
	);
}
