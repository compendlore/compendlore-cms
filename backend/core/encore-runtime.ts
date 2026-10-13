import log from "encore.dev/log";
import type { CoreDatabase } from "./database.js";
import { bootstrapEncoreCore } from "./src/encore-bootstrap.js";
import {
	EnvironmentSecretProvider,
	loadCoreConfig,
	normalizeError,
	redactLogContext,
	type CoreApplication,
	type CoreLogger,
	type LogLevel,
} from "./src/index.js";

type EncoreCoreApplication = CoreApplication & { readonly database: CoreDatabase };

interface BootstrapSuccess {
	readonly ok: true;
	readonly application: EncoreCoreApplication;
}

interface BootstrapFailure {
	readonly ok: false;
	readonly error: unknown;
}

type BootstrapOutcome = BootstrapSuccess | BootstrapFailure;

const logger: CoreLogger = {
	write(level: LogLevel, event: string, context = {}): void {
		const fields = { context: JSON.stringify(redactLogContext(context)) };
		switch (level) {
			case "debug":
				log.debug(event, fields);
				break;
			case "info":
				log.info(event, fields);
				break;
			case "warn":
				log.warn(event, fields);
				break;
			case "error":
				log.error(event, fields);
				break;
		}
	},
};

const bootstrapOutcome = startCore();

export async function getEncoreCoreApplication(): Promise<EncoreCoreApplication> {
	const outcome = await bootstrapOutcome;
	if (!outcome.ok) throw outcome.error;
	return outcome.application;
}

export async function inspectEncoreCore(): Promise<{
	readonly live: boolean;
	readonly ready: boolean;
	readonly state: string;
	readonly services: Readonly<Record<string, "healthy" | "unhealthy">>;
}> {
	const outcome = await bootstrapOutcome;
	if (!outcome.ok) {
		return { live: false, ready: false, state: "failed", services: {} };
	}
	const health = await outcome.application.runtime.health();
	return {
		...health,
		state: outcome.application.runtime.state,
	};
}

async function startCore(): Promise<BootstrapOutcome> {
	try {
		const application = await bootstrapEncoreCore({
			config: loadCoreConfig(process.env),
			secrets: new EnvironmentSecretProvider(process.env),
			logger,
		});
		return { ok: true, application };
	} catch (error) {
		const normalized = normalizeError(error, "core-bootstrap");
		logger.write("error", "core.bootstrap_failed", {
			code: normalized.code,
			retryable: normalized.retryable,
		});
		return { ok: false, error };
	}
}
