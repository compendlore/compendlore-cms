import { Bucket } from "encore.dev/storage/objects";
import { CoreError } from "./src/errors.js";
import type { ManagedCoreService, ServiceHealth } from "./src/lifecycle.js";
import { objectStorageUnavailable, validateObjectContentType } from "./src/object-storage.js";
import { validateStorageKey, type ObjectStorage } from "./src/services.js";

export const coreObjectBucket = new Bucket("core-private-objects", {
	public: false,
	versioned: true,
});

export class EncoreObjectStorage implements ObjectStorage, ManagedCoreService {
	readonly name = "object-storage";

	async start(): Promise<void> {
		if ((await this.health()) !== "healthy") {
			throw new CoreError(
				"infrastructure.unavailable",
				"The required infrastructure is unavailable.",
				{
					retryable: true,
				},
			);
		}
	}

	async stop(): Promise<void> {
		// Encore possède le cycle de vie du stockage objet.
	}

	async health(): Promise<ServiceHealth> {
		try {
			await coreObjectBucket.exists("core/health/probe");
			return "healthy";
		} catch {
			return "unhealthy";
		}
	}

	async put(key: string, content: Uint8Array, contentType: string): Promise<void> {
		validateObjectContentType(contentType);
		try {
			await coreObjectBucket.upload(validateStorageKey(key), Buffer.from(content), { contentType });
		} catch (error) {
			throw objectStorageUnavailable(error);
		}
	}

	async get(key: string): Promise<Uint8Array | undefined> {
		const validatedKey = validateStorageKey(key);
		try {
			if (!(await coreObjectBucket.exists(validatedKey))) return undefined;
			return new Uint8Array(await coreObjectBucket.download(validatedKey));
		} catch (error) {
			throw objectStorageUnavailable(error);
		}
	}

	async delete(key: string): Promise<void> {
		const validatedKey = validateStorageKey(key);
		try {
			if (await coreObjectBucket.exists(validatedKey)) {
				await coreObjectBucket.remove(validatedKey);
			}
		} catch (error) {
			throw objectStorageUnavailable(error);
		}
	}
}

export const encoreObjectStorage = new EncoreObjectStorage();
