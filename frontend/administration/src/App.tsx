import { useEffect, useState } from "react";
import {
	ApplicationShell,
	AdministrationSessionGuard,
	Button,
	Card,
	DateTimePicker,
	Field,
	FrontendModuleRegistry,
	Modal,
	ModuleOutlet,
	NotificationHub,
	Notice,
	PageHeader,
	SelectField,
	useNavigationProjection,
	usePageProjection,
	useRegistryAdministrationProjection,
	Switch,
	Table,
	Tabs,
	hasAdministrationShellAccess,
	parseAdministrationSessionSnapshot,
	type NativeNotification,
	type AdministrationSessionSnapshot,
	type FrontendModuleProps,
	type FrontendSessionContext,
	type NavigationProjectionView,
	type RegistryAdministrationProjectionView,
} from "@compendlore/ui";
import { administrationMessage } from "./messages.js";

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
const developmentAdministrationNavigation = Object.freeze({
	brand: Object.freeze({ label: "Compendlore CMS", href: "/" }),
	primary: Object.freeze([]),
	actions: Object.freeze([
		{ id: "core.site", label: "Voir le site", href: "/" },
		{ id: "core.logout", label: "Se déconnecter", icon: "logout", command: "core.logout" },
	]),
	sidebar: Object.freeze({
		id: "core.administration",
		eyebrow: "Explorer",
		title: "Administration",
		subtitle: "Accès protégé par rôle et second facteur",
		icon: "administration",
		items: Object.freeze([
			{
				kind: "link" as const,
				id: "core.administration.dashboard",
				label: "Pilotage",
				href: "/admin",
				icon: "administration" as const,
				description: "État du CMS",
				active: false,
				children: Object.freeze([]),
			},
			{
				kind: "link" as const,
				id: "core.administration.modules",
				label: "Modules",
				href: "/admin/modules",
				icon: "menu" as const,
				description: "Contributions enregistrées",
				active: false,
				children: Object.freeze([]),
			},
			{
				kind: "link" as const,
				id: "core.administration.interface",
				label: "Interface",
				href: "/admin/interface",
				icon: "settings" as const,
				description: "Composants du CMS",
				active: false,
				children: Object.freeze([]),
			},
		]),
	}),
} satisfies NavigationProjectionView);

const developmentAdministrationPages: Readonly<Record<string, ReturnType<typeof pageFixture>>> =
	Object.freeze({
		"/admin": pageFixture("core.admin.dashboard", "Tableau de bord"),
		"/admin/modules": pageFixture("core.admin.modules", "Modules"),
		"/admin/interface": pageFixture("core.admin.interface", "Interface"),
	});

const developmentRegistryAdministration = Object.freeze({
	generatedAt: "2026-10-15T00:00:00.000Z",
	contributions: Object.freeze([
		{
			key: "module.core",
			identifier: "core",
			type: "module",
			state: "active",
			version: "1.0.0",
			owner: Object.freeze({ kind: "core", identifier: "core" }),
			locked: true,
			dependencies: Object.freeze([]),
			dependents: Object.freeze(["module.site"]),
			blockers: Object.freeze(["module.site"]),
			allowedActions: Object.freeze([]),
		},
		{
			key: "module.site",
			identifier: "site",
			type: "module",
			state: "active",
			version: "1.0.0",
			owner: Object.freeze({ kind: "native-module", identifier: "native.site" }),
			locked: false,
			dependencies: Object.freeze(["module.core"]),
			dependents: Object.freeze([]),
			blockers: Object.freeze([]),
			allowedActions: Object.freeze(["disable", "withdraw"] as const),
		},
		{
			key: "module.example-addon",
			identifier: "example-addon",
			type: "module",
			state: "failed",
			version: "1.1.0",
			owner: Object.freeze({ kind: "addon", identifier: "example-addon" }),
			locked: false,
			dependencies: Object.freeze(["module.site"]),
			dependents: Object.freeze([]),
			blockers: Object.freeze([]),
			allowedActions: Object.freeze(["repair", "withdraw"] as const),
			error: "La dernière activation a échoué sans exposer de donnée sensible.",
		},
	]),
} satisfies RegistryAdministrationProjectionView);

export function App() {
	const [sessionSnapshot, setSessionSnapshot] = useState(readAdministrationSession);
	const [path, setPath] = useState(() =>
		window.location.pathname === "/admin/" ? "/admin" : window.location.pathname,
	);
	useEffect(() => {
		const update = () => setPath(window.location.pathname);
		window.addEventListener("popstate", update);
		return () => window.removeEventListener("popstate", update);
	}, []);
	useEffect(() => {
		const guard = new AdministrationSessionGuard({
			purgeSensitiveState() {
				sessionStorage.removeItem("compendlore.administration.preloaded-data");
			},
			leaveAdministration() {
				window.location.replace("/");
			},
		});
		const revalidate = () => {
			const current = readAdministrationSession();
			setSessionSnapshot(current);
			guard.revalidate(current);
		};
		const onVisibilityChange = () => {
			if (document.visibilityState === "visible") revalidate();
		};
		const onSecurityMessage = (event: MessageEvent<unknown>) => {
			if (event.data === "revoked") {
				guard.revoke();
				return;
			}
			revalidate();
		};
		window.addEventListener("focus", revalidate);
		window.addEventListener("pageshow", revalidate);
		window.addEventListener("compendlore:administration-session-invalidated", revalidate);
		document.addEventListener("visibilitychange", onVisibilityChange);
		const channel = new BroadcastChannel("compendlore-administration-security");
		channel.addEventListener("message", onSecurityMessage);
		guard.revalidate(sessionSnapshot);
		return () => {
			window.removeEventListener("focus", revalidate);
			window.removeEventListener("pageshow", revalidate);
			window.removeEventListener("compendlore:administration-session-invalidated", revalidate);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			channel.close();
		};
	}, [sessionSnapshot]);
	const locale = navigator.language || "fr-FR";
	const navigation = useNavigationProjection(
		{ path, surface: "administration", locale },
		developmentAdministrationNavigation,
		!import.meta.env.DEV || new URLSearchParams(window.location.search).has("navigation-api"),
	);
	const page = usePageProjection(
		{ path, surface: "administration", locale },
		developmentAdministrationPages[path],
		!import.meta.env.DEV || new URLSearchParams(window.location.search).has("page-api"),
	);
	if (!hasAdministrationShellAccess(sessionSnapshot)) return null;
	const administrationSession = toFrontendSession(sessionSnapshot);
	const capabilities = administrationSession.capabilities;
	const navigate = (href: string) => {
		if (!/^\/admin(?:\/|$)/.test(href)) {
			window.location.assign(href);
			return;
		}
		window.history.pushState(null, "", href);
		setPath(href);
	};
	return (
		<ApplicationShell
			administration
			brandNavigation={navigation.brand}
			primaryNavigation={navigation.primary}
			sidebar={navigation.sidebar}
			onNavigate={navigate}
			navigationActions={navigation.actions}
		>
			{isShellSecurityPreview() ? <ShellSecurityPreview locale={locale} /> : null}
			<ModuleOutlet
				contribution={page ? registry.resolve(page.component, capabilities) : undefined}
				context={{
					capabilities,
					locale,
					session: administrationSession,
				}}
				fallback={
					<Notice
						tone="danger"
						title={administrationMessage(locale, "administration.notFound.title")}
					>
						{administrationMessage(locale, "administration.notFound.description")}
					</Notice>
				}
			/>
		</ApplicationShell>
	);
}

function pageFixture(component: string, title: string) {
	return Object.freeze({
		identifier: component,
		component,
		title,
		content: Object.freeze([]),
		revision: 1,
		fingerprint: "0".repeat(64),
	});
}

const previewNotifications = [
	{
		id: "security-banner",
		title: "Session administrative active",
		message: "Les changements d’autorisation sont vérifiés à chaque reprise du shell.",
		presentation: "banner",
		tone: "information",
		occurredAt: "2026-10-14T18:00:00.000Z",
		read: false,
		displayDurationMs: 10_000,
	},
	{
		id: "delivery-inbox",
		title: "Centre de notifications disponible",
		message: "Cette entrée reste consultable même lorsque le temps réel est indisponible.",
		presentation: "inbox",
		tone: "success",
		occurredAt: "2026-10-14T17:00:00.000Z",
		read: true,
	},
] as const;

function ShellSecurityPreview({ locale }: { readonly locale: string }) {
	useEffect(() => {
		window.compendloreNotifications = Object.freeze({
			push(notification: unknown) {
				window.dispatchEvent(new CustomEvent("compendlore:notification", { detail: notification }));
			},
		});
		return () => {
			delete window.compendloreNotifications;
		};
	}, []);
	return (
		<section aria-label="Validation de la sécurité du shell">
			<PageHeader
				eyebrow="Validation locale"
				title="Sécurité et notifications"
				description="Cette surface de développement vérifie la révocation et les présentations natives."
				actions={
					<Button tone="danger" onClick={simulateSessionRevocation}>
						Simuler la révocation
					</Button>
				}
			/>
			<NotificationHub
				initialNotifications={previewNotifications satisfies readonly NativeNotification[]}
				locale={locale}
				maxVisible={5}
				labels={{
					button: "Notifications non lues",
					panel: "Centre de notifications",
					markAllRead: "Tout marquer comme lu",
					close: "Marquer comme lue",
				}}
			/>
		</section>
	);
}

function simulateSessionRevocation() {
	window.__COMPENDLORE_ADMINISTRATION_SESSION__ = {
		...developmentAdministrationSession,
		status: "revoked",
		revision: "development.revoked",
	};
	window.dispatchEvent(new Event("compendlore:administration-session-invalidated"));
	const channel = new BroadcastChannel("compendlore-administration-security");
	channel.postMessage("revoked");
	channel.close();
}

function readAdministrationSession(): AdministrationSessionSnapshot {
	const payload = window.__COMPENDLORE_ADMINISTRATION_SESSION__;
	if (payload !== undefined) {
		try {
			return parseAdministrationSessionSnapshot(payload);
		} catch {
			return revokedAdministrationSession;
		}
	}
	return import.meta.env.DEV && isAdministrationPreview()
		? parseAdministrationSessionSnapshot(developmentAdministrationSession)
		: revokedAdministrationSession;
}

function toFrontendSession(session: AdministrationSessionSnapshot): FrontendSessionContext {
	return Object.freeze({
		status: "authenticated",
		subjectIdentifier: session.subjectIdentifier,
		roles: session.roles,
		capabilities: session.capabilities,
	});
}

function isAdministrationPreview(): boolean {
	return new URLSearchParams(window.location.search).get("administration-preview") === "1";
}

function isShellSecurityPreview(): boolean {
	return (
		import.meta.env.DEV && new URLSearchParams(window.location.search).get("shell-security") === "1"
	);
}

const developmentAdministrationSession = Object.freeze({
	status: "authenticated",
	subjectIdentifier: "development-administration-session",
	roles: Object.freeze(["administrator"]),
	capabilities: Object.freeze(["core.administration.access"]),
	secondFactorVerified: true,
	secondFactorExpiresAt: Date.now() + 60 * 60 * 1000,
	revision: "development.active",
});

const revokedAdministrationSession: AdministrationSessionSnapshot = Object.freeze({
	status: "revoked",
	subjectIdentifier: "revoked-administration-session",
	roles: Object.freeze([]),
	capabilities: new Set<string>(),
	secondFactorVerified: false,
	revision: "revoked",
});

declare global {
	interface Window {
		__COMPENDLORE_ADMINISTRATION_SESSION__?: unknown;
		compendloreNotifications?: {
			readonly push: (notification: unknown) => void;
		};
	}
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
	const projection = useRegistryAdministrationProjection(
		developmentRegistryAdministration,
		!import.meta.env.DEV || new URLSearchParams(window.location.search).has("registry-api"),
	);
	return (
		<>
			<PageHeader
				eyebrow="Administration · Registre"
				title="Contributions"
				description="Inspectez les propriétaires, verrouillages, dépendances et opérations autorisées par le Core."
			/>
			<Table
				caption="Catalogue des contributions enregistrées"
				columns={[
					{
						key: "contribution",
						title: "Contribution",
						render: (row) => (
							<>
								<strong>{row.identifier}</strong>
								<br />
								<small>
									{row.type} · v{row.version}
								</small>
							</>
						),
					},
					{
						key: "owner",
						title: "Propriétaire",
						render: (row) => `${row.owner.kind} · ${row.owner.identifier}`,
					},
					{
						key: "state",
						title: "État",
						render: (row) => `${row.state}${row.locked ? " · verrouillée" : ""}`,
					},
					{
						key: "relations",
						title: "Dépendances",
						render: (row) => (
							<>
								{row.dependencies.length ? row.dependencies.join(", ") : "Aucune"}
								{row.blockers.length ? (
									<>
										<br />
										<small>Blocage : {row.blockers.join(", ")}</small>
									</>
								) : null}
							</>
						),
					},
					{
						key: "actions",
						title: "Actions autorisées",
						render: (row) => (row.allowedActions.length ? row.allowedActions.join(", ") : "Aucune"),
					},
					{
						key: "diagnostic",
						title: "Diagnostic",
						render: (row) => row.error ?? "—",
					},
				]}
				rows={projection.contributions}
				rowKey={(row) => row.key}
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
