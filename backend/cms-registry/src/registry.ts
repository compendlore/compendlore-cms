import type {
	RegisteredMethodInvocation,
	RegisteredMethodInvoker,
	RegistryCorePort,
	RegistryMutationAction,
} from "../../core/src/index.js";
import {
	contributionKey,
	sameOwner,
	type ContributionDefinition,
	type ContributionInspection,
	type ContributionOwner,
	type ContributionState,
	type ContributionType,
	type RegistryCatalog,
	type StoredContribution,
} from "./contracts.js";
import { RegistryMethodDispatcher, type RegisteredMethodHandler } from "./dispatcher.js";
import { RegistryError } from "./errors.js";
import { ContributionGraph } from "./graph.js";
import { InMemoryRegistryRepository, type RegistryRepository } from "./repository.js";
import {
	compareSemver,
	toMutationCandidate,
	validateContributionDefinition,
} from "./validation.js";

const contributionTypes: readonly ContributionType[] = [
	"api-endpoint",
	"configuration",
	"connector",
	"data-seed",
	"dimension",
	"event",
	"frontend-network",
	"method",
	"message-template",
	"message-topic",
	"metric",
	"module",
	"permission",
	"statistic-policy",
	"table",
	"translation",
];

export interface RegistryMutationContext {
	readonly requester: ContributionOwner;
	readonly actorId?: string;
}

export interface ReconciliationResult {
	readonly registered: readonly string[];
	readonly updated: readonly string[];
	readonly activated: readonly string[];
	readonly disabled: readonly string[];
	readonly failed: Readonly<Record<string, string>>;
}

export class CmsRegistry implements RegisteredMethodInvoker {
	private readonly dispatcher: RegistryMethodDispatcher;

	constructor(
		private readonly repository: RegistryRepository,
		private readonly core: RegistryCorePort,
	) {
		this.dispatcher = new RegistryMethodDispatcher(repository, core);
	}

	async discover(
		definition: ContributionDefinition,
		context: RegistryMutationContext,
	): Promise<StoredContribution> {
		return this.create(definition, "discover", "discovered", context);
	}

	async register(
		definition: ContributionDefinition,
		context: RegistryMutationContext,
	): Promise<StoredContribution> {
		return this.create(definition, "register", "registered", context);
	}

	async registerMethod(
		definition: ContributionDefinition,
		handler: RegisteredMethodHandler,
		context: RegistryMutationContext,
	): Promise<StoredContribution> {
		if (definition.type !== "method") {
			throw new RegistryError(
				"registry.contract_invalid",
				"Un gestionnaire ne peut être lié qu’à une contribution de méthode.",
			);
		}
		const contribution = await this.register(definition, context);
		this.dispatcher.bind(definition.identifier, handler);
		return contribution;
	}

	async bindMethod(
		methodIdentifier: string,
		handler: RegisteredMethodHandler,
		owner: ContributionOwner,
	): Promise<void> {
		const contribution = await this.require(contributionKey("method", methodIdentifier));
		this.assertOwner(contribution, owner);
		this.dispatcher.bind(methodIdentifier, handler);
	}

	async activate(key: string, context: RegistryMutationContext): Promise<StoredContribution> {
		return this.changeState(key, "activate", "active", context, async (contribution) => {
			if (
				!["disabled", "discovered", "registered", "repairing", "updating"].includes(
					contribution.state,
				)
			) {
				throw invalidState(key, contribution.state, "active");
			}
			const contributions = await this.repository.list();
			const graph = new ContributionGraph(contributions);
			graph.assertAcyclic();
			const blockers = graph.activationBlockers(key);
			if (blockers.length > 0) {
				throw new RegistryError(
					"registry.dependency_blocked",
					`Activation bloquée par : ${blockers.join(", ")}.`,
				);
			}
		});
	}

	async disable(key: string, context: RegistryMutationContext): Promise<StoredContribution> {
		return this.changeState(key, "disable", "disabled", context, async (contribution) => {
			if (contribution.owner.kind === "core") {
				throw new RegistryError(
					"registry.owner_denied",
					"Une contribution Core ne peut pas être désactivée.",
				);
			}
			if (contribution.state !== "active") {
				throw invalidState(key, contribution.state, "disabled");
			}
			const blockers = new ContributionGraph(await this.repository.list()).withdrawalBlockers(key);
			if (blockers.length > 0) {
				throw new RegistryError(
					"registry.withdrawal_blocked",
					`Désactivation bloquée par : ${blockers.join(", ")}.`,
				);
			}
		});
	}

	async update(
		definition: ContributionDefinition,
		context: RegistryMutationContext,
	): Promise<StoredContribution> {
		validateContributionDefinition(definition);
		const key = contributionKey(definition.type, definition.identifier);
		const existing = await this.require(key);
		this.assertOwner(existing, context.requester);
		if (!sameOwner(existing.owner, definition.owner)) {
			throw new RegistryError(
				"registry.owner_denied",
				"Une mise à jour ne peut pas transférer la propriété d’une contribution.",
			);
		}
		if (compareSemver(definition.version, existing.version) <= 0) {
			throw new RegistryError(
				"registry.contract_invalid",
				"La version mise à jour doit être supérieure à la version installée.",
			);
		}
		return this.mutate(definition, "update", context.actorId, async () => {
			const now = new Date();
			const updating: StoredContribution = {
				...definition,
				key,
				state: "updating",
				registeredAt: existing.registeredAt,
				updatedAt: now,
			};
			await this.repository.set(updating);
			const graph = new ContributionGraph(await this.repository.list());
			graph.assertAcyclic();
			const stored: StoredContribution = {
				...updating,
				state: existing.state === "active" ? "active" : "registered",
				updatedAt: new Date(),
			};
			await this.repository.set(stored);
			return stored;
		});
	}

	async withdraw(key: string, context: RegistryMutationContext): Promise<StoredContribution> {
		const contribution = await this.require(key);
		if (contribution.withdrawalPolicy === "block-uninstall") {
			throw new RegistryError(
				"registry.withdrawal_blocked",
				`La contribution ${key} interdit son retrait.`,
			);
		}
		const withdrawn = await this.changeState(
			key,
			"withdraw",
			"withdrawn",
			context,
			async (current) => {
				if (current.owner.kind === "core") {
					throw new RegistryError(
						"registry.owner_denied",
						"Une contribution Core ne peut pas être retirée.",
					);
				}
				const blockers = new ContributionGraph(await this.repository.list()).withdrawalBlockers(
					key,
				);
				if (blockers.length > 0) {
					throw new RegistryError(
						"registry.withdrawal_blocked",
						`Retrait bloqué par : ${blockers.join(", ")}.`,
					);
				}
			},
		);
		if (withdrawn.type === "method") this.dispatcher.unbind(withdrawn.identifier);
		return withdrawn;
	}

	async repair(key: string, context: RegistryMutationContext): Promise<StoredContribution> {
		return this.changeState(key, "repair", "registered", context, async (contribution) => {
			if (contribution.state !== "failed") {
				throw invalidState(key, contribution.state, "repairing");
			}
			const repairing = { ...contribution, state: "repairing" as const, updatedAt: new Date() };
			await this.repository.set(repairing);
			new ContributionGraph(await this.repository.list()).assertAcyclic();
		});
	}

	async markFailed(
		key: string,
		reason: string,
		context: RegistryMutationContext,
	): Promise<StoredContribution> {
		if (!reason.trim()) {
			throw new RegistryError(
				"registry.contract_invalid",
				"La cause d’un échec de contribution est obligatoire.",
			);
		}
		return this.changeState(key, "fail", "failed", context, async () => {}, reason.trim());
	}

	async reconcile(definitions: readonly ContributionDefinition[]): Promise<ReconciliationResult> {
		const registered: string[] = [];
		const updated: string[] = [];
		const activated: string[] = [];
		const disabled: string[] = [];
		const failed: Record<string, string> = {};
		const desiredKeys = new Set(
			definitions.map((definition) => contributionKey(definition.type, definition.identifier)),
		);

		for (const definition of definitions) {
			const key = contributionKey(definition.type, definition.identifier);
			const context = { requester: definition.owner };
			try {
				const existing = await this.repository.get(key);
				if (!existing) {
					await this.register(definition, context);
					registered.push(key);
				} else if (compareSemver(definition.version, existing.version) > 0) {
					await this.update(definition, context);
					updated.push(key);
				}
			} catch (error) {
				failed[key] = errorMessage(error);
			}
		}

		const pendingDisable = new Map(
			(await this.repository.list())
				.filter(
					(contribution) =>
						contribution.state === "active" &&
						contribution.owner.kind !== "core" &&
						!desiredKeys.has(contribution.key),
				)
				.map((contribution) => [contribution.key, contribution]),
		);
		let disableProgress = true;
		while (disableProgress && pendingDisable.size > 0) {
			disableProgress = false;
			for (const [key, contribution] of pendingDisable) {
				try {
					await this.disable(key, { requester: contribution.owner });
					disabled.push(key);
					pendingDisable.delete(key);
					disableProgress = true;
				} catch (error) {
					if (!(error instanceof RegistryError && error.code === "registry.withdrawal_blocked")) {
						failed[key] = errorMessage(error);
						pendingDisable.delete(key);
					}
				}
			}
		}
		for (const key of pendingDisable.keys()) {
			failed[key] = "La contribution est encore requise par une contribution active.";
		}

		let progress = true;
		while (progress) {
			progress = false;
			for (const key of desiredKeys) {
				const contribution = await this.repository.get(key);
				if (!contribution || contribution.state === "active" || failed[key]) continue;
				try {
					await this.activate(key, { requester: contribution.owner });
					activated.push(key);
					progress = true;
				} catch (error) {
					if (!(error instanceof RegistryError && error.code === "registry.dependency_blocked")) {
						failed[key] = errorMessage(error);
					}
				}
			}
		}

		for (const key of desiredKeys) {
			const contribution = await this.repository.get(key);
			if (contribution?.state !== "active" && !failed[key]) {
				failed[key] = "Les dépendances requises ne peuvent pas être activées.";
			}
		}
		return { registered, updated, activated, disabled, failed };
	}

	async get(key: string): Promise<StoredContribution | undefined> {
		return this.repository.get(key);
	}

	async catalog(): Promise<RegistryCatalog> {
		const contributions = await this.repository.list();
		const byType = contributionTypes.reduce<
			Record<ContributionType, readonly StoredContribution[]>
		>(
			(catalog, type) => ({
				...catalog,
				[type]: contributions.filter((contribution) => contribution.type === type),
			}),
			{} as Record<ContributionType, readonly StoredContribution[]>,
		);
		return { generatedAt: new Date(), contributions, byType };
	}

	async inspect(key: string): Promise<ContributionInspection> {
		return new ContributionGraph(await this.repository.list()).inspect(key);
	}

	invokeRegisteredMethod(invocation: RegisteredMethodInvocation): Promise<unknown> {
		return this.dispatcher.invoke(invocation);
	}

	private async create(
		definition: ContributionDefinition,
		action: "discover" | "register",
		state: "discovered" | "registered",
		context: RegistryMutationContext,
	): Promise<StoredContribution> {
		validateContributionDefinition(definition);
		if (!sameOwner(definition.owner, context.requester)) {
			throw new RegistryError(
				"registry.owner_denied",
				"Une contribution ne peut être créée que par son propriétaire déclaré.",
			);
		}
		const key = contributionKey(definition.type, definition.identifier);
		const existing = await this.repository.get(key);
		if (existing) {
			if (sameOwner(existing.owner, definition.owner)) {
				if (
					existing.version === definition.version &&
					stableJson(definitionFromStored(existing)) === stableJson(definition)
				) {
					if (state === "registered" && existing.state === "discovered") {
						return this.mutate(definition, action, context.actorId, async () => {
							const registered = { ...existing, state, updatedAt: new Date() };
							await this.repository.set(registered);
							return registered;
						});
					}
					return existing;
				}
				throw new RegistryError(
					"registry.collision",
					`La contribution ${existing.key} existe déjà. Utilisez une mise à jour versionnée.`,
				);
			}
			if (
				definition.replaces !== existing.key ||
				definition.replacementPolicy !== "explicit" ||
				existing.replacementPolicy !== "explicit"
			) {
				throw new RegistryError(
					"registry.collision",
					`La contribution ${existing.key} appartient déjà à ${existing.owner.identifier}.`,
				);
			}
			return this.mutate(definition, action, context.actorId, async () => {
				const now = new Date();
				const replacement: StoredContribution = {
					...definition,
					key,
					state,
					registeredAt: now,
					updatedAt: now,
				};
				await this.repository.set(replacement);
				new ContributionGraph(await this.repository.list()).assertAcyclic();
				return replacement;
			});
		}
		return this.mutate(definition, action, context.actorId, async () => {
			const now = new Date();
			const stored: StoredContribution = {
				...definition,
				key,
				state,
				registeredAt: now,
				updatedAt: now,
			};
			await this.repository.set(stored);
			new ContributionGraph(await this.repository.list()).assertAcyclic();
			return stored;
		});
	}

	private async changeState(
		key: string,
		action: RegistryMutationAction,
		state: ContributionState,
		context: RegistryMutationContext,
		beforeChange: (contribution: StoredContribution) => Promise<void>,
		failureReason?: string,
	): Promise<StoredContribution> {
		const contribution = await this.require(key);
		this.assertOwner(contribution, context.requester);
		return this.mutate(contribution, action, context.actorId, async () => {
			await beforeChange(contribution);
			const updated: StoredContribution = {
				...definitionFromStored(contribution),
				key: contribution.key,
				state,
				registeredAt: contribution.registeredAt,
				updatedAt: new Date(),
				...(failureReason ? { failureReason } : {}),
			};
			await this.repository.set(updated);
			return updated;
		});
	}

	private async mutate<Result>(
		definition: ContributionDefinition,
		action: RegistryMutationAction,
		actorId: string | undefined,
		operation: () => Promise<Result>,
	): Promise<Result> {
		const candidate = toMutationCandidate(definition, action);
		try {
			await this.core.validateMutation(candidate);
			return await this.core.transaction(() =>
				this.repository.transaction(async () => {
					const result = await operation();
					await this.core.recordMutation(candidate, "allowed", actorId);
					return result;
				}),
			);
		} catch (error) {
			await this.core.recordMutation(candidate, "failed", actorId);
			throw error;
		}
	}

	private async require(key: string): Promise<StoredContribution> {
		const contribution = await this.repository.get(key);
		if (!contribution) {
			throw new RegistryError(
				"registry.dependency_blocked",
				`La contribution ${key} est introuvable.`,
			);
		}
		return contribution;
	}

	private assertOwner(contribution: StoredContribution, requester: ContributionOwner): void {
		if (!sameOwner(contribution.owner, requester)) {
			throw new RegistryError(
				"registry.owner_denied",
				`Seul ${contribution.owner.identifier} peut modifier ${contribution.key}.`,
			);
		}
	}
}

export function createInMemoryCmsRegistry(core: RegistryCorePort): CmsRegistry {
	return new CmsRegistry(new InMemoryRegistryRepository(), core);
}

function invalidState(key: string, from: ContributionState, to: ContributionState): RegistryError {
	return new RegistryError(
		"registry.invalid_state",
		`La contribution ${key} ne peut pas passer de ${from} à ${to}.`,
	);
}

function definitionFromStored(contribution: StoredContribution): ContributionDefinition {
	return {
		identifier: contribution.identifier,
		type: contribution.type,
		owner: contribution.owner,
		version: contribution.version,
		withdrawalPolicy: contribution.withdrawalPolicy,
		...(contribution.dependencies ? { dependencies: contribution.dependencies } : {}),
		...(contribution.requiredCapabilities
			? { requiredCapabilities: contribution.requiredCapabilities }
			: {}),
		...(contribution.configuration ? { configuration: contribution.configuration } : {}),
		...(contribution.translations ? { translations: contribution.translations } : {}),
		...(contribution.replacementPolicy
			? { replacementPolicy: contribution.replacementPolicy }
			: {}),
		...(contribution.replaces ? { replaces: contribution.replaces } : {}),
		...(contribution.method ? { method: contribution.method } : {}),
		...(contribution.endpoint ? { endpoint: contribution.endpoint } : {}),
		...(contribution.connector ? { connector: contribution.connector } : {}),
		...(contribution.frontendNetwork ? { frontendNetwork: contribution.frontendNetwork } : {}),
		...(contribution.statisticEvent ? { statisticEvent: contribution.statisticEvent } : {}),
		...(contribution.statisticDimension
			? { statisticDimension: contribution.statisticDimension }
			: {}),
		...(contribution.statisticMetric ? { statisticMetric: contribution.statisticMetric } : {}),
		...(contribution.statisticPolicy ? { statisticPolicy: contribution.statisticPolicy } : {}),
		...(contribution.messageTopic ? { messageTopic: contribution.messageTopic } : {}),
		...(contribution.messageTemplate ? { messageTemplate: contribution.messageTemplate } : {}),
		...(contribution.payload !== undefined ? { payload: contribution.payload } : {}),
	};
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([first], [second]) => first.localeCompare(second))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Erreur inconnue du registre.";
}
