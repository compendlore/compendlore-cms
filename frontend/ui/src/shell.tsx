import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons.js";

export interface NavigationItem {
	readonly id: string;
	readonly label: string;
	readonly href: string;
	readonly icon?: IconName;
	readonly description?: string;
	readonly active?: boolean;
}

export interface ApplicationShellProps {
	readonly administration?: boolean;
	readonly title: string;
	readonly subtitle?: string;
	readonly navigation: readonly NavigationItem[];
	readonly actions?: ReactNode;
	readonly children: ReactNode;
	readonly onNavigate?: ((href: string) => void) | undefined;
}

export function ApplicationShell({
	administration = false,
	title,
	subtitle,
	navigation,
	actions,
	children,
	onNavigate,
}: ApplicationShellProps) {
	return (
		<div
			className={`application-shell ${administration ? "application-shell--administration" : ""}`}
		>
			<header className="topbar">
				<a
					className="brand"
					href="/"
					onClick={(event) => {
						if (!onNavigate) return;
						event.preventDefault();
						onNavigate("/");
					}}
				>
					<span className="brand__mark">
						<Icon name="brand" size={22} />
					</span>
					<span>Lore &amp; Dice CMS</span>
				</a>
				<nav className="topbar__navigation" aria-label="Navigation principale">
					{navigation.slice(0, 4).map((item) => (
						<NavigationLink key={item.id} item={item} onNavigate={onNavigate} />
					))}
				</nav>
				<div className="topbar__actions">{actions}</div>
			</header>
			<aside className="sidebar">
				<p className="eyebrow">{administration ? "Administration" : "Explorer"}</p>
				<div className="sidebar__heading">
					<h2>{title}</h2>
					{administration ? <Icon name="administration" /> : null}
				</div>
				{subtitle ? <p className="sidebar__subtitle">{subtitle}</p> : null}
				<nav aria-label={administration ? "Navigation administrative" : "Navigation du site"}>
					{navigation.map((item) => (
						<NavigationLink key={item.id} item={item} onNavigate={onNavigate} />
					))}
				</nav>
			</aside>
			<main className="page-content">
				<div className="content-wrap">{children}</div>
			</main>
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
