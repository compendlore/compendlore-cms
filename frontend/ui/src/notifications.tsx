import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./icons.js";
import { Button, Notice } from "./primitives.js";

export type NativeNotificationPresentation = "silent" | "toast" | "banner" | "inbox" | "popup";
export type NativeNotificationTone = "information" | "success" | "warning" | "danger";

export interface NativeNotification {
	readonly id: string;
	readonly title: string;
	readonly message: string;
	readonly presentation: NativeNotificationPresentation;
	readonly tone: NativeNotificationTone;
	readonly occurredAt: string;
	readonly read: boolean;
	readonly displayDurationMs?: number;
}

export interface NotificationPage {
	readonly items: readonly NativeNotification[];
	readonly nextCursor?: string;
}

const presentations = new Set<NativeNotificationPresentation>([
	"silent",
	"toast",
	"banner",
	"inbox",
	"popup",
]);
const tones = new Set<NativeNotificationTone>(["information", "success", "warning", "danger"]);
const activeContent = /<[^>]+>|(?:javascript|data):|https?:\/\//iu;

export function parseNativeNotification(value: unknown): NativeNotification {
	if (!isRecord(value)) throw new Error("Notification payload must be an object.");
	const allowed = new Set([
		"id",
		"title",
		"message",
		"presentation",
		"tone",
		"occurredAt",
		"read",
		"displayDurationMs",
	]);
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new Error("Notification payload contains an unknown field.");
	const id = safeText(value.id, "identifier");
	const title = safeText(value.title, "title");
	const message = safeText(value.message, "message");
	if (!presentations.has(value.presentation as NativeNotificationPresentation))
		throw new Error("Notification presentation is not supported.");
	if (!tones.has(value.tone as NativeNotificationTone))
		throw new Error("Notification tone is not supported.");
	if (typeof value.occurredAt !== "string" || !Number.isFinite(Date.parse(value.occurredAt)))
		throw new Error("Notification date is invalid.");
	if (typeof value.read !== "boolean") throw new Error("Notification read state is invalid.");
	if (
		value.displayDurationMs !== undefined &&
		(typeof value.displayDurationMs !== "number" ||
			!Number.isInteger(value.displayDurationMs) ||
			value.displayDurationMs < 0 ||
			value.displayDurationMs > 120_000)
	)
		throw new Error("Notification display duration is invalid.");
	return Object.freeze({
		id,
		title,
		message,
		presentation: value.presentation as NativeNotificationPresentation,
		tone: value.tone as NativeNotificationTone,
		occurredAt: value.occurredAt,
		read: value.read,
		...(value.displayDurationMs === undefined
			? {}
			: { displayDurationMs: value.displayDurationMs }),
	});
}

export interface NotificationHubLabels {
	readonly button: string;
	readonly panel: string;
	readonly markAllRead: string;
	readonly close: string;
}

export function NotificationHub({
	initialNotifications = [],
	locale,
	labels,
	maxVisible = 5,
	eventName = "compendlore:notification",
}: {
	readonly initialNotifications?: readonly NativeNotification[];
	readonly locale: string;
	readonly labels: NotificationHubLabels;
	readonly maxVisible?: number;
	readonly eventName?: string;
}) {
	const visibleLimit = Math.max(1, Math.min(10, Math.trunc(maxVisible)));
	const [notifications, setNotifications] =
		useState<readonly NativeNotification[]>(initialNotifications);
	const [floatingIds, setFloatingIds] = useState<readonly string[]>(
		initialNotifications
			.filter((notification) => !notification.read && notification.presentation !== "silent")
			.slice(0, 3)
			.map((notification) => notification.id),
	);
	const [open, setOpen] = useState(false);
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		const receive = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			try {
				const notification = parseNativeNotification(event.detail);
				setNotifications((current) => [
					notification,
					...current.filter((item) => item.id !== notification.id),
				]);
				if (!notification.read && notification.presentation !== "silent")
					setFloatingIds((current) =>
						[notification.id, ...current.filter((id) => id !== notification.id)].slice(0, 3),
					);
			} catch (error) {
				console.error("Incoming notification was rejected.", {
					errorName: error instanceof Error ? error.name : "UnknownError",
				});
			}
		};
		window.addEventListener(eventName, receive);
		return () => window.removeEventListener(eventName, receive);
	}, [eventName]);

	useEffect(() => {
		const timers = floatingIds.flatMap((id) => {
			const notification = notifications.find((item) => item.id === id);
			const duration = notification?.displayDurationMs ?? 5_000;
			if (duration === 0) return [];
			return [
				window.setTimeout(
					() => setFloatingIds((current) => current.filter((candidate) => candidate !== id)),
					duration,
				),
			];
		});
		return () => timers.forEach((timer) => window.clearTimeout(timer));
	}, [floatingIds, notifications]);

	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 15_000);
		return () => window.clearInterval(timer);
	}, []);

	const visibleNotifications = notifications
		.filter((notification) => notification.presentation !== "silent")
		.slice(0, visibleLimit);
	const unreadCount = notifications.filter(
		(notification) => !notification.read && notification.presentation !== "silent",
	).length;
	const floatingNotifications = floatingIds.flatMap((id) => {
		const notification = notifications.find((item) => item.id === id);
		return notification ? [notification] : [];
	});
	const markRead = (id: string) => {
		setNotifications((current) =>
			current.map((notification) =>
				notification.id === id ? { ...notification, read: true } : notification,
			),
		);
		setFloatingIds((current) => current.filter((candidate) => candidate !== id));
	};
	const markAllRead = () => {
		setNotifications((current) => current.map((notification) => ({ ...notification, read: true })));
		setFloatingIds([]);
		setOpen(false);
	};

	return (
		<div className="notification-hub">
			<div className="notification-floats" aria-live="polite" aria-relevant="additions">
				{floatingNotifications.map((notification) => (
					<button
						className={`notification-float notification-float--${notification.tone}`}
						key={notification.id}
						type="button"
						onClick={() => markRead(notification.id)}
						aria-label={`${notification.title}. ${labels.close}`}
					>
						<NotificationFrameContent notification={notification} locale={locale} now={now} />
					</button>
				))}
			</div>
			{unreadCount > 0 ? (
				<button
					className="notification-bell"
					type="button"
					onClick={() => setOpen((current) => !current)}
					aria-expanded={open}
					aria-controls="notification-panel"
					aria-label={`${labels.button} (${unreadCount})`}
				>
					<Icon name="bell" />
					<span aria-hidden="true">{unreadCount}</span>
				</button>
			) : null}
			{open && unreadCount > 0 ? (
				<section id="notification-panel" className="notification-panel" aria-label={labels.panel}>
					<header>
						<strong>{labels.panel}</strong>
						<Button onClick={markAllRead}>{labels.markAllRead}</Button>
					</header>
					<ul className="notification-center__list">
						{visibleNotifications.map((notification) => (
							<li key={notification.id}>
								<button
									className={`notification-panel__item notification-panel__item--${notification.tone}`}
									type="button"
									onClick={() => markRead(notification.id)}
								>
									<NotificationFrameContent notification={notification} locale={locale} now={now} />
								</button>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</div>
	);
}

function NotificationFrameContent({
	notification,
	locale,
	now,
}: {
	readonly notification: NativeNotification;
	readonly locale: string;
	readonly now: number;
}) {
	return (
		<>
			<strong className="notification-frame__title">{notification.title}</strong>
			<time className="notification-frame__time" dateTime={notification.occurredAt}>
				{formatNotificationTime(notification.occurredAt, locale, now)}
			</time>
			<span className="notification-frame__message">{notification.message}</span>
		</>
	);
}

export function formatNotificationTime(
	occurredAt: string,
	locale: string,
	now = Date.now(),
): string {
	const occurredAtMs = Date.parse(occurredAt);
	const elapsedSeconds = Math.max(0, Math.floor((now - occurredAtMs) / 1_000));
	const relative = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
	if (elapsedSeconds < 60) return sentenceCase(relative.format(-elapsedSeconds, "second"), locale);
	if (elapsedSeconds < 3_600)
		return sentenceCase(relative.format(-Math.floor(elapsedSeconds / 60), "minute"), locale);
	return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
		new Date(occurredAtMs),
	);
}

function sentenceCase(value: string, locale: string): string {
	const [first = "", ...rest] = [...value];
	return `${first.toLocaleUpperCase(locale)}${rest.join("")}`;
}

export function paginateNotifications(
	items: readonly NativeNotification[],
	cursor?: string,
	requestedLimit = 20,
): NotificationPage {
	const limit = Number.isFinite(requestedLimit)
		? Math.max(1, Math.min(50, Math.trunc(requestedLimit)))
		: 20;
	const start = cursor === undefined ? 0 : items.findIndex((item) => item.id === cursor) + 1;
	if (cursor !== undefined && start === 0) throw new Error("Notification cursor is invalid.");
	const pageItems = items.slice(start, start + limit);
	const last = pageItems.at(-1);
	return Object.freeze({
		items: Object.freeze(pageItems),
		...(last && start + pageItems.length < items.length ? { nextCursor: last.id } : {}),
	});
}

export function NotificationCenter({
	page,
	locale,
	onNextPage,
	nextPageLabel,
}: {
	readonly page: NotificationPage;
	readonly locale: string;
	readonly onNextPage?: () => void;
	readonly nextPageLabel: string;
}) {
	return (
		<section className="notification-center" aria-label="Notifications">
			<ul className="notification-center__list">
				{page.items
					.filter((notification) => notification.presentation !== "silent")
					.map((notification) => (
						<li key={notification.id}>
							<NativeNotificationView notification={notification} locale={locale} />
						</li>
					))}
			</ul>
			{page.nextCursor && onNextPage ? <Button onClick={onNextPage}>{nextPageLabel}</Button> : null}
		</section>
	);
}

export function NativeNotificationView({
	notification,
	locale,
}: {
	readonly notification: NativeNotification;
	readonly locale: string;
}): ReactNode {
	if (notification.presentation === "silent") return null;
	const content = (
		<>
			<p>{notification.message}</p>
			<time dateTime={notification.occurredAt}>
				{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
					new Date(notification.occurredAt),
				)}
			</time>
		</>
	);
	return (
		<div
			className={`native-notification native-notification--${notification.presentation}`}
			data-read={notification.read ? "true" : "false"}
			role={notification.presentation === "popup" ? "dialog" : undefined}
			aria-modal={notification.presentation === "popup" ? true : undefined}
		>
			<Notice tone={notification.tone} title={notification.title}>
				{content}
			</Notice>
		</div>
	);
}

function safeText(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		value.length > 500 ||
		activeContent.test(value)
	)
		throw new Error(`Notification ${label} must contain safe plain text.`);
	return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
