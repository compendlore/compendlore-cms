import { createHmac, randomUUID } from "node:crypto";
import {
	SecurityKernel,
	type SecurityAuditPort,
	type SecurityAuditRecord,
	type SecurityEvidence,
	type SecurityResource,
	type InputSecurityPolicy,
	type OutputSecurityPolicy,
	type SecurityContext,
	type SecurityDecision,
	type SecuredOutput,
} from "../../security-kernel/src/index.js";
import type { CoreSecurityAttempt, CoreStore } from "./store.js";

export interface CoreSecurityBoundary {
	secureInput<T>(input: {
		readonly operation: string;
		readonly value: T;
		readonly context: SecurityContext;
		readonly policy: InputSecurityPolicy;
	}): Promise<SecurityDecision<T>>;
	secureOutput<T>(input: {
		readonly operation: string;
		readonly value: T;
		readonly context: SecurityContext;
		readonly policy: OutputSecurityPolicy;
	}): Promise<SecuredOutput<T>>;
	assertEvidence(
		evidence: SecurityEvidence,
		expected: { readonly operation: string; readonly resource?: SecurityResource },
	): void;
}

export class CoreSecurityAudit implements SecurityAuditPort {
	constructor(
		private readonly store: CoreStore,
		private readonly digestSecret: string,
	) {}

	async record(record: SecurityAuditRecord): Promise<void> {
		const attempt: CoreSecurityAttempt = {
			id: randomUUID(),
			kind: `security-kernel.${record.outcome}`,
			...(record.subjectId ? { subjectDigest: this.digest(record.subjectId) } : {}),
			outcome: mapOutcome(record.outcome),
			occurredAt: record.occurredAt,
			metadata: {
				evidenceId: record.evidenceId,
				correlationId: record.correlationId,
				operation: record.operation,
				policyIdentifier: record.policyIdentifier,
				policyVersion: record.policyVersion,
				...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
				...(record.resource
					? {
							resourceKind: record.resource.kind,
							resourceDigest: this.digest(`${record.resource.kind}\0${record.resource.identifier}`),
						}
					: {}),
			},
		};
		await this.store.appendSecurityAttempt(attempt);
	}

	private digest(value: string): string {
		return createHmac("sha256", this.digestSecret).update(value).digest("hex");
	}
}

export class DefaultCoreSecurityBoundary implements CoreSecurityBoundary {
	constructor(private readonly kernel = new SecurityKernel()) {}

	secureInput<T>(input: {
		readonly operation: string;
		readonly value: T;
		readonly context: SecurityContext;
		readonly policy: InputSecurityPolicy;
	}): Promise<SecurityDecision<T>> {
		return this.kernel.secureInput(input);
	}

	secureOutput<T>(input: {
		readonly operation: string;
		readonly value: T;
		readonly context: SecurityContext;
		readonly policy: OutputSecurityPolicy;
	}): Promise<SecuredOutput<T>> {
		return this.kernel.secureOutput(input);
	}

	assertEvidence(
		evidence: SecurityEvidence,
		expected: { readonly operation: string; readonly resource?: SecurityResource },
	): void {
		this.kernel.assertEvidence(evidence, expected);
	}
}

function mapOutcome(outcome: SecurityAuditRecord["outcome"]): CoreSecurityAttempt["outcome"] {
	if (outcome === "allowed" || outcome === "output-protected") return "allowed";
	return "blocked";
}
