import { randomUUID } from "node:crypto";

const securedInputBrand: unique symbol = Symbol("secured-input");
const securedOutputBrand: unique symbol = Symbol("secured-output");

export type SecuritySurface = "administration" | "internal" | "public" | "site";

export interface SecuritySubject {
	readonly id: string;
	readonly kind: "anonymous" | "api-key" | "oauth-client" | "system" | "user";
	readonly capabilities: ReadonlySet<string>;
	readonly authenticatedAt?: Date;
	readonly multiFactorVerifiedAt?: Date;
}

export interface SecurityResource {
	readonly kind: string;
	readonly identifier: string;
}

export interface SecurityContext {
	readonly correlationId: string;
	readonly surface: SecuritySurface;
	readonly subject?: SecuritySubject;
	readonly resource?: SecurityResource;
	readonly deviceIdentifier?: string;
	readonly origin?: string;
}

export interface InputSecurityPolicy {
	readonly identifier: string;
	readonly version: string;
	readonly allowAnonymous: boolean;
	readonly requiredCapabilities?: readonly string[];
	readonly maximumSerializedBytes?: number;
	readonly maximumDepth?: number;
	readonly maximumStringLength?: number;
	readonly multiFactorMaximumAgeMs?: number;
}

export interface OutputSecurityPolicy {
	readonly identifier: string;
	readonly version: string;
	readonly omittedFields?: readonly string[];
	readonly maskedFields?: readonly string[];
}

export interface SecurityEvidence {
	readonly id: string;
	readonly operation: string;
	readonly policyIdentifier: string;
	readonly policyVersion: string;
	readonly resource?: SecurityResource;
	readonly issuedAt: Date;
	readonly expiresAt: Date;
}

export interface SecuredInput<T> {
	readonly value: T;
	readonly evidence: SecurityEvidence;
	readonly [securedInputBrand]: true;
}

export interface SecuredOutput<T> {
	readonly value: T;
	readonly evidence: SecurityEvidence;
	readonly [securedOutputBrand]: true;
}

export type SecurityDecision<T> =
	| { readonly status: "allowed"; readonly secured: SecuredInput<T> }
	| {
			readonly status: "denied";
			readonly reasonCode: string;
			readonly evidenceId: string;
	  }
	| {
			readonly status: "reauthentication-required" | "step-up-required";
			readonly reasonCode: string;
			readonly evidenceId: string;
	  };

export interface SecurityAuditRecord {
	readonly evidenceId: string;
	readonly correlationId: string;
	readonly operation: string;
	readonly policyIdentifier: string;
	readonly policyVersion: string;
	readonly subjectId?: string;
	readonly resource?: SecurityResource;
	readonly outcome: SecurityDecision<unknown>["status"] | "output-protected";
	readonly reasonCode?: string;
	readonly occurredAt: Date;
}

export interface SecurityAuditPort {
	record(record: SecurityAuditRecord): Promise<void>;
}

export class InMemorySecurityAudit implements SecurityAuditPort {
	readonly records: SecurityAuditRecord[] = [];

	async record(record: SecurityAuditRecord): Promise<void> {
		this.records.push(record);
	}
}

export class SecurityKernel {
	private readonly issuedEvidence = new Map<string, SecurityEvidence>();

	constructor(
		private readonly audit: SecurityAuditPort = new InMemorySecurityAudit(),
		private readonly evidenceTtlMs = 30_000,
		private readonly now: () => Date = () => new Date(),
	) {}

	async secureInput<T>(input: {
		readonly operation: string;
		readonly value: T;
		readonly context: SecurityContext;
		readonly policy: InputSecurityPolicy;
	}): Promise<SecurityDecision<T>> {
		this.purgeExpiredEvidence();
		const evidenceId = randomUUID();
		const deny = async (
			status: "denied" | "reauthentication-required" | "step-up-required",
			reasonCode: string,
		): Promise<SecurityDecision<T>> => {
			await this.record(input, evidenceId, status, reasonCode);
			return { status, reasonCode, evidenceId };
		};

		if (!validIdentifier(input.operation) || !validIdentifier(input.policy.identifier)) {
			return deny("denied", "security.policy_invalid");
		}
		const subject = input.context.subject;
		if (!subject && !input.policy.allowAnonymous) {
			return deny("reauthentication-required", "security.authentication_required");
		}
		for (const capability of input.policy.requiredCapabilities ?? []) {
			if (!subject?.capabilities.has("*") && !subject?.capabilities.has(capability)) {
				return deny("denied", "security.capability_required");
			}
		}
		if (input.policy.multiFactorMaximumAgeMs !== undefined) {
			const verifiedAt = subject?.multiFactorVerifiedAt?.getTime() ?? 0;
			if (verifiedAt + input.policy.multiFactorMaximumAgeMs <= this.now().getTime()) {
				return deny("step-up-required", "security.multi_factor_required");
			}
		}
		try {
			inspectValue(input.value, {
				maximumDepth: input.policy.maximumDepth ?? 12,
				maximumStringLength: input.policy.maximumStringLength ?? 1_048_576,
			});
			const serialized = JSON.stringify(input.value);
			if (
				serialized === undefined ||
				Buffer.byteLength(serialized, "utf8") > (input.policy.maximumSerializedBytes ?? 1_048_576)
			) {
				return deny("denied", "security.input_too_large");
			}
		} catch {
			return deny("denied", "security.input_invalid");
		}

		const issuedAt = this.now();
		const evidence: SecurityEvidence = {
			id: evidenceId,
			operation: input.operation,
			policyIdentifier: input.policy.identifier,
			policyVersion: input.policy.version,
			...(input.context.resource ? { resource: input.context.resource } : {}),
			issuedAt,
			expiresAt: new Date(issuedAt.getTime() + this.evidenceTtlMs),
		};
		const secured = {
			value: structuredClone(input.value),
			evidence,
			[securedInputBrand]: true as const,
		};
		await this.record(input, evidenceId, "allowed");
		this.issuedEvidence.set(evidence.id, evidence);
		return { status: "allowed", secured };
	}

	async secureOutput<T>(input: {
		readonly operation: string;
		readonly value: T;
		readonly context: SecurityContext;
		readonly policy: OutputSecurityPolicy;
	}): Promise<SecuredOutput<T>> {
		if (!validIdentifier(input.operation) || !validIdentifier(input.policy.identifier)) {
			throw new SecurityKernelError("security.policy_invalid");
		}
		const issuedAt = this.now();
		const evidence: SecurityEvidence = {
			id: randomUUID(),
			operation: input.operation,
			policyIdentifier: input.policy.identifier,
			policyVersion: input.policy.version,
			...(input.context.resource ? { resource: input.context.resource } : {}),
			issuedAt,
			expiresAt: new Date(issuedAt.getTime() + this.evidenceTtlMs),
		};
		const value = protectOutput(
			input.value,
			new Set(input.policy.omittedFields ?? []),
			new Set(input.policy.maskedFields ?? []),
		) as T;
		await this.audit.record({
			evidenceId: evidence.id,
			correlationId: input.context.correlationId,
			operation: input.operation,
			policyIdentifier: input.policy.identifier,
			policyVersion: input.policy.version,
			...(input.context.subject ? { subjectId: input.context.subject.id } : {}),
			...(input.context.resource ? { resource: input.context.resource } : {}),
			outcome: "output-protected",
			occurredAt: issuedAt,
		});
		return { value, evidence, [securedOutputBrand]: true as const };
	}

	assertEvidence(
		evidence: SecurityEvidence,
		expected: { readonly operation: string; readonly resource?: SecurityResource },
	): void {
		const issued = this.issuedEvidence.get(evidence.id);
		if (
			!issued ||
			!sameEvidence(issued, evidence) ||
			issued.expiresAt.getTime() <= this.now().getTime() ||
			issued.operation !== expected.operation ||
			!sameResource(issued.resource, expected.resource)
		) {
			throw new SecurityKernelError("security.evidence_invalid");
		}
		this.issuedEvidence.delete(evidence.id);
	}

	private purgeExpiredEvidence(): void {
		const now = this.now().getTime();
		for (const [identifier, evidence] of this.issuedEvidence) {
			if (evidence.expiresAt.getTime() <= now) this.issuedEvidence.delete(identifier);
		}
	}

	private async record<T>(
		input: {
			readonly operation: string;
			readonly context: SecurityContext;
			readonly policy: InputSecurityPolicy;
		},
		evidenceId: string,
		outcome: SecurityDecision<T>["status"],
		reasonCode?: string,
	): Promise<void> {
		await this.audit.record({
			evidenceId,
			correlationId: input.context.correlationId,
			operation: input.operation,
			policyIdentifier: input.policy.identifier,
			policyVersion: input.policy.version,
			...(input.context.subject ? { subjectId: input.context.subject.id } : {}),
			...(input.context.resource ? { resource: input.context.resource } : {}),
			outcome,
			...(reasonCode ? { reasonCode } : {}),
			occurredAt: this.now(),
		});
	}
}

export class SecurityKernelError extends Error {
	constructor(readonly code: string) {
		super("The security policy cannot be applied.");
		this.name = "SecurityKernelError";
	}
}

function inspectValue(
	value: unknown,
	limits: { readonly maximumDepth: number; readonly maximumStringLength: number },
	depth = 0,
	seen = new Set<object>(),
): void {
	if (depth > limits.maximumDepth) throw new SecurityKernelError("security.input_too_deep");
	if (typeof value === "string") {
		if (value.length > limits.maximumStringLength) {
			throw new SecurityKernelError("security.input_too_large");
		}
		return;
	}
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new SecurityKernelError("security.input_invalid");
		return;
	}
	if (typeof value !== "object" || seen.has(value)) {
		throw new SecurityKernelError("security.input_invalid");
	}
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) inspectValue(item, limits, depth + 1, seen);
	} else {
		const prototype = Object.getPrototypeOf(value) as object | null;
		if (prototype !== Object.prototype && prototype !== null) {
			throw new SecurityKernelError("security.input_invalid");
		}
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (["__proto__", "constructor", "prototype"].includes(key)) {
				throw new SecurityKernelError("security.input_forbidden_key");
			}
			inspectValue(item, limits, depth + 1, seen);
		}
	}
	seen.delete(value);
}

function protectOutput(
	value: unknown,
	omitted: ReadonlySet<string>,
	masked: ReadonlySet<string>,
): unknown {
	if (Array.isArray(value)) return value.map((item) => protectOutput(item, omitted, masked));
	if (value === null || typeof value !== "object") return value;
	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (omitted.has(key)) continue;
		output[key] = masked.has(key) ? mask(item) : protectOutput(item, omitted, masked);
	}
	return output;
}

function mask(value: unknown): string {
	if (typeof value !== "string" || value.length < 4) return "••••";
	return `${value.slice(0, 2)}${"•".repeat(Math.min(value.length - 2, 12))}`;
}

function validIdentifier(value: string): boolean {
	return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value) && value.length <= 160;
}

function sameResource(
	first: SecurityResource | undefined,
	second: SecurityResource | undefined,
): boolean {
	if (!first || !second) return first === second;
	return first.kind === second.kind && first.identifier === second.identifier;
}

function sameEvidence(first: SecurityEvidence, second: SecurityEvidence): boolean {
	return (
		first.id === second.id &&
		first.operation === second.operation &&
		first.policyIdentifier === second.policyIdentifier &&
		first.policyVersion === second.policyVersion &&
		first.issuedAt.getTime() === second.issuedAt.getTime() &&
		first.expiresAt.getTime() === second.expiresAt.getTime() &&
		sameResource(first.resource, second.resource)
	);
}
