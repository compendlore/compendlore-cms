import {
	SecurityKernel,
	type InputSecurityPolicy,
	type OutputSecurityPolicy,
	type SecurityContext,
	type SecurityDecision,
	type SecuredOutput,
} from "../../security-kernel/src/index.js";

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
}
