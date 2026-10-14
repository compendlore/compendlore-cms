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
import {
	CoreSecurityAudit,
	DefaultCoreSecurityBoundary,
	type CoreSecurityBoundary,
} from "./security-boundary.js";
import {
	InMemoryInstancePrivateKeyStore,
	InstanceIdentityCryptography,
	SecurityKernel,
} from "../../security-kernel/src/index.js";
import { CoreInstanceIdentityService } from "./instance-identity.js";
import {
	InMemoryMessagingRepository,
	PersistentMessagingService,
	type MessagingRepository,
} from "./messaging.js";
import {
	InMemoryMessageAudienceDirectory,
	InMemoryMessageDeliveryRepository,
	MessageDeliveryService,
	type MessageAudienceDirectory,
	type MessageDeliveryRepository,
} from "./message-delivery.js";
import {
	InMemoryNotificationTemplateRepository,
	NotificationTemplateService,
	type NotificationConnectorCatalog,
	type NotificationTemplateRepository,
} from "./notification-templates.js";
import {
	InMemoryMessagingCampaignRepository,
	MessagingCampaignService,
	type MessagingCampaignAudiencePreview,
	type MessagingCampaignAuthorization,
	type MessagingCampaignPublisher,
	type MessagingCampaignRepository,
	type MessagingContributionState,
} from "./messaging-campaigns.js";

const defaultInstancePrivateKeyStore = new InMemoryInstancePrivateKeyStore();

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
	readonly securityBoundary: CoreSecurityBoundary;
	readonly instanceIdentity: CoreInstanceIdentityService;
	readonly messaging: PersistentMessagingService;
	readonly messageDelivery: MessageDeliveryService;
	readonly notifications: NotificationTemplateService;
	readonly messagingCampaigns: MessagingCampaignService;
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
	readonly instanceIdentityCryptography?: InstanceIdentityCryptography;
	readonly messagingRepository?: MessagingRepository;
	readonly messageAudienceDirectory?: MessageAudienceDirectory;
	readonly messageDeliveryRepository?: MessageDeliveryRepository;
	readonly notificationTemplateRepository?: NotificationTemplateRepository;
	readonly notificationConnectorCatalog?: NotificationConnectorCatalog;
	readonly messagingCampaignRepository?: MessagingCampaignRepository;
	readonly messagingCampaignAuthorization?: MessagingCampaignAuthorization;
	readonly messagingContributionState?: MessagingContributionState;
	readonly messagingCampaignAudiencePreview?: MessagingCampaignAudiencePreview;
	readonly messagingCampaignPublisher?: MessagingCampaignPublisher;
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
		const instanceIdentity = new CoreInstanceIdentityService(
			instanceId,
			input.store,
			input.instanceIdentityCryptography ??
				new InstanceIdentityCryptography(defaultInstancePrivateKeyStore),
			now,
		);
		await instanceIdentity.ensure();
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
		const securityBoundary = new DefaultCoreSecurityBoundary(
			new SecurityKernel(new CoreSecurityAudit(input.store, securityDigestSecret), 30_000, now),
		);
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
		const notifications = new NotificationTemplateService(
			input.notificationTemplateRepository ?? new InMemoryNotificationTemplateRepository(),
			input.notificationConnectorCatalog ?? {
				async hasConnector() {
					return false;
				},
			},
		);
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
			securityBoundary,
			instanceIdentity,
			messaging: new PersistentMessagingService(
				input.messagingRepository ?? new InMemoryMessagingRepository(),
				now,
				input.messagingContributionState ?? activeMessagingContributions,
			),
			messageDelivery: new MessageDeliveryService(
				input.messageAudienceDirectory ?? new InMemoryMessageAudienceDirectory({}),
				input.messageDeliveryRepository ?? new InMemoryMessageDeliveryRepository(),
				now,
			),
			notifications,
			messagingCampaigns: new MessagingCampaignService(
				input.messagingCampaignRepository ?? new InMemoryMessagingCampaignRepository(),
				input.messagingCampaignAuthorization ?? denyCampaignAuthorization,
				input.messagingContributionState ?? activeMessagingContributions,
				input.messagingCampaignAudiencePreview ?? unavailableCampaignAudiencePreview,
				notifications,
				input.messagingCampaignPublisher ?? unavailableCampaignPublisher,
				now,
			),
			objectStorage: input.objectStorage ?? new InMemoryObjectStorage(),
			tasks: input.tasks ?? new InMemoryTaskQueue(),
			outbound: input.outbound ?? new OutboundGateway(input.config.outboundHosts),
		};
	} catch (error) {
		await runtime.stop();
		throw error;
	}
}

const denyCampaignAuthorization: MessagingCampaignAuthorization = {
	async hasCapability() {
		return false;
	},
};

const activeMessagingContributions: MessagingContributionState = {
	async isActive() {
		return true;
	},
};

const unavailableCampaignAudiencePreview: MessagingCampaignAudiencePreview = {
	async preview() {
		throw new Error("The campaign audience preview is not configured.");
	},
};

const unavailableCampaignPublisher: MessagingCampaignPublisher = {
	async sendTest() {
		throw new Error("The campaign publisher is not configured.");
	},
	async publish() {
		throw new Error("The campaign publisher is not configured.");
	},
	async revoke() {
		throw new Error("The campaign publisher is not configured.");
	},
	async replayDeadLetter() {
		throw new Error("The campaign publisher is not configured.");
	},
	async deliverySummary() {
		throw new Error("The campaign publisher is not configured.");
	},
};
