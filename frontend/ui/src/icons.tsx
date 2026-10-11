import type { ReactNode } from "react";

export type IconName =
	"account" | "administration" | "alert" | "brand" | "chevron" | "logout" | "menu" | "settings";

const paths: Readonly<Record<IconName, ReactNode>> = {
	account: (
		<>
			<circle cx="12" cy="8" r="3" />
			<path d="M5 20c.6-4 2.9-6 7-6s6.4 2 7 6" />
		</>
	),
	administration: (
		<>
			<path d="M4 19V8l8-4 8 4v11" />
			<path d="M8 19v-6h8v6M3 20h18" />
		</>
	),
	alert: (
		<>
			<path d="M12 3 2.8 20h18.4L12 3Z" />
			<path d="M12 9v5M12 17h.01" />
		</>
	),
	brand: (
		<>
			<path d="m5 15 2-7 5 4 5-4 2 7-7 3-7-3Z" />
			<path d="M7 8 5 5M17 8l2-3M12 12V5" />
		</>
	),
	chevron: <path d="m9 5 7 7-7 7" />,
	logout: (
		<>
			<path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9" />
		</>
	),
	menu: <path d="M4 7h16M4 12h16M4 17h16" />,
	settings: (
		<>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
		</>
	),
};

export function Icon({
	name,
	label,
	size = 20,
}: {
	readonly name: IconName;
	readonly label?: string;
	readonly size?: number;
}) {
	return (
		<svg
			className="icon"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
			role={label ? "img" : undefined}
			aria-hidden={label ? undefined : true}
			aria-label={label}
		>
			{paths[name]}
		</svg>
	);
}
