import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "./icons.js";
import {
	isSafeThemeBrandLogoSource,
	RichBrandContent,
	resolveRichBrandAccessibleLabel,
	type RichBrandView,
} from "./brand.js";
import type { NavigationLinkView, SidebarElementView, SidebarView } from "./navigation.js";
import type { NavigationActionView } from "./navigation-projection.js";

export type NavigationItem = NavigationLinkView;

export interface ApplicationShellProps {
	readonly administration?: boolean;
	readonly primaryNavigation?: readonly NavigationItem[];
	readonly sidebar?: SidebarView | undefined;
	readonly actions?: ReactNode;
	readonly navigationActions?: readonly NavigationActionView[];
	readonly onNavigationAction?: ((identifier: string) => void) | undefined;
	readonly children: ReactNode;
	readonly onNavigate?: ((href: string) => void) | undefined;
	readonly brand?: RichBrandView | undefined;
	readonly brandNavigation?: { readonly label: string; readonly href: string } | undefined;
	readonly compactNavigationLabels?:
		| {
				readonly openMain: string;
				readonly closeMain: string;
				readonly openSidebar: string;
				readonly closeSidebar: string;
		  }
		| undefined;
}

const defaultCompactNavigationLabels = Object.freeze({
	openMain: "Ouvrir le menu principal",
	closeMain: "Fermer le menu principal",
	openSidebar: "Ouvrir le menu latéral",
	closeSidebar: "Fermer le menu latéral",
});

export function ApplicationShell({
	administration = false,
	primaryNavigation = [],
	sidebar,
	actions,
	navigationActions = [],
	onNavigationAction,
	children,
	onNavigate,
	brand,
	brandNavigation,
	compactNavigationLabels = defaultCompactNavigationLabels,
}: ApplicationShellProps) {
	const [mainMenuOpen, setMainMenuOpen] = useState(false);
	const [sidebarMenuOpen, setSidebarMenuOpen] = useState(false);
	const mainMenuId = useId();
	const sidebarMenuId = useId();
	const mainToggleRef = useRef<HTMLButtonElement>(null);
	const mainPanelRef = useRef<HTMLDivElement>(null);
	const sidebarToggleRef = useRef<HTMLButtonElement>(null);
	const sidebarPanelRef = useRef<HTMLDivElement>(null);
	useDismissibleCompactMenu({
		open: mainMenuOpen,
		setOpen: setMainMenuOpen,
		toggleRef: mainToggleRef,
		panelRef: mainPanelRef,
		mediaQuery: "(max-width: 70rem)",
	});
	useDismissibleCompactMenu({
		open: sidebarMenuOpen,
		setOpen: setSidebarMenuOpen,
		toggleRef: sidebarToggleRef,
		panelRef: sidebarPanelRef,
		mediaQuery: "(max-width: 52rem)",
	});
	useEffect(() => {
		const closeMenus = () => {
			setMainMenuOpen(false);
			setSidebarMenuOpen(false);
		};
		window.addEventListener("popstate", closeMenus);
		window.addEventListener("hashchange", closeMenus);
		return () => {
			window.removeEventListener("popstate", closeMenus);
			window.removeEventListener("hashchange", closeMenus);
		};
	}, []);
	const navigate = onNavigate
		? (href: string) => {
				setMainMenuOpen(false);
				setSidebarMenuOpen(false);
				onNavigate(href);
			}
		: undefined;
	return (
		<div
			className={`application-shell ${administration ? "application-shell--administration" : ""} ${sidebar ? "" : "application-shell--without-sidebar"}`.trim()}
		>
			<header className="topbar">
				<a
					className="brand"
					href={brandNavigation?.href ?? "/"}
					aria-label={resolveRichBrandAccessibleLabel(
						brand,
						brandNavigation?.label ?? "Compendlore CMS",
					)}
					onClick={(event) => {
						if (!onNavigate) return;
						event.preventDefault();
						onNavigate(brandNavigation?.href ?? "/");
					}}
				>
					{isSafeThemeBrandLogoSource(brand?.logoSource) ? null : (
						<span className="brand__mark">
							<Icon name="brand" size={22} />
						</span>
					)}
					<RichBrandContent brand={brand} fallbackLabel="Compendlore CMS" />
				</a>
				<button
					ref={mainToggleRef}
					type="button"
					className="button topbar__menu-toggle"
					aria-expanded={mainMenuOpen}
					aria-controls={mainMenuId}
					aria-label={
						mainMenuOpen ? compactNavigationLabels.closeMain : compactNavigationLabels.openMain
					}
					onClick={() => {
						setSidebarMenuOpen(false);
						setMainMenuOpen((open) => !open);
					}}
				>
					<Icon name="menu" />
				</button>
				<div
					ref={mainPanelRef}
					id={mainMenuId}
					className="topbar__collapsible"
					data-open={mainMenuOpen}
					onClick={(event) => {
						if ((event.target as Element).closest("a, button")) setMainMenuOpen(false);
					}}
				>
					<nav className="topbar__navigation" aria-label="Navigation principale">
						{primaryNavigation.map((item) => (
							<NavigationLink key={item.id} item={item} onNavigate={navigate} />
						))}
					</nav>
					<div className="topbar__actions">
						{navigationActions.map((action) =>
							action.href ? (
								<a key={action.id} className="button button--secondary" href={action.href}>
									{action.icon ? <Icon name={action.icon} /> : null}
									<span>{action.label}</span>
								</a>
							) : (
								<button
									key={action.id}
									type="button"
									className={`button button--${action.appearance ?? "secondary"}`}
									onClick={() => onNavigationAction?.(action.command ?? action.id)}
								>
									{action.icon ? <Icon name={action.icon} /> : null}
									<span>{action.label}</span>
								</button>
							),
						)}
						{actions}
					</div>
				</div>
			</header>
			{sidebar ? (
				<aside className="sidebar">
					<button
						ref={sidebarToggleRef}
						type="button"
						className="button sidebar__menu-toggle"
						aria-expanded={sidebarMenuOpen}
						aria-controls={sidebarMenuId}
						aria-label={
							sidebarMenuOpen
								? compactNavigationLabels.closeSidebar
								: compactNavigationLabels.openSidebar
						}
						onClick={() => {
							setMainMenuOpen(false);
							setSidebarMenuOpen((open) => !open);
						}}
					>
						<span>{sidebar.title}</span>
						<Icon name="chevron" />
					</button>
					<div
						ref={sidebarPanelRef}
						id={sidebarMenuId}
						className="sidebar__collapsible"
						data-open={sidebarMenuOpen}
					>
						{sidebar.eyebrow ? <p className="eyebrow">{sidebar.eyebrow}</p> : null}
						<div className="sidebar__heading">
							<h2>{sidebar.title}</h2>
							{sidebar.icon ? <Icon name={sidebar.icon} /> : null}
						</div>
						{sidebar.subtitle ? <p className="sidebar__subtitle">{sidebar.subtitle}</p> : null}
						<nav aria-label={administration ? "Navigation administrative" : "Navigation du site"}>
							{sidebar.items.map((item) => (
								<SidebarElement key={item.id} item={item} onNavigate={navigate} />
							))}
						</nav>
					</div>
				</aside>
			) : null}
			<main className="page-content">
				<div className="content-wrap">{children}</div>
			</main>
		</div>
	);
}

function SidebarElement({
	item,
	onNavigate,
}: {
	readonly item: SidebarElementView;
	readonly onNavigate?: ((href: string) => void) | undefined;
}) {
	if (item.kind === "separator") {
		return <div className="sidebar__separator" role="separator" aria-label={item.label} />;
	}
	if (item.kind === "category") {
		return (
			<details className="sidebar__category" open={item.initiallyExpanded}>
				<summary title={item.description}>
					{item.icon ? <Icon name={item.icon} size={18} /> : null}
					<strong>{item.label}</strong>
				</summary>
				<div className="sidebar__children">
					{item.children.map((child) => (
						<SidebarElement key={child.id} item={child} onNavigate={onNavigate} />
					))}
				</div>
			</details>
		);
	}
	return (
		<div className="sidebar__link-group">
			<NavigationLink item={item} onNavigate={onNavigate} />
			{item.children.length ? (
				<div className="sidebar__children">
					{item.children.map((child) => (
						<SidebarElement key={child.id} item={child} onNavigate={onNavigate} />
					))}
				</div>
			) : null}
		</div>
	);
}

function useDismissibleCompactMenu({
	open,
	setOpen,
	toggleRef,
	panelRef,
	mediaQuery,
}: {
	readonly open: boolean;
	readonly setOpen: (open: boolean) => void;
	readonly toggleRef: RefObject<HTMLButtonElement | null>;
	readonly panelRef: RefObject<HTMLDivElement | null>;
	readonly mediaQuery: string;
}) {
	useEffect(() => {
		const query = window.matchMedia(mediaQuery);
		const handleBreakpointChange = () => setOpen(false);
		query.addEventListener("change", handleBreakpointChange);
		return () => query.removeEventListener("change", handleBreakpointChange);
	}, [mediaQuery, setOpen]);
	useEffect(() => {
		if (!open) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setOpen(false);
			toggleRef.current?.focus();
		};
		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (toggleRef.current?.contains(target) || panelRef.current?.contains(target)) return;
			setOpen(false);
		};
		document.addEventListener("keydown", handleKeyDown);
		document.addEventListener("pointerdown", handlePointerDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.removeEventListener("pointerdown", handlePointerDown);
		};
	}, [open, panelRef, setOpen, toggleRef]);
}

function NavigationLink({
	item,
	onNavigate,
}: {
	readonly item: NavigationItem;
	readonly onNavigate?: ((href: string) => void) | undefined;
}) {
	return (
		<a
			className={item.active ? "active" : ""}
			href={item.href}
			aria-current={item.active ? "page" : undefined}
			title={item.description}
			onClick={(event) => {
				if (!onNavigate) return;
				event.preventDefault();
				onNavigate(item.href);
			}}
		>
			{item.icon ? <Icon name={item.icon} size={18} /> : null}
			<span>
				<strong>{item.label}</strong>
				{item.description ? <small>{item.description}</small> : null}
			</span>
		</a>
	);
}

export function PageHeader({
	eyebrow,
	title,
	description,
	actions,
}: {
	readonly eyebrow: ReactNode;
	readonly title: ReactNode;
	readonly description?: ReactNode;
	readonly actions?: ReactNode;
}) {
	return (
		<header className="page-header">
			<div>
				<p className="eyebrow">{eyebrow}</p>
				<h1>{title}</h1>
				{description ? <p className="lead">{description}</p> : null}
			</div>
			{actions ? <div className="page-header__actions">{actions}</div> : null}
		</header>
	);
}
