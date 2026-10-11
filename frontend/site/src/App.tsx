import { useEffect, useState } from "react";
import {
	ApplicationShell,
	Button,
	Card,
	FrontendModuleRegistry,
	Icon,
	ModuleOutlet,
	PageHeader,
	type FrontendModuleProps,
} from "@compendlore/ui";

const registry = new FrontendModuleRegistry();
registry.register({ identifier: "core.home", kind: "route", path: "/", component: HomePage });
registry.register({
	identifier: "core.modules",
	kind: "route",
	path: "/modules",
	component: ModulesPage,
});
const capabilities = new Set<string>(["core.site.view"]);

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
	const navigation = [
		{
			id: "home",
			label: "Accueil",
			href: "/",
			description: "Portail public",
			active: path === "/",
		},
		{
			id: "modules",
			label: "Modules",
			href: "/modules",
			description: "Contenus disponibles",
			active: path === "/modules",
		},
	] as const;
	return (
		<ApplicationShell
			title="Explorer"
			subtitle="Univers, pages et outils autorisés"
			navigation={navigation}
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

function ModulesPage(_props: FrontendModuleProps) {
	return (
		<>
			<PageHeader
				eyebrow="Registre frontend"
				title="Modules disponibles"
				description="Ce shell résout les contributions autorisées sans connaître leur implémentation métier."
			/>
			<div className="content-grid">
				<Card title="Pages" description="Routes et pages déclarées par le site ou les addons." />
				<Card title="Composants" description="Blocs réutilisables soumis aux capacités frontend." />
				<Card
					title="Formulaires"
					description="Interfaces déclaratives conservant leurs données en cas d’indisponibilité."
				/>
			</div>
		</>
	);
}
