export type CoreErrorCode =
	| "configuration.invalid"
	| "authentication.invalid_credentials"
	| "authentication.session_expired"
	| "authentication.two_factor_required"
	| "authorization.denied"
	| "authorization.founder_protected"
	| "security.csrf_invalid"
	| "security.rate_limited"
	| "storage.invalid_key"
	| "network.denied"
	| "lifecycle.invalid_state"
	| "infrastructure.unavailable";

export interface CoreErrorDetails {
	readonly [key: string]: boolean | number | string | null;
}

export class CoreError extends Error {
	readonly code: CoreErrorCode;
	readonly details: CoreErrorDetails;
	readonly retryable: boolean;

	constructor(
		code: CoreErrorCode,
		message: string,
		options: { cause?: unknown; details?: CoreErrorDetails; retryable?: boolean } = {},
	) {
		super(message, { cause: options.cause });
		this.name = "CoreError";
		this.code = code;
		this.details = options.details ?? {};
		this.retryable = options.retryable ?? false;
	}
}

export interface PublicCoreError {
	readonly code: CoreErrorCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly correlationId: string;
}

export function normalizeError(error: unknown, correlationId: string): PublicCoreError {
	if (error instanceof CoreError) {
		return {
			code: error.code,
			message: error.message,
			retryable: error.retryable,
			correlationId,
		};
	}

	return {
		code: "infrastructure.unavailable",
		message: "Une erreur interne est survenue.",
		retryable: false,
		correlationId,
	};
}
