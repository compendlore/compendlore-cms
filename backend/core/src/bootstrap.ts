import type { CoreConfig } from "./config.js";
import { AccountSecurityService } from "./account-security.js";
import { CoreRuntime, ensureInstanceIdentity, type ManagedCoreService } from "./lifecycle.js";
import type { CoreLogger } from "./logging.js";
import { InstallationTokenService, type InstallationTokenPublisher } from "./installation.js";
import {
	AuthenticationService,
	CsrfProtection,
	PasswordHasher,
	TwoFactorService,
} from "./security.js";
import type { SecretProvider } from "./services.js";
import type { CoreStore } from "./store.js";
import { CoreSettingsService, InstallationStateService } from "./settings.js";
import { CoreRestorationService } from "./restoration.js";

export interface CoreApplication {
	readonly instanceId: string;
	readonly runtime: CoreRuntime;
	readonly authentication: AuthenticationService;
	readonly twoFactor: TwoFactorService;
	readonly csrf: CsrfProtection;
	readonly accountSecurity: AccountSecurityService;
	readonly settings: CoreSettingsService;
	readonly installationState: InstallationStateService;
	readonly restoration: CoreRestorationService;
}

export async function bootstrapCore(input: {
	readonly config: CoreConfig;
	readonly store: CoreStore;
	readonly secrets: SecretProvider;
	readonly logger: CoreLogger;
	readonly installationTokenPublisher: InstallationTokenPublisher;
	readonly services?: readonly ManagedCoreService[];
}): Promise<CoreApplication> {
	const [passwordPepper, csrfSecret, securityDigestSecret] = await Promise.all([
		input.secrets.resolve(input.config.passwordPepperSecretRef),
		input.secrets.resolve(input.config.csrfSecretRef),
		input.secrets.resolve(input.config.securityDigestSecretRef),
	]);
	const runtime = new CoreRuntime(input.services ?? [], input.logger);
	await runtime.start();
	try {
		const instanceId = await ensureInstanceIdentity(input.store);
		const installationTokens = new InstallationTokenService(
			instanceId,
			input.store,
			input.installationTokenPublisher,
			input.logger,
			input.config.installationTokenTtlMs,
		);
		await installationTokens.ensureAvailable();
		const accountSecurity = new AccountSecurityService(input.store, securityDigestSecret);
		return {
			instanceId,
			runtime,
			authentication: new AuthenticationService(
				input.store,
				new PasswordHasher(passwordPepper),
				installationTokens,
				accountSecurity,
				input.config.sessionTtlMs,
				input.config.adminSessionTtlMs,
			),
			twoFactor: new TwoFactorService(input.store),
			csrf: new CsrfProtection(csrfSecret),
			accountSecurity,
			settings: new CoreSettingsService(input.store),
			installationState: new InstallationStateService(instanceId, input.store),
			restoration: new CoreRestorationService(input.store),
		};
	} catch (error) {
		await runtime.stop();
		throw error;
	}
}
