import type { ReactNode } from "react";
import { Icon } from "./icons.js";
import type { NavigationLinkView, SidebarElementView, SidebarView } from "./navigation.js";

export type NavigationItem = NavigationLinkView;

export interface ApplicationShellProps {
	readonly administration?: boolean;
	readonly brand?: NavigationItem | undefined;
	readonly primaryNavigation?: readonly NavigationItem[];
	readonly sidebar?: SidebarView | undefined;
	readonly actions?: ReactNode;
	readonly children: ReactNode;
	readonly onNavigate?: ((href: string) => void) | undefined;
}

export function ApplicationShell({
	administration = false,
	brand,
	primaryNavigation = [],
	sidebar,
	actions,
	children,
	onNavigate,
}: ApplicationShellProps) {
	return (
		<div
			className={`application-shell ${administration ? "application-shell--administration" : ""} ${sidebar ? "" : "application-shell--without-sidebar"}`.trim()}
		>
			<header className="topbar">
				<a
					className="brand"
					href={brand?.href ?? "/"}
					onClick={(event) => {
						if (!onNavigate) return;
						event.preventDefault();
						onNavigate(brand?.href ?? "/");
					}}
				>
					<span className="brand__mark">
						<Icon name={brand?.icon ?? "brand"} size={22} />
					</span>
					<span>{brand?.label ?? "Compendlore CMS"}</span>
				</a>
				<nav className="topbar__navigation" aria-label="Navigation principale">
					{primaryNavigation.map((item) => (
						<NavigationLink key={item.id} item={item} onNavigate={onNavigate} />
					))}
				</nav>
				<div className="topbar__actions">{actions}</div>
			</header>
			{sidebar ? (
				<aside className="sidebar">
					{sidebar.eyebrow ? <p className="eyebrow">{sidebar.eyebrow}</p> : null}
					<div className="sidebar__heading">
						<h2>{sidebar.title}</h2>
						{sidebar.icon ? <Icon name={sidebar.icon} /> : null}
					</div>
					{sidebar.subtitle ? <p className="sidebar__subtitle">{sidebar.subtitle}</p> : null}
					<nav aria-label={administration ? "Navigation administrative" : "Navigation du site"}>
						{sidebar.items.map((item) => (
							<SidebarElement key={item.id} item={item} onNavigate={onNavigate} />
						))}
					</nav>
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
		return (
			<div className="sidebar__separator">
				{item.icon ? <Icon name={item.icon} size={16} /> : null}
				<strong>{item.label}</strong>
			</div>
		);
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
