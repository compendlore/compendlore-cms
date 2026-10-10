export type RegistryErrorCode =
	| "registry.capability_denied"
	| "registry.collision"
	| "registry.contract_invalid"
	| "registry.dependency_blocked"
	| "registry.dependency_cycle"
	| "registry.invalid_state"
	| "registry.method_failed"
	| "registry.method_not_found"
	| "registry.method_timeout"
	| "registry.owner_denied"
	| "registry.withdrawal_blocked";

export class RegistryError extends Error {
	constructor(
		readonly code: RegistryErrorCode,
		message: string,
		options: { cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.name = "RegistryError";
	}
}
