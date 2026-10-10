import type { RegisteredMethodInvocation, RegistryCorePort } from "../../core/src/index.js";
import { contributionKey, type StoredContribution } from "./contracts.js";
import { RegistryError } from "./errors.js";
import type { RegistryRepository } from "./repository.js";

export interface RegisteredMethodContext {
	readonly actorId?: string;
	readonly contribution: StoredContribution;
	readonly idempotencyKey?: string;
	readonly signal: AbortSignal;
}

export interface RegisteredMethodHandler {
	readonly validateInput: (value: unknown) => boolean;
	readonly validateOutput: (value: unknown) => boolean;
	execute(context: RegisteredMethodContext, input: unknown): Promise<unknown>;
}

export class RegistryMethodDispatcher {
	private readonly handlers = new Map<string, RegisteredMethodHandler>();
	private readonly idempotentResults = new Map<string, Promise<unknown>>();

	constructor(
		private readonly repository: RegistryRepository,
		private readonly core: RegistryCorePort,
	) {}

	bind(methodIdentifier: string, handler: RegisteredMethodHandler): void {
		const key = contributionKey("method", methodIdentifier);
		if (this.handlers.has(key)) {
			throw new RegistryError(
				"registry.collision",
				`Un gestionnaire est déjà lié à ${methodIdentifier}.`,
			);
		}
		this.handlers.set(key, handler);
	}

	unbind(methodIdentifier: string): void {
		this.handlers.delete(contributionKey("method", methodIdentifier));
	}

	async invoke(invocation: RegisteredMethodInvocation): Promise<unknown> {
		const key = contributionKey("method", invocation.methodIdentifier);
		const contribution = await this.repository.get(key);
		const contract = contribution?.method;
		if (!contribution || !contract || contribution.state !== "active") {
			throw new RegistryError(
				"registry.method_not_found",
				`La méthode ${invocation.methodIdentifier} n’est pas disponible.`,
			);
		}
		const handler = this.handlers.get(key);
		if (!handler) {
			throw new RegistryError(
				"registry.method_not_found",
				`La méthode ${invocation.methodIdentifier} ne possède aucun gestionnaire actif.`,
			);
		}
		if (contract.requiredCapability) {
			if (!invocation.actorId) {
				throw new RegistryError(
					"registry.capability_denied",
					"Cette méthode exige un utilisateur authentifié.",
				);
			}
			if (!(await this.core.hasCapability(invocation.actorId, contract.requiredCapability))) {
				throw new RegistryError(
					"registry.capability_denied",
					`La capacité ${contract.requiredCapability} est requise.`,
				);
			}
		}
		if (!handler.validateInput(invocation.input)) {
			throw new RegistryError(
				"registry.contract_invalid",
				`L’entrée de ${invocation.methodIdentifier} ne respecte pas son contrat.`,
			);
		}
		if (!contract.idempotent && invocation.idempotencyKey) {
			throw new RegistryError(
				"registry.contract_invalid",
				"Une clé d’idempotence ne peut cibler qu’une méthode idempotente.",
			);
		}
		const cacheKey = invocation.idempotencyKey
			? `${key}:${invocation.actorId ?? "system"}:${invocation.idempotencyKey}`
			: undefined;
		const cached = cacheKey ? this.idempotentResults.get(cacheKey) : undefined;
		if (cached) return cached;

		const execution = this.executeWithContract(contribution, handler, invocation);
		if (!cacheKey) return execution;
		this.idempotentResults.set(cacheKey, execution);
		try {
			return await execution;
		} catch (error) {
			this.idempotentResults.delete(cacheKey);
			throw error;
		}
	}

	private async executeWithContract(
		contribution: StoredContribution,
		handler: RegisteredMethodHandler,
		invocation: RegisteredMethodInvocation,
	): Promise<unknown> {
		const controller = new AbortController();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				controller.abort();
				reject(
					new RegistryError(
						"registry.method_timeout",
						`La méthode ${invocation.methodIdentifier} a dépassé son délai.`,
					),
				);
			}, contribution.method!.timeoutMs);
		});
		const execute = async (): Promise<unknown> => {
			try {
				const output = await handler.execute(
					{
						...(invocation.actorId ? { actorId: invocation.actorId } : {}),
						contribution,
						...(invocation.idempotencyKey ? { idempotencyKey: invocation.idempotencyKey } : {}),
						signal: controller.signal,
					},
					invocation.input,
				);
				if (!handler.validateOutput(output)) {
					throw new RegistryError(
						"registry.contract_invalid",
						`La sortie de ${invocation.methodIdentifier} ne respecte pas son contrat.`,
					);
				}
				return output;
			} catch (error) {
				if (error instanceof RegistryError) throw error;
				throw new RegistryError(
					"registry.method_failed",
					`L’exécution de ${invocation.methodIdentifier} a échoué.`,
					{ cause: error },
				);
			}
		};
		try {
			const operation =
				contribution.method!.transaction === "required"
					? () => this.core.transaction(execute)
					: execute;
			return await Promise.race([operation(), timeoutPromise]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
}
