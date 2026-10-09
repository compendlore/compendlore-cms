import { bootstrapCore, type CoreApplication } from "./bootstrap.js";
import type { CoreConfig } from "./config.js";
import { coreDatabase, type CoreDatabase } from "../database.js";
import type { ManagedCoreService } from "./lifecycle.js";
import type { CoreLogger } from "./logging.js";
import { SecureFileInstallationTokenPublisher } from "./installation.js";
import { PostgresCoreStore } from "./postgres-store.js";
import { AesGcmSecretCipher } from "./security.js";
import type { SecretProvider } from "./services.js";

export async function bootstrapEncoreCore(input: {
	readonly config: CoreConfig;
	readonly secrets: SecretProvider;
	readonly logger: CoreLogger;
	readonly services?: readonly ManagedCoreService[];
}): Promise<CoreApplication & { readonly database: CoreDatabase }> {
	const dataEncryptionSecret = await input.secrets.resolve(input.config.dataEncryptionSecretRef);
	const application = await bootstrapCore({
		config: input.config,
		store: new PostgresCoreStore(coreDatabase, new AesGcmSecretCipher(dataEncryptionSecret)),
		secrets: input.secrets,
		logger: input.logger,
		installationTokenPublisher: new SecureFileInstallationTokenPublisher(
			input.config.installationTokenFile,
		),
		...(input.services ? { services: input.services } : {}),
	});
	return { ...application, database: coreDatabase };
}
