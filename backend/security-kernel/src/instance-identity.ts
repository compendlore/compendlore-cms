import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomUUID,
	sign as signBytes,
	verify as verifyBytes,
} from "node:crypto";

export interface StoredInstanceIdentity {
	readonly installationId: string;
	readonly privateKeyPkcs8: Uint8Array;
	readonly createdAt: Date;
}

export interface InstanceIdentitySecretPort {
	load(): Promise<StoredInstanceIdentity | undefined>;
	store(identity: StoredInstanceIdentity): Promise<void>;
}

export class InMemoryInstanceIdentitySecretPort implements InstanceIdentitySecretPort {
	private identity?: StoredInstanceIdentity;

	async load(): Promise<StoredInstanceIdentity | undefined> {
		return this.identity ? cloneStoredIdentity(this.identity) : undefined;
	}

	async store(identity: StoredInstanceIdentity): Promise<void> {
		if (this.identity) throw new InstanceIdentityError("security.instance_identity_exists");
		this.identity = cloneStoredIdentity(identity);
	}
}

export interface InstanceIdentityPublicRecord {
	readonly installationId: string;
	readonly algorithm: "Ed25519";
	readonly publicKeySpki: string;
	readonly fingerprint: string;
	readonly assurance: "software";
	readonly createdAt: Date;
}

export class InstanceIdentityService {
	constructor(
		private readonly secrets: InstanceIdentitySecretPort,
		private readonly now: () => Date = () => new Date(),
	) {}

	async loadOrCreate(): Promise<InstanceIdentityPublicRecord> {
		let stored = await this.secrets.load();
		if (!stored) {
			const pair = generateKeyPairSync("ed25519");
			stored = {
				installationId: randomUUID(),
				privateKeyPkcs8: pair.privateKey.export({ type: "pkcs8", format: "der" }),
				createdAt: this.now(),
			};
			await this.secrets.store(stored);
		}
		return publicRecord(stored);
	}

	async sign(challenge: Uint8Array): Promise<Uint8Array> {
		const stored = await this.secrets.load();
		if (!stored) throw new InstanceIdentityError("security.instance_identity_missing");
		return signBytes(null, challenge, {
			key: Buffer.from(stored.privateKeyPkcs8),
			format: "der",
			type: "pkcs8",
		});
	}

	static verify(publicKeySpki: string, challenge: Uint8Array, signature: Uint8Array): boolean {
		return verifyBytes(
			null,
			challenge,
			{ key: Buffer.from(publicKeySpki, "base64url"), format: "der", type: "spki" },
			signature,
		);
	}
}

export class InstanceIdentityError extends Error {
	constructor(readonly code: string) {
		super("L’identité cryptographique de l’instance est indisponible.");
		this.name = "InstanceIdentityError";
	}
}

function publicRecord(stored: StoredInstanceIdentity): InstanceIdentityPublicRecord {
	const privateKey = {
		key: Buffer.from(stored.privateKeyPkcs8),
		format: "der" as const,
		type: "pkcs8" as const,
	};
	const publicKey = createPublicKey(createPrivateKey(privateKey)).export({
		type: "spki",
		format: "der",
	});
	const publicKeySpki = publicKey.toString("base64url");
	return {
		installationId: stored.installationId,
		algorithm: "Ed25519",
		publicKeySpki,
		fingerprint: createHash("sha256").update(publicKey).digest("base64url"),
		assurance: "software",
		createdAt: new Date(stored.createdAt),
	};
}

function cloneStoredIdentity(identity: StoredInstanceIdentity): StoredInstanceIdentity {
	return {
		installationId: identity.installationId,
		privateKeyPkcs8: identity.privateKeyPkcs8.slice(),
		createdAt: new Date(identity.createdAt),
	};
}
