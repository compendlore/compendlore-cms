import {
	Component,
	createElement,
	useId,
	type ButtonHTMLAttributes,
	type InputHTMLAttributes,
	type ReactNode,
	type SelectHTMLAttributes,
} from "react";

export type ButtonTone = "danger" | "default" | "primary" | "secondary";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	readonly tone?: ButtonTone;
}

export function Button({
	tone = "default",
	className = "",
	type = "button",
	...props
}: ButtonProps) {
	return <button type={type} className={`button button--${tone} ${className}`.trim()} {...props} />;
}

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
	readonly label: ReactNode;
	readonly hint?: ReactNode;
	readonly error?: ReactNode;
}

export function Field({ label, hint, error, className = "", id, ...props }: FieldProps) {
	const generatedId = useId();
	const inputId = id ?? generatedId;
	const descriptionId = hint || error ? `${inputId}-description` : undefined;
	return (
		<label className={`field ${error ? "field--error" : ""} ${className}`.trim()} htmlFor={inputId}>
			<span className="field__label">{label}</span>
			<input
				id={inputId}
				aria-describedby={descriptionId}
				aria-invalid={Boolean(error)}
				{...props}
			/>
			{hint || error ? (
				<small id={descriptionId} className="field__description">
					{error ?? hint}
				</small>
			) : null}
		</label>
	);
}

export interface SelectOption {
	readonly value: string;
	readonly label: ReactNode;
}

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
	readonly label: ReactNode;
	readonly options: readonly SelectOption[];
	readonly hint?: ReactNode;
}

export function SelectField({
	label,
	options,
	hint,
	className = "",
	id,
	...props
}: SelectFieldProps) {
	const generatedId = useId();
	const selectId = id ?? generatedId;
	return (
		<label className={`field ${className}`.trim()} htmlFor={selectId}>
			<span className="field__label">{label}</span>
			<select id={selectId} {...props}>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
			{hint ? <small className="field__description">{hint}</small> : null}
		</label>
	);
}

export interface SwitchProps {
	readonly checked: boolean;
	readonly label: ReactNode;
	readonly disabled?: boolean;
	readonly onChange: (checked: boolean) => void;
}

export function Switch({ checked, label, disabled, onChange }: SwitchProps) {
	return (
		<label className="switch">
			<input
				type="checkbox"
				role="switch"
				checked={checked}
				disabled={disabled}
				onChange={(event) => onChange(event.target.checked)}
			/>
			<span className="switch__track" aria-hidden="true">
				<span />
			</span>
			<span>{label}</span>
		</label>
	);
}

export interface TabDefinition {
	readonly id: string;
	readonly label: ReactNode;
	readonly content: ReactNode;
	readonly disabled?: boolean;
}

export function Tabs({
	tabs,
	activeId,
	onChange,
}: {
	readonly tabs: readonly TabDefinition[];
	readonly activeId: string;
	readonly onChange: (identifier: string) => void;
}) {
	const generatedId = useId();
	const active =
		tabs.find((tab) => tab.id === activeId && !tab.disabled) ?? tabs.find((tab) => !tab.disabled);
	if (!active) return <Notice tone="warning">Aucun onglet n’est actuellement disponible.</Notice>;
	return (
		<section className="tabs">
			<div className="tabs__list" role="tablist">
				{tabs.map((tab) => (
					<button
						type="button"
						key={tab.id}
						id={`${generatedId}-${tab.id}-tab`}
						role="tab"
						aria-selected={tab.id === active.id}
						aria-controls={`${generatedId}-${tab.id}-panel`}
						disabled={tab.disabled}
						onClick={() => onChange(tab.id)}
					>
						{tab.label}
					</button>
				))}
			</div>
			<div
				className="tabs__panel"
				id={`${generatedId}-${active.id}-panel`}
				role="tabpanel"
				aria-labelledby={`${generatedId}-${active.id}-tab`}
			>
				{active.content}
			</div>
		</section>
	);
}

export interface ModalProps {
	readonly open: boolean;
	readonly eyebrow?: ReactNode;
	readonly title: ReactNode;
	readonly children: ReactNode;
	readonly actions?: ReactNode;
	readonly onClose: () => void;
}

export function Modal({ open, eyebrow, title, children, actions, onClose }: ModalProps) {
	if (!open) return null;
	return (
		<div
			className="modal-backdrop"
			role="presentation"
			onMouseDown={(event) => event.target === event.currentTarget && onClose()}
		>
			<section className="modal" role="dialog" aria-modal="true" aria-labelledby="cms-modal-title">
				<header>
					<div>
						{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
						<h2 id="cms-modal-title">{title}</h2>
					</div>
					<Button aria-label="Fermer" onClick={onClose}>
						×
					</Button>
				</header>
				<div className="modal__content">{children}</div>
				{actions ? <footer>{actions}</footer> : null}
			</section>
		</div>
	);
}

export interface TableColumn<Row> {
	readonly key: string;
	readonly title: ReactNode;
	readonly render: (row: Row) => ReactNode;
	readonly align?: "center" | "end" | "start";
}

export function Table<Row>({
	caption,
	columns,
	rows,
	rowKey,
	emptyLabel = "Aucun résultat.",
}: {
	readonly caption?: string;
	readonly columns: readonly TableColumn<Row>[];
	readonly rows: readonly Row[];
	readonly rowKey: (row: Row) => string;
	readonly emptyLabel?: ReactNode;
}) {
	return (
		<div className="table-scroll">
			<table className="table">
				{caption ? <caption>{caption}</caption> : null}
				<thead>
					<tr>
						{columns.map((column) => (
							<th key={column.key} data-align={column.align ?? "start"}>
								{column.title}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.length ? (
						rows.map((row) => (
							<tr key={rowKey(row)}>
								{columns.map((column) => (
									<td key={column.key} data-align={column.align ?? "start"}>
										{column.render(row)}
									</td>
								))}
							</tr>
						))
					) : (
						<tr>
							<td colSpan={Math.max(columns.length, 1)} className="table__empty">
								{emptyLabel}
							</td>
						</tr>
					)}
				</tbody>
			</table>
		</div>
	);
}

export function Card({
	eyebrow,
	title,
	description,
	children,
	action,
	titleAs = "h2",
}: {
	readonly eyebrow?: ReactNode;
	readonly title: ReactNode;
	readonly description?: ReactNode;
	readonly children?: ReactNode;
	readonly action?: ReactNode;
	readonly titleAs?: "h2" | "h3";
}) {
	return (
		<article className="card">
			{eyebrow ? <p className="card__eyebrow">{eyebrow}</p> : null}
			{createElement(titleAs, { className: "card__title" }, title)}
			{description ? <p className="card__description">{description}</p> : null}
			{children ? <div className="card__content">{children}</div> : null}
			{action ? <footer className="card__action">{action}</footer> : null}
		</article>
	);
}

export function Notice({
	tone = "information",
	title,
	children,
}: {
	readonly tone?: "danger" | "information" | "success" | "warning";
	readonly title?: ReactNode;
	readonly children: ReactNode;
}) {
	return (
		<aside className={`notice notice--${tone}`} role={tone === "danger" ? "alert" : "status"}>
			{title ? <strong>{title}</strong> : null}
			<div>{children}</div>
		</aside>
	);
}

export function LoadingScreen({
	title = "Chargement",
	message,
}: {
	readonly title?: ReactNode;
	readonly message?: ReactNode;
}) {
	return (
		<div className="loading-screen" role="status" aria-live="polite">
			<div className="loading-screen__spinner" aria-hidden="true" />
			<p className="eyebrow">Lore &amp; Dice CMS</p>
			<h1>{title}</h1>
			{message ? <p>{message}</p> : null}
		</div>
	);
}

interface ErrorBoundaryState {
	readonly failed: boolean;
}

export class ApplicationErrorBoundary extends Component<
	{ readonly children: ReactNode; readonly fallback?: ReactNode },
	ErrorBoundaryState
> {
	override state: ErrorBoundaryState = { failed: false };
	static getDerivedStateFromError(): ErrorBoundaryState {
		return { failed: true };
	}
	override render(): ReactNode {
		if (!this.state.failed) return this.props.children;
		return (
			this.props.fallback ?? (
				<main className="error-page">
					<p className="eyebrow">Erreur d’affichage</p>
					<h1>Cette page ne peut pas être affichée.</h1>
					<p>Rechargez la page pour réessayer.</p>
					<Button tone="primary" onClick={() => window.location.reload()}>
						Recharger la page
					</Button>
				</main>
			)
		);
	}
}
