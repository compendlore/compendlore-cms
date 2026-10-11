import type { ComponentType, ReactNode } from "react";
import { Notice } from "./primitives.js";

export type FrontendContributionKind = "action" | "component" | "form" | "menu" | "page" | "route";

export interface FrontendModuleContext {
	readonly capabilities: ReadonlySet<string>;
	readonly locale: string;
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

export class FrontendModuleRegistry {
	private readonly contributions = new Map<string, FrontendContribution>();

	register(contribution: FrontendContribution): void {
		if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(contribution.identifier))
			throw new Error("L’identifiant frontend est invalide.");
		if (this.contributions.has(contribution.identifier))
			throw new Error(`La contribution ${contribution.identifier} existe déjà.`);
		if (contribution.kind === "route" && (!contribution.path || !contribution.path.startsWith("/")))
			throw new Error("Une route frontend doit déclarer un chemin absolu.");
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

export function ModuleOutlet({
	contribution,
	context,
	state,
	onStateChange,
	fallback,
}: {
	readonly contribution?: FrontendContribution | undefined;
	readonly context: FrontendModuleContext;
	readonly state?: unknown | undefined;
	readonly onStateChange?: ((state: unknown) => void) | undefined;
	readonly fallback?: ReactNode | undefined;
}) {
	if (!contribution)
		return (
			fallback ?? (
				<Notice tone="warning" title="Module indisponible">
					Le contenu demandé n’est pas installé ou vous ne disposez pas de la capacité nécessaire.
					Vos données locales sont conservées.
				</Notice>
			)
		);
	const Component = contribution.component;
	return <Component context={context} state={state} onStateChange={onStateChange} />;
}
