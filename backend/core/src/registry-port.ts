import { randomUUID } from "node:crypto";
import { CoreError } from "./errors.js";
import type { AuditRecord, CoreJsonValue, CoreStore } from "./store.js";

export type RegistryMutationAction =
	"activate" | "disable" | "discover" | "fail" | "register" | "repair" | "update" | "withdraw";

export interface RegistryMutationCandidate {
	readonly action: RegistryMutationAction;
	readonly contributionKey: string;
	readonly ownerIdentifier: string;
	readonly ownerKind: "addon" | "core" | "instance" | "native-module";
	readonly version: string;
	readonly requiredCapabilities: readonly string[];
	readonly payload: CoreJsonValue;
}

export interface RegistryCorePort {
	transaction<Result>(operation: () => Promise<Result>): Promise<Result>;
	validateMutation(candidate: RegistryMutationCandidate): Promise<void>;
	authorizeMethodInvocation(request: RegistryMethodAuthorizationRequest): Promise<boolean>;
	recordMutation(
		candidate: RegistryMutationCandidate,
		outcome: AuditRecord["outcome"],
		actorId?: string,
	): Promise<void>;
}

export interface RegistryMethodAuthorizationRequest {
	readonly contributionKey: string;
	readonly actorId?: string;
	readonly requiredCapability?: string;
}

export interface RegisteredMethodInvocation {
	readonly methodIdentifier: string;
	readonly input: unknown;
	readonly actorId?: string;
	readonly idempotencyKey?: string;
}

export interface RegisteredMethodInvoker {
	invokeRegisteredMethod(invocation: RegisteredMethodInvocation): Promise<unknown>;
}

export class CoreRegistryPort implements RegistryCorePort {
	constructor(
		private readonly store: CoreStore,
		private readonly maximumPayloadBytes = 1_048_576,
	) {}

	transaction<Result>(operation: () => Promise<Result>): Promise<Result> {
		return this.store.transaction(operation);
	}

	async validateMutation(candidate: RegistryMutationCandidate): Promise<void> {
		validateRegistryIdentifier(candidate.contributionKey, "contributionKey");
		validateRegistryIdentifier(candidate.ownerIdentifier, "ownerIdentifier");
		if (
			!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
				candidate.version,
			)
		) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		for (const capability of candidate.requiredCapabilities) {
			validateRegistryIdentifier(capability, "capability");
		}
		const serialized = JSON.stringify(candidate.payload);
		if (serialized === undefined) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		if (Buffer.byteLength(serialized, "utf8") > this.maximumPayloadBytes) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
	}

	async authorizeMethodInvocation(request: RegistryMethodAuthorizationRequest): Promise<boolean> {
		validateRegistryIdentifier(request.contributionKey, "contributionKey");
		if (!request.requiredCapability) return true;
		validateRegistryIdentifier(request.requiredCapability, "requiredCapability");
		if (!request.actorId) return false;
		return this.store.hasCapability(request.actorId, request.requiredCapability);
	}

	async recordMutation(
		candidate: RegistryMutationCandidate,
		outcome: AuditRecord["outcome"],
		actorId?: string,
	): Promise<void> {
		await this.store.appendAudit({
			id: randomUUID(),
			occurredAt: new Date(),
			action: `registry.${candidate.action}`,
			outcome,
			...(actorId ? { actorId } : {}),
			subjectId: candidate.contributionKey,
			correlationId: randomUUID(),
			metadata: {
				ownerIdentifier: candidate.ownerIdentifier,
				ownerKind: candidate.ownerKind,
				version: candidate.version,
			},
		});
	}
}

export class CoreRegistryRuntime {
	constructor(private readonly invoker: RegisteredMethodInvoker) {}

	invoke(invocation: RegisteredMethodInvocation): Promise<unknown> {
		validateRegistryIdentifier(invocation.methodIdentifier, "methodIdentifier");
		return this.invoker.invokeRegisteredMethod(invocation);
	}
}

function validateRegistryIdentifier(value: string, field: string): void {
	if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value) || value.length > 160) {
		throw new CoreError("configuration.invalid", `The ${field} identifier is invalid.`);
	}
}
