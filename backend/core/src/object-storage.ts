import { CoreError } from "./errors.js";
import type { ManagedCoreService, ServiceHealth } from "./lifecycle.js";
import { validateStorageKey, type ObjectStorage } from "./services.js";

export interface ObjectBucket {
	upload(name: string, data: Buffer, options?: { readonly contentType?: string }): Promise<unknown>;
	download(name: string): Promise<Buffer>;
	exists(name: string): Promise<boolean>;
	remove(name: string): Promise<void>;
}

export class ManagedObjectStorage implements ObjectStorage, ManagedCoreService {
	readonly name = "object-storage";

	constructor(private readonly bucket: ObjectBucket) {}

	async start(): Promise<void> {
		if ((await this.health()) !== "healthy") {
			throw new CoreError("infrastructure.unavailable", "Le stockage objet est indisponible.", {
				retryable: true,
			});
		}
	}

	async stop(): Promise<void> {
		// L'adaptateur d'infrastructure possède le cycle de vie du bucket.
	}

	async health(): Promise<ServiceHealth> {
		try {
			await this.bucket.exists("core/health/probe");
			return "healthy";
		} catch {
			return "unhealthy";
		}
	}

	async put(key: string, content: Uint8Array, contentType: string): Promise<void> {
		validateObjectContentType(contentType);
		try {
			await this.bucket.upload(validateStorageKey(key), Buffer.from(content), { contentType });
		} catch (error) {
			throw objectStorageUnavailable(error);
		}
	}

	async get(key: string): Promise<Uint8Array | undefined> {
		const validatedKey = validateStorageKey(key);
		try {
			if (!(await this.bucket.exists(validatedKey))) return undefined;
			return new Uint8Array(await this.bucket.download(validatedKey));
		} catch (error) {
			throw objectStorageUnavailable(error);
		}
	}

	async delete(key: string): Promise<void> {
		const validatedKey = validateStorageKey(key);
		try {
			if (await this.bucket.exists(validatedKey)) await this.bucket.remove(validatedKey);
		} catch (error) {
			throw objectStorageUnavailable(error);
		}
	}
}

export function validateObjectContentType(contentType: string): void {
	if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(contentType)) {
		throw new CoreError("configuration.invalid", "Le type de contenu est invalide.");
	}
}

export function objectStorageUnavailable(cause: unknown): CoreError {
	return new CoreError("infrastructure.unavailable", "Le stockage objet est indisponible.", {
		cause,
		retryable: true,
	});
}
