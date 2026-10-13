import { useEffect, useState } from "react";
import {
	ApplicationShell,
	Button,
	Card,
	FrontendModuleRegistry,
	Icon,
	ModuleOutlet,
	Notice,
	PageHeader,
	navigationFromCatalog,
	useNativeCatalog,
	type CatalogNavigationLink,
	type FrontendModuleProps,
} from "@compendlore/ui";

const registry = new FrontendModuleRegistry();
registry.register({ identifier: "core.home", kind: "page", component: HomePage });
const capabilities = new Set<string>(["core.site.view"]);

export function App() {
	const catalogState = useNativeCatalog("site");
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
	if (catalogState.status !== "ready") {
		return (
			<ApplicationShell>
				<Notice
					tone={catalogState.status === "loading" ? "information" : "warning"}
					title={
						catalogState.status === "loading" ? "Chargement du site" : "Catalogue indisponible"
					}
				>
					{catalogState.status === "loading"
						? "Le Core prépare les contenus enregistrés."
						: "Le site ne peut pas charger ses contributions pour le moment."}
				</Notice>
			</ApplicationShell>
		);
	}
	const navigation = navigationFromCatalog(catalogState.catalog, path);
	const page = catalogState.catalog.pages.find((candidate) => candidate.route === path);
	return (
		<ApplicationShell
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
		<Button data-action={action.target} title={action.tooltip}>
			{icon ? <Icon name={icon} /> : null}
			<span>{action.title}</span>
		</Button>
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
