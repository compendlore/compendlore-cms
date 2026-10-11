import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from "react";

export interface DateTimePickerLabels {
	readonly chooseDate: string;
	readonly previousMonth: string;
	readonly nextMonth: string;
	readonly today: string;
	readonly clear: string;
	readonly hour: string;
	readonly minute: string;
}

export interface DateTimePickerProps {
	readonly value?: string;
	readonly locale: string;
	readonly minimum?: Date;
	readonly maximum?: Date;
	readonly labels?: Partial<DateTimePickerLabels>;
	readonly onChange: (value: string) => void;
}

const defaultLabels: DateTimePickerLabels = {
	chooseDate: "Choisir une date et une heure",
	previousMonth: "Mois précédent",
	nextMonth: "Mois suivant",
	today: "Aujourd’hui",
	clear: "Effacer",
	hour: "Heure",
	minute: "Minute",
};

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function sameDay(left: Date, right: Date): boolean {
	return startOfDay(left).getTime() === startOfDay(right).getTime();
}

function parsedDate(value?: string): Date | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function TimeWheel({
	label,
	values,
	value,
	disabled,
	onChange,
}: {
	readonly label: string;
	readonly values: readonly number[];
	readonly value: number;
	readonly disabled: boolean;
	readonly onChange: (value: number) => void;
}) {
	const root = useRef<HTMLDivElement>(null);
	const currentIndex = Math.max(0, values.indexOf(value));
	const currentIndexRef = useRef(currentIndex);
	const gesture = useRef<{ pointerId: number; y: number; distance: number } | undefined>(undefined);
	const [dragging, setDragging] = useState(false);
	currentIndexRef.current = currentIndex;

	const move = (direction: number) => {
		if (disabled) return;
		const next = (currentIndexRef.current + direction + values.length) % values.length;
		currentIndexRef.current = next;
		onChange(values[next] ?? value);
	};

	useEffect(() => {
		const element = root.current;
		if (!element) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			if (event.deltaY) move(event.deltaY > 0 ? 1 : -1);
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	});

	const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
		gesture.current = { pointerId: event.pointerId, y: event.clientY, distance: 0 };
		event.currentTarget.setPointerCapture(event.pointerId);
		setDragging(true);
	};

	const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
		const current = gesture.current;
		if (!current || current.pointerId !== event.pointerId) return;
		event.preventDefault();
		current.distance += current.y - event.clientY;
		current.y = event.clientY;
		while (Math.abs(current.distance) >= 24) {
			const direction = current.distance > 0 ? 1 : -1;
			move(direction);
			current.distance -= direction * 24;
		}
	};

	const stopDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (gesture.current?.pointerId !== event.pointerId) return;
		gesture.current = undefined;
		setDragging(false);
		if (event.currentTarget.hasPointerCapture(event.pointerId))
			event.currentTarget.releasePointerCapture(event.pointerId);
	};

	return (
		<div
			ref={root}
			className={`time-wheel ${dragging ? "time-wheel--dragging" : ""}`}
			aria-label={label}
			aria-disabled={disabled}
			onPointerDown={beginDrag}
			onPointerMove={drag}
			onPointerUp={stopDrag}
			onPointerCancel={stopDrag}
		>
			<span className="time-wheel__label">{label}</span>
			<div className="time-wheel__values">
				{[-2, -1, 0, 1, 2].map((offset) => {
					const item = values[(currentIndex + offset + values.length) % values.length] ?? value;
					return (
						<button
							type="button"
							key={`${offset}-${item}`}
							disabled={disabled}
							className={offset === 0 ? "is-current" : ""}
							onClick={() => onChange(item)}
						>
							{String(item).padStart(2, "0")}
						</button>
					);
				})}
			</div>
		</div>
	);
}

export function DateTimePicker({
	value,
	locale,
	minimum,
	maximum,
	labels: customLabels,
	onChange,
}: DateTimePickerProps) {
	const labels = { ...defaultLabels, ...customLabels };
	const selected = parsedDate(value);
	const today = startOfDay(new Date());
	const earliest = minimum ?? new Date(today.getFullYear() - 5, 0, 1);
	const latest = maximum ?? new Date(today.getFullYear() + 5, 11, 31, 23, 59);
	const [open, setOpen] = useState(false);
	const [visibleMonth, setVisibleMonth] = useState(
		() => new Date((selected ?? today).getFullYear(), (selected ?? today).getMonth(), 1),
	);
	const root = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const close = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", close);
		return () => document.removeEventListener("pointerdown", close);
	}, [open]);

	const days = useMemo(() => {
		const first = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
		const offset = (first.getDay() + 6) % 7;
		const gridStart = new Date(first.getFullYear(), first.getMonth(), first.getDate() - offset);
		return Array.from(
			{ length: 42 },
			(_, index) =>
				new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index),
		);
	}, [visibleMonth]);

	const weekdays = useMemo(
		() =>
			Array.from({ length: 7 }, (_, index) =>
				new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, index + 1)),
			),
		[locale],
	);
	const commit = (date: Date, hour: number, minute: number) => {
		const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
		const bounded = candidate < earliest ? earliest : candidate > latest ? latest : candidate;
		onChange(bounded.toISOString());
	};
	const hour = selected?.getHours() ?? 12;
	const minute = selected?.getMinutes() ?? 0;
	const display = selected
		? new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" }).format(selected)
		: labels.chooseDate;

	return (
		<div className="date-time-picker" ref={root}>
			<button
				type="button"
				className="date-time-picker__trigger"
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
			>
				<span className={selected ? "" : "is-placeholder"}>{display}</span>
				<span aria-hidden="true">▣</span>
			</button>
			{open ? (
				<section className="calendar" role="dialog" aria-label={labels.chooseDate}>
					<header>
						<button
							type="button"
							aria-label={labels.previousMonth}
							onClick={() =>
								setVisibleMonth(
									(current) => new Date(current.getFullYear(), current.getMonth() - 1, 1),
								)
							}
						>
							‹
						</button>
						<strong>
							{new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(
								visibleMonth,
							)}
						</strong>
						<button
							type="button"
							aria-label={labels.nextMonth}
							onClick={() =>
								setVisibleMonth(
									(current) => new Date(current.getFullYear(), current.getMonth() + 1, 1),
								)
							}
						>
							›
						</button>
					</header>
					<div className="calendar__layout">
						<div className="calendar__grid">
							{weekdays.map((weekday, index) => (
								<small key={`${weekday}-${index}`}>{weekday}</small>
							))}
							{days.map((day) => {
								const disabled = day < startOfDay(earliest) || day > startOfDay(latest);
								return (
									<button
										type="button"
										key={day.toISOString()}
										disabled={disabled}
										className={[
											day.getMonth() !== visibleMonth.getMonth() ? "is-outside" : "",
											selected && sameDay(day, selected) ? "is-selected" : "",
											sameDay(day, today) ? "is-today" : "",
										]
											.filter(Boolean)
											.join(" ")}
										onClick={() => commit(day, hour, minute)}
									>
										{day.getDate()}
									</button>
								);
							})}
						</div>
						<div className="calendar__time">
							<TimeWheel
								label={labels.hour}
								values={Array.from({ length: 24 }, (_, index) => index)}
								value={hour}
								disabled={!selected}
								onChange={(next) => selected && commit(selected, next, minute)}
							/>
							<TimeWheel
								label={labels.minute}
								values={Array.from({ length: 60 }, (_, index) => index)}
								value={minute}
								disabled={!selected}
								onChange={(next) => selected && commit(selected, hour, next)}
							/>
						</div>
					</div>
					<footer>
						<button type="button" onClick={() => commit(today, hour, minute)}>
							{labels.today}
						</button>
						<button type="button" onClick={() => onChange("")}>
							{labels.clear}
						</button>
					</footer>
				</section>
			) : null}
		</div>
	);
}
