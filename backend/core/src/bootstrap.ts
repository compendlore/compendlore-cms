import type { CoreConfig } from "./config.js";
import { AccountSecurityService } from "./account-security.js";
import { CoreRuntime, ensureInstanceIdentity, type ManagedCoreService } from "./lifecycle.js";
import type { CoreLogger } from "./logging.js";
import { InstallationTokenService, type InstallationTokenPublisher } from "./installation.js";
import {
	AuthenticationService,
	CsrfProtection,
	PasswordHasher,
	RateLimiter,
	SessionSecurityService,
	TwoFactorService,
} from "./security.js";
import {
	InMemoryObjectStorage,
	InMemoryTaskQueue,
	OutboundGateway,
	type ObjectStorage,
	type SecretProvider,
	type TaskQueue,
} from "./services.js";
import type { CoreStore } from "./store.js";
import { CoreSettingsService, InstallationStateService } from "./settings.js";
import { CoreRestorationService } from "./restoration.js";
import { CoreEventStream } from "./event-stream.js";

export interface CoreApplication {
	readonly instanceId: string;
	readonly runtime: CoreRuntime;
	readonly authentication: AuthenticationService;
	readonly twoFactor: TwoFactorService;
	readonly csrf: CsrfProtection;
	readonly sessionSecurity: SessionSecurityService;
	readonly accountSecurity: AccountSecurityService;
	readonly settings: CoreSettingsService;
	readonly installationState: InstallationStateService;
	readonly restoration: CoreRestorationService;
	readonly eventStream: CoreEventStream;
	readonly objectStorage: ObjectStorage;
	readonly tasks: TaskQueue;
	readonly outbound: OutboundGateway;
}

export async function bootstrapCore(input: {
	readonly config: CoreConfig;
	readonly store: CoreStore;
	readonly secrets: SecretProvider;
	readonly logger: CoreLogger;
	readonly installationTokenPublisher: InstallationTokenPublisher;
	readonly services?: readonly ManagedCoreService[];
	readonly objectStorage?: ObjectStorage;
	readonly tasks?: TaskQueue;
	readonly outbound?: OutboundGateway;
	readonly now?: () => Date;
}): Promise<CoreApplication> {
	const [passwordPepper, csrfSecret, securityDigestSecret] = await Promise.all([
		input.secrets.resolve(input.config.passwordPepperSecretRef),
		input.secrets.resolve(input.config.csrfSecretRef),
		input.secrets.resolve(input.config.securityDigestSecretRef),
	]);
	const runtime = new CoreRuntime(
		input.services ?? [],
		input.logger,
		input.config.shutdownTimeoutMs,
	);
	await runtime.start();
	try {
		const instanceId = await ensureInstanceIdentity(input.store);
		const now = input.now ?? (() => new Date());
		const installationTokens = new InstallationTokenService(
			instanceId,
			input.store,
			input.installationTokenPublisher,
			input.logger,
			input.config.installationTokenTtlMs,
			now,
		);
		await installationTokens.ensureAvailable();
		const accountSecurity = new AccountSecurityService(input.store, securityDigestSecret, now);
		const authentication = new AuthenticationService(
			input.store,
			new PasswordHasher(passwordPepper),
			installationTokens,
			accountSecurity,
			new RateLimiter(input.config.loginAttemptLimit, input.config.loginAttemptWindowMs, now),
			input.config.sessionTtlMs,
			input.config.adminSessionTtlMs,
			now,
		);
		const csrf = new CsrfProtection(csrfSecret);
		return {
			instanceId,
			runtime,
			authentication,
			twoFactor: new TwoFactorService(input.store, now),
			csrf,
			sessionSecurity: new SessionSecurityService(authentication, csrf),
			accountSecurity,
			settings: new CoreSettingsService(input.store),
			installationState: new InstallationStateService(instanceId, input.store),
			restoration: new CoreRestorationService(input.store),
			eventStream: new CoreEventStream(input.store, securityDigestSecret),
			objectStorage: input.objectStorage ?? new InMemoryObjectStorage(),
			tasks: input.tasks ?? new InMemoryTaskQueue(),
			outbound: input.outbound ?? new OutboundGateway(input.config.outboundHosts),
		};
	} catch (error) {
		await runtime.stop();
		throw error;
	}
}
