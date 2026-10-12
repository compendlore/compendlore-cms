import { randomUUID } from "node:crypto";
import {
	SecurityKernel,
	type InputSecurityPolicy,
	type SecurityContext,
	type SecurityDecision,
} from "./kernel.js";

export interface SecurityPolicyPort {
	resolveInputPolicy(identifier: string): Promise<InputSecurityPolicy | undefined>;
}

export class InMemorySecurityPolicyPort implements SecurityPolicyPort {
	private readonly policies = new Map<string, InputSecurityPolicy>();

	constructor(policies: readonly InputSecurityPolicy[] = []) {
		for (const policy of policies) this.policies.set(policy.identifier, structuredClone(policy));
	}

	async resolveInputPolicy(identifier: string): Promise<InputSecurityPolicy | undefined> {
		const policy = this.policies.get(identifier);
		return policy ? structuredClone(policy) : undefined;
	}
}

export class PolicyEnforcedSecurityKernel {
	constructor(
		private readonly policies: SecurityPolicyPort,
		private readonly kernel = new SecurityKernel(),
	) {}

	async secureInput<T>(input: {
		readonly operation: string;
		readonly value: T;
		readonly context: SecurityContext;
		readonly policyIdentifier: string;
	}): Promise<SecurityDecision<T>> {
		let policy: InputSecurityPolicy | undefined;
		try {
			policy = await this.policies.resolveInputPolicy(input.policyIdentifier);
		} catch {
			return denied("security.policy_unavailable");
		}
		if (!policy) return denied("security.policy_unknown");
		return this.kernel.secureInput({
			operation: input.operation,
			value: input.value,
			context: input.context,
			policy,
		});
	}
}

function denied<T>(reasonCode: string): SecurityDecision<T> {
	return { status: "denied", reasonCode, evidenceId: randomUUID() };
}
