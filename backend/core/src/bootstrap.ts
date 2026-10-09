import type { CoreConfig } from "./config.js";
import { CoreRuntime, ensureInstanceIdentity, type ManagedCoreService } from "./lifecycle.js";
import type { CoreLogger } from "./logging.js";
import {
	AuthenticationService,
	CsrfProtection,
	PasswordHasher,
	TwoFactorService,
} from "./security.js";
import type { SecretProvider } from "./services.js";
import type { CoreStore } from "./store.js";

export interface CoreApplication {
	readonly instanceId: string;
	readonly runtime: CoreRuntime;
	readonly authentication: AuthenticationService;
	readonly twoFactor: TwoFactorService;
	readonly csrf: CsrfProtection;
}

export async function bootstrapCore(input: {
	readonly config: CoreConfig;
	readonly store: CoreStore;
	readonly secrets: SecretProvider;
	readonly logger: CoreLogger;
	readonly services?: readonly ManagedCoreService[];
}): Promise<CoreApplication> {
	const [passwordPepper, csrfSecret] = await Promise.all([
		input.secrets.resolve(input.config.passwordPepperSecretRef),
		input.secrets.resolve(input.config.csrfSecretRef),
	]);
	const runtime = new CoreRuntime(input.services ?? [], input.logger);
	await runtime.start();
	try {
		return {
			instanceId: await ensureInstanceIdentity(input.store),
			runtime,
			authentication: new AuthenticationService(
				input.store,
				new PasswordHasher(passwordPepper),
				input.config.sessionTtlMs,
				input.config.adminSessionTtlMs,
			),
			twoFactor: new TwoFactorService(input.store),
			csrf: new CsrfProtection(csrfSecret),
		};
	} catch (error) {
		await runtime.stop();
		throw error;
	}
}
