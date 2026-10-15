import type { ContributionOwner, ContributionState, ContributionType } from "./contracts.js";
import { RegistryError } from "./errors.js";
import type { CmsRegistry, RegistryMutationContext } from "./registry.js";

export type RegistryAdministrationAction = "activate" | "disable" | "repair" | "withdraw";

export interface RegistryAdministrationPrincipal {
	readonly capabilities: ReadonlySet<string>;
	readonly owner: ContributionOwner;
	readonly actorId?: string;
}

export interface RegistryAdministrationItem {
	readonly key: string;
	readonly identifier: string;
	readonly type: ContributionType;
	readonly state: ContributionState;
	readonly version: string;
	readonly owner: ContributionOwner;
	readonly locked: boolean;
	readonly dependencies: readonly string[];
	readonly dependents: readonly string[];
	readonly blockers: readonly string[];
	readonly allowedActions: readonly RegistryAdministrationAction[];
	readonly error?: string;
}

export interface RegistryAdministrationProjection {
	readonly generatedAt: string;
	readonly contributions: readonly RegistryAdministrationItem[];
}

export class RegistryAdministrationService {
	constructor(private readonly registry: CmsRegistry) {}

	async project(
		principal: RegistryAdministrationPrincipal,
	): Promise<RegistryAdministrationProjection> {
		this.authorize(principal, "core.registry.inspect");
		const catalog = await this.registry.catalog();
		const contributions = await Promise.all(
			catalog.contributions.map(async (contribution) => {
				const inspection = await this.registry.inspect(contribution.key);
				const locked =
					contribution.owner.kind === "core" || contribution.withdrawalPolicy === "block-uninstall";
				return {
					key: contribution.key,
					identifier: contribution.identifier,
					type: contribution.type,
					state: contribution.state,
					version: contribution.version,
					owner: contribution.owner,
					locked,
					dependencies: inspection.dependencies,
					dependents: inspection.dependents,
					blockers: inspection.blockers,
					allowedActions: this.allowedActions(
						contribution.state,
						locked,
						inspection.blockers,
						principal,
						contribution.owner,
					),
					...(contribution.failureReason && this.has(principal, "core.registry.diagnostics")
						? { error: contribution.failureReason }
						: {}),
				};
			}),
		);
		return {
			generatedAt: catalog.generatedAt.toISOString(),
			contributions: contributions.sort((left, right) => left.key.localeCompare(right.key)),
		};
	}

	async execute(
		key: string,
		action: RegistryAdministrationAction,
		principal: RegistryAdministrationPrincipal,
	): Promise<void> {
		this.authorize(principal, "core.registry.mutate");
		const projection = await this.project(principal);
		const contribution = projection.contributions.find((item) => item.key === key);
		if (!contribution || !contribution.allowedActions.includes(action)) {
			throw new RegistryError("registry.owner_denied", "The registry owner denied the operation.");
		}
		const context: RegistryMutationContext = {
			requester: principal.owner,
			...(principal.actorId ? { actorId: principal.actorId } : {}),
		};
		if (action === "activate") await this.registry.activate(key, context);
		if (action === "disable") await this.registry.disable(key, context);
		if (action === "repair") await this.registry.repair(key, context);
		if (action === "withdraw") await this.registry.withdraw(key, context);
	}

	private allowedActions(
		state: ContributionState,
		locked: boolean,
		blockers: readonly string[],
		principal: RegistryAdministrationPrincipal,
		owner: ContributionOwner,
	): readonly RegistryAdministrationAction[] {
		if (
			locked ||
			!this.has(principal, "core.registry.mutate") ||
			!sameOwner(principal.owner, owner)
		)
			return [];
		const actions: RegistryAdministrationAction[] = [];
		if (["disabled", "discovered", "registered"].includes(state) && blockers.length === 0)
			actions.push("activate");
		if (state === "active" && blockers.length === 0) actions.push("disable");
		if (state === "failed") actions.push("repair");
		if (
			["active", "disabled", "discovered", "failed", "registered"].includes(state) &&
			blockers.length === 0
		)
			actions.push("withdraw");
		return actions;
	}

	private authorize(principal: RegistryAdministrationPrincipal, capability: string): void {
		if (!this.has(principal, capability)) {
			throw new RegistryError("registry.capability_denied", "The required capability was denied.");
		}
	}

	private has(principal: RegistryAdministrationPrincipal, capability: string): boolean {
		return principal.capabilities.has("*") || principal.capabilities.has(capability);
	}
}

function sameOwner(first: ContributionOwner, second: ContributionOwner): boolean {
	return first.kind === second.kind && first.identifier === second.identifier;
}
