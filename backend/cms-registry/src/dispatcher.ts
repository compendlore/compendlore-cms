import { createHash } from "node:crypto";
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
	private readonly idempotentResults = new Map<
		string,
		{ readonly inputFingerprint: string; readonly result: Promise<unknown> }
	>();
	private readonly maximumIdempotentResults = 10_000;

	constructor(
		private readonly repository: RegistryRepository,
		private readonly core: RegistryCorePort,
	) {}

	validateHandler(handler: RegisteredMethodHandler): void {
		if (
			!handler ||
			typeof handler.validateInput !== "function" ||
			typeof handler.validateOutput !== "function" ||
			typeof handler.execute !== "function"
		) {
			throw new RegistryError("registry.contract_invalid", "The registry contract is invalid.");
		}
	}

	bind(methodIdentifier: string, handler: RegisteredMethodHandler): void {
		this.validateHandler(handler);
		const key = contributionKey("method", methodIdentifier);
		if (this.handlers.has(key)) {
			throw new RegistryError("registry.collision", "A registry contribution collision occurred.");
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
			throw new RegistryError("registry.method_not_found", "The registered method was not found.");
		}
		const handler = this.handlers.get(key);
		if (!handler) {
			throw new RegistryError("registry.method_not_found", "The registered method was not found.");
		}
		const authorized = await this.core.authorizeMethodInvocation({
			contributionKey: key,
			...(invocation.actorId ? { actorId: invocation.actorId } : {}),
			...(contract.requiredCapability ? { requiredCapability: contract.requiredCapability } : {}),
		});
		if (!authorized) {
			if (contract.requiredCapability && !invocation.actorId) {
				throw new RegistryError(
					"registry.capability_denied",
					"The required capability was denied.",
				);
			}
			throw new RegistryError("registry.capability_denied", "The required capability was denied.");
		}
		if (
			!this.validateValue(
				handler.validateInput,
				invocation.input,
				invocation.methodIdentifier,
				"input",
			)
		) {
			throw new RegistryError("registry.contract_invalid", "The registry contract is invalid.");
		}
		if (!contract.idempotent && invocation.idempotencyKey) {
			throw new RegistryError("registry.contract_invalid", "The registry contract is invalid.");
		}
		const cacheKey = invocation.idempotencyKey
			? `${key}:${invocation.actorId ?? "system"}:${invocation.idempotencyKey}`
			: undefined;
		const inputFingerprint = cacheKey ? fingerprintInput(invocation.input) : undefined;
		const cached = cacheKey ? this.idempotentResults.get(cacheKey) : undefined;
		if (cached) {
			if (cached.inputFingerprint !== inputFingerprint) {
				throw new RegistryError("registry.contract_invalid", "The registry contract is invalid.");
			}
			return cached.result;
		}

		const execution = this.executeWithContract(contribution, handler, invocation);
		if (!cacheKey) return execution;
		this.pruneIdempotentResults();
		this.idempotentResults.set(cacheKey, {
			inputFingerprint: inputFingerprint!,
			result: execution,
		});
		try {
			return await execution;
		} catch (error) {
			if (this.idempotentResults.get(cacheKey)?.result === execution) {
				this.idempotentResults.delete(cacheKey);
			}
			throw error;
		}
	}

	private async executeWithContract(
		contribution: StoredContribution,
		handler: RegisteredMethodHandler,
		invocation: RegisteredMethodInvocation,
	): Promise<unknown> {
		const controller = new AbortController();
		const timeoutError = () =>
			new RegistryError("registry.method_timeout", "The registered method timed out.");
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				controller.abort();
				reject(timeoutError());
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
				if (controller.signal.aborted) throw timeoutError();
				if (
					!this.validateValue(handler.validateOutput, output, invocation.methodIdentifier, "output")
				) {
					throw new RegistryError("registry.contract_invalid", "The registry contract is invalid.");
				}
				return output;
			} catch (error) {
				if (error instanceof RegistryError) throw error;
				throw new RegistryError("registry.method_failed", "The registered method failed.", {
					cause: error,
				});
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

	private validateValue(
		validator: (value: unknown) => boolean,
		value: unknown,
		methodIdentifier: string,
		contractPart: "input" | "output",
	): boolean {
		try {
			return validator(value);
		} catch (error) {
			throw new RegistryError(
				"registry.contract_invalid",
				`The ${contractPart} validator for ${methodIdentifier} failed.`,
				{
					cause: error,
				},
			);
		}
	}

	private pruneIdempotentResults(): void {
		if (this.idempotentResults.size < this.maximumIdempotentResults) return;
		const oldestKey = this.idempotentResults.keys().next().value as string | undefined;
		if (oldestKey) this.idempotentResults.delete(oldestKey);
	}
}

function fingerprintInput(input: unknown): string {
	try {
		return createHash("sha256").update(canonicalize(input, new Set())).digest("hex");
	} catch (error) {
		if (error instanceof RegistryError) throw error;
		throw new RegistryError("registry.contract_invalid", "The registry contract is invalid.", {
			cause: error,
		});
	}
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") return `string:${JSON.stringify(value)}`;
	if (typeof value === "boolean") return `boolean:${value ? "true" : "false"}`;
	if (typeof value === "number" && Number.isFinite(value)) {
		return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
	}
	if (typeof value !== "object") {
		throw new RegistryError("registry.contract_invalid", "The registry contract is invalid.");
	}
	if (ancestors.has(value)) {
		throw new RegistryError("registry.contract_invalid", "The registry contract is invalid.");
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return `array:[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new RegistryError("registry.contract_invalid", "The registry contract is invalid.");
		}
		return `object:{${Object.entries(value)
			.sort(([first], [second]) => first.localeCompare(second))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item, ancestors)}`)
			.join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
}
