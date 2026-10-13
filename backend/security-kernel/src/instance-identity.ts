import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign,
	type KeyObject,
} from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type InstanceIdentityAssurance = "hardware" | "protected-file" | "system";

export interface StoredInstancePrivateKey {
	readonly privateKeyPem: string;
	readonly reference: string;
	readonly assurance: InstanceIdentityAssurance;
}

export interface InstancePrivateKeyStore {
	load(instanceId: string): Promise<StoredInstancePrivateKey | undefined>;
	create(instanceId: string, privateKeyPem: string): Promise<StoredInstancePrivateKey>;
}

export interface InstanceCryptographicIdentity {
	readonly identifier: string;
	readonly algorithm: "Ed25519";
	readonly formatVersion: 1;
	readonly publicKey: Uint8Array;
	readonly publicKeyFingerprint: string;
	readonly keyReference: string;
	readonly assurance: InstanceIdentityAssurance;
}

export class InstanceIdentityCryptography {
	private readonly privateKeys = new Map<string, KeyObject>();

	constructor(private readonly store: InstancePrivateKeyStore) {}

	async ensure(instanceId: string): Promise<InstanceCryptographicIdentity> {
		assertInstanceId(instanceId);
		let stored = await this.store.load(instanceId);
		if (!stored) {
			const pair = generateKeyPairSync("ed25519");
			const privateKeyPem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
			stored = await this.store.create(instanceId, privateKeyPem);
		}
		const privateKey = parsePrivateKey(stored.privateKeyPem);
		this.privateKeys.set(instanceId, privateKey);
		return publicIdentity(privateKey, stored);
	}

	async sign(instanceId: string, payload: Uint8Array): Promise<Uint8Array> {
		assertInstanceId(instanceId);
		let privateKey = this.privateKeys.get(instanceId);
		if (!privateKey) {
			const stored = await this.store.load(instanceId);
			if (!stored) throw new InstanceIdentityError("identity.private_key_unavailable");
			privateKey = parsePrivateKey(stored.privateKeyPem);
			this.privateKeys.set(instanceId, privateKey);
		}
		return Uint8Array.from(sign(null, payload, privateKey));
	}
}

export class InMemoryInstancePrivateKeyStore implements InstancePrivateKeyStore {
	private readonly keys = new Map<string, StoredInstancePrivateKey>();

	async load(instanceId: string): Promise<StoredInstancePrivateKey | undefined> {
		return this.keys.get(instanceId);
	}

	async create(instanceId: string, privateKeyPem: string): Promise<StoredInstancePrivateKey> {
		const existing = this.keys.get(instanceId);
		if (existing) return existing;
		const stored: StoredInstancePrivateKey = {
			privateKeyPem,
			reference: `memory:instance-identity:${instanceId}`,
			assurance: "protected-file",
		};
		this.keys.set(instanceId, stored);
		return stored;
	}
}

export class SecureFileInstancePrivateKeyStore implements InstancePrivateKeyStore {
	private readonly path: string;

	constructor(path: string) {
		if (!path.trim()) throw new InstanceIdentityError("identity.key_path_invalid");
		this.path = resolve(path);
	}

	async load(): Promise<StoredInstancePrivateKey | undefined> {
		try {
			const privateKeyPem = await readFile(this.path, "utf8");
			return this.stored(privateKeyPem);
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return undefined;
			throw new InstanceIdentityError("identity.private_key_unavailable", { cause: error });
		}
	}

	async create(instanceId: string, privateKeyPem: string): Promise<StoredInstancePrivateKey> {
		assertInstanceId(instanceId);
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		try {
			const file = await open(this.path, "wx", 0o600);
			try {
				await file.writeFile(privateKeyPem, { encoding: "utf8" });
				await file.sync();
			} finally {
				await file.close();
			}
			await chmod(this.path, 0o600);
			return this.stored(privateKeyPem);
		} catch (error) {
			if (isNodeError(error, "EEXIST")) {
				const existing = await this.load();
				if (existing) return existing;
			}
			throw new InstanceIdentityError("identity.private_key_unavailable", { cause: error });
		}
	}

	private stored(privateKeyPem: string): StoredInstancePrivateKey {
		return {
			privateKeyPem,
			reference: "protected-file:instance-identity",
			assurance: "protected-file",
		};
	}
}

export class InstanceIdentityError extends Error {
	constructor(
		readonly code: string,
		options?: ErrorOptions,
	) {
		super("L’identité cryptographique de l’instance est indisponible.", options);
		this.name = "InstanceIdentityError";
	}
}

function publicIdentity(
	privateKey: KeyObject,
	stored: StoredInstancePrivateKey,
): InstanceCryptographicIdentity {
	const publicKey = Uint8Array.from(
		createPublicKey(privateKey).export({ format: "der", type: "spki" }),
	);
	const publicKeyFingerprint = createHash("sha256").update(publicKey).digest("base64url");
	return {
		identifier: `compendlore:instance:v1:${publicKeyFingerprint}`,
		algorithm: "Ed25519",
		formatVersion: 1,
		publicKey,
		publicKeyFingerprint,
		keyReference: stored.reference,
		assurance: stored.assurance,
	};
}

function parsePrivateKey(privateKeyPem: string): KeyObject {
	try {
		const privateKey = createPrivateKey(privateKeyPem);
		if (privateKey.asymmetricKeyType !== "ed25519") {
			throw new InstanceIdentityError("identity.algorithm_invalid");
		}
		return privateKey;
	} catch (error) {
		if (error instanceof InstanceIdentityError) throw error;
		throw new InstanceIdentityError("identity.private_key_invalid", { cause: error });
	}
}

function assertInstanceId(instanceId: string): void {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(instanceId)
	) {
		throw new InstanceIdentityError("identity.instance_id_invalid");
	}
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
