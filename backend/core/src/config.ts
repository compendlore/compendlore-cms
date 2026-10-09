import { CoreError } from "./errors.js";

export type CoreEnvironment = "development" | "test" | "production";

export interface CoreConfig {
	readonly environment: CoreEnvironment;
	readonly publicOrigin: URL;
	readonly sessionTtlMs: number;
	readonly adminSessionTtlMs: number;
	readonly shutdownTimeoutMs: number;
	readonly passwordPepperSecretRef: string;
	readonly csrfSecretRef: string;
	readonly dataEncryptionSecretRef: string;
	readonly outboundHosts: ReadonlySet<string>;
}

const positiveInteger = (value: string | undefined, fallback: number, key: string): number => {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new CoreError("configuration.invalid", `${key} doit être un entier positif.`);
	}
	return parsed;
};

const required = (environment: NodeJS.ProcessEnv, key: string): string => {
	const value = environment[key]?.trim();
	if (!value) throw new CoreError("configuration.invalid", `${key} est obligatoire.`);
	return value;
};

export function loadCoreConfig(environment: NodeJS.ProcessEnv): CoreConfig {
	const mode = environment.CORE_ENVIRONMENT ?? "production";
	if (!(["development", "test", "production"] as const).includes(mode as CoreEnvironment)) {
		throw new CoreError("configuration.invalid", "CORE_ENVIRONMENT est invalide.");
	}

	let publicOrigin: URL;
	try {
		publicOrigin = new URL(required(environment, "CORE_PUBLIC_ORIGIN"));
	} catch (error) {
		throw new CoreError("configuration.invalid", "CORE_PUBLIC_ORIGIN doit être une URL valide.", {
			cause: error,
		});
	}

	if (mode === "production" && publicOrigin.protocol !== "https:") {
		throw new CoreError("configuration.invalid", "HTTPS est obligatoire en production.");
	}

	const passwordPepperSecretRef = required(environment, "CORE_PASSWORD_PEPPER_SECRET_REF");
	const csrfSecretRef = required(environment, "CORE_CSRF_SECRET_REF");
	const dataEncryptionSecretRef = required(environment, "CORE_DATA_ENCRYPTION_SECRET_REF");

	const outboundHosts = new Set(
		(environment.CORE_OUTBOUND_HOSTS ?? "")
			.split(",")
			.map((host) => host.trim().toLowerCase())
			.filter(Boolean),
	);

	return Object.freeze({
		environment: mode as CoreEnvironment,
		publicOrigin,
		sessionTtlMs: positiveInteger(
			environment.CORE_SESSION_TTL_MS,
			86_400_000,
			"CORE_SESSION_TTL_MS",
		),
		adminSessionTtlMs: positiveInteger(
			environment.CORE_ADMIN_SESSION_TTL_MS,
			900_000,
			"CORE_ADMIN_SESSION_TTL_MS",
		),
		shutdownTimeoutMs: positiveInteger(
			environment.CORE_SHUTDOWN_TIMEOUT_MS,
			10_000,
			"CORE_SHUTDOWN_TIMEOUT_MS",
		),
		passwordPepperSecretRef,
		csrfSecretRef,
		dataEncryptionSecretRef,
		outboundHosts,
	});
}
