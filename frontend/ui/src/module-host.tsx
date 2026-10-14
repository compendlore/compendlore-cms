import { Component, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { Notice } from "./primitives.js";

export type FrontendContributionKind = "action" | "component" | "form" | "menu" | "page" | "route";

export interface FrontendSessionContext {
	readonly status: "anonymous" | "authenticated";
	readonly subjectIdentifier?: string;
	readonly roles: readonly string[];
	readonly capabilities: ReadonlySet<string>;
}

export interface FrontendModuleContext {
	readonly capabilities: ReadonlySet<string>;
	readonly locale: string;
	readonly session: FrontendSessionContext;
}

export interface FrontendModuleProps {
	readonly context: FrontendModuleContext;
	readonly state?: unknown | undefined;
	readonly onStateChange?: ((state: unknown) => void) | undefined;
}

export interface FrontendContribution {
	readonly identifier: string;
	readonly kind: FrontendContributionKind;
	readonly path?: string;
	readonly requiredCapability?: string;
	readonly component: ComponentType<FrontendModuleProps>;
}

const moduleMessages = {
	fr: {
		title: "Module indisponible",
		description:
			"Le contenu demandé n’est pas installé ou vous ne disposez pas de la capacité nécessaire. Vos données locales sont conservées.",
	},
	en: {
		title: "Module unavailable",
		description:
			"The requested content is not installed or you do not have the required capability. Your local data has been preserved.",
	},
} as const;

export class FrontendModuleRegistry {
	private readonly contributions = new Map<string, FrontendContribution>();

	register(contribution: FrontendContribution): void {
		if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(contribution.identifier))
			throw new Error("The frontend contribution identifier is invalid.");
		if (this.contributions.has(contribution.identifier))
			throw new Error(`The frontend contribution ${contribution.identifier} already exists.`);
		if (contribution.kind === "route" && (!contribution.path || !contribution.path.startsWith("/")))
			throw new Error("A frontend route must declare an absolute path.");
		if (
			contribution.kind === "route" &&
			[...this.contributions.values()].some(
				(candidate) => candidate.kind === "route" && candidate.path === contribution.path,
			)
		)
			throw new Error(`The frontend route ${contribution.path} already exists.`);
		this.contributions.set(contribution.identifier, Object.freeze({ ...contribution }));
	}

	resolve(identifier: string, capabilities: ReadonlySet<string>): FrontendContribution | undefined {
		const contribution = this.contributions.get(identifier);
		if (!contribution || !hasCapability(capabilities, contribution.requiredCapability))
			return undefined;
		return contribution;
	}

	resolveRoute(path: string, capabilities: ReadonlySet<string>): FrontendContribution | undefined {
		return [...this.contributions.values()].find(
			(contribution) =>
				contribution.kind === "route" &&
				contribution.path === path &&
				hasCapability(capabilities, contribution.requiredCapability),
		);
	}

	list(
		kind: FrontendContributionKind,
		capabilities: ReadonlySet<string>,
	): readonly FrontendContribution[] {
		return [...this.contributions.values()].filter(
			(contribution) =>
				contribution.kind === kind && hasCapability(capabilities, contribution.requiredCapability),
		);
	}
}

function hasCapability(capabilities: ReadonlySet<string>, required?: string): boolean {
	return !required || capabilities.has("*") || capabilities.has(required);
}

interface ModuleErrorBoundaryProps {
	readonly children: ReactNode;
	readonly fallback: ReactNode;
	readonly identifier: string;
	readonly onError?: ((identifier: string, error: unknown) => void) | undefined;
}

class ModuleErrorBoundary extends Component<ModuleErrorBoundaryProps, { failed: boolean }> {
	override state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	override componentDidCatch(error: unknown, _errorInfo: ErrorInfo): void {
		if (this.props.onError) {
			this.props.onError(this.props.identifier, error);
			return;
		}
		console.error("Frontend module rendering failed.", {
			identifier: this.props.identifier,
			errorName: error instanceof Error ? error.name : "UnknownError",
		});
	}

	override render(): ReactNode {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

function defaultFallback(locale: string): ReactNode {
	const messages = locale.toLowerCase().startsWith("fr") ? moduleMessages.fr : moduleMessages.en;
	return (
		<Notice tone="warning" title={messages.title}>
			{messages.description}
		</Notice>
	);
}

export function ModuleOutlet({
	contribution,
	context,
	state,
	onStateChange,
	fallback,
	onError,
}: {
	readonly contribution?: FrontendContribution | undefined;
	readonly context: FrontendModuleContext;
	readonly state?: unknown | undefined;
	readonly onStateChange?: ((state: unknown) => void) | undefined;
	readonly fallback?: ReactNode | undefined;
	readonly onError?: ((identifier: string, error: unknown) => void) | undefined;
}) {
	const unavailable = fallback ?? defaultFallback(context.locale);
	if (!contribution) return unavailable;
	const Component = contribution.component;
	return (
		<ModuleErrorBoundary
			key={contribution.identifier}
			identifier={contribution.identifier}
			fallback={unavailable}
			onError={onError}
		>
			<Component context={context} state={state} onStateChange={onStateChange} />
		</ModuleErrorBoundary>
	);
}
