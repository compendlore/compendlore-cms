import { bootstrapCore, type CoreApplication } from "./bootstrap.js";
import type { CoreConfig } from "./config.js";
import { coreDatabase, type CoreDatabase } from "../database.js";
import type { ManagedCoreService } from "./lifecycle.js";
import type { CoreLogger } from "./logging.js";
import { SecureFileInstallationTokenPublisher } from "./installation.js";
import { PostgresCoreStore } from "./postgres-store.js";
import { AesGcmSecretCipher } from "./security.js";
import type { SecretProvider } from "./services.js";
import { OutboundGateway } from "./services.js";
import { encoreObjectStorage } from "../object-storage.js";
import { PostgresTaskQueue } from "../task-queue.js";
import {
	InstanceIdentityCryptography,
	SecureFileInstancePrivateKeyStore,
} from "../../security-kernel/src/index.js";

export async function bootstrapEncoreCore(input: {
	readonly config: CoreConfig;
	readonly secrets: SecretProvider;
	readonly logger: CoreLogger;
	readonly services?: readonly ManagedCoreService[];
}): Promise<CoreApplication & { readonly database: CoreDatabase }> {
	const dataEncryptionSecret = await input.secrets.resolve(input.config.dataEncryptionSecretRef);
	const objectStorage = encoreObjectStorage;
	const application = await bootstrapCore({
		config: input.config,
		store: new PostgresCoreStore(coreDatabase, new AesGcmSecretCipher(dataEncryptionSecret)),
		secrets: input.secrets,
		logger: input.logger,
		installationTokenPublisher: new SecureFileInstallationTokenPublisher(
			input.config.installationTokenFile,
		),
		instanceIdentityCryptography: new InstanceIdentityCryptography(
			new SecureFileInstancePrivateKeyStore(input.config.instancePrivateKeyFile),
		),
		services: [coreDatabase, objectStorage, ...(input.services ?? [])],
		objectStorage,
		tasks: new PostgresTaskQueue(coreDatabase),
		outbound: new OutboundGateway(input.config.outboundHosts),
	});
	return { ...application, database: coreDatabase };
}
