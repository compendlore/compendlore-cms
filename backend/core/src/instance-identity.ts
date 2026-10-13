import type { InstanceIdentityCryptography } from "../../security-kernel/src/index.js";
import { CoreError } from "./errors.js";
import type { CoreInstanceIdentity, CoreStore } from "./store.js";

export interface InstanceIdentityChallenge {
	readonly audience: string;
	readonly nonce: string;
	readonly expiresAt: Date;
}

export interface SignedInstanceIdentityChallenge {
	readonly identityIdentifier: string;
	readonly algorithm: "Ed25519";
	readonly formatVersion: 1;
	readonly publicKey: string;
	readonly publicKeyFingerprint: string;
	readonly payload: string;
	readonly signature: string;
}

export class CoreInstanceIdentityService {
	private identity?: CoreInstanceIdentity;

	constructor(
		private readonly instanceId: string,
		private readonly store: CoreStore,
		private readonly cryptography: InstanceIdentityCryptography,
		private readonly now: () => Date = () => new Date(),
	) {}

	async ensure(): Promise<CoreInstanceIdentity> {
		const cryptographicIdentity = await this.cryptography.ensure(this.instanceId);
		const existing = await this.store.getInstanceIdentity(this.instanceId);
		if (existing) {
			this.assertMatches(existing, cryptographicIdentity);
			this.identity = existing;
			return cloneIdentity(existing);
		}
		const now = this.now();
		const created: CoreInstanceIdentity = {
			instanceId: this.instanceId,
			...cryptographicIdentity,
			createdAt: now,
			updatedAt: now,
		};
		await this.store.setInstanceIdentity(created);
		const persisted = await this.store.getInstanceIdentity(this.instanceId);
		if (!persisted) {
			throw new CoreError(
				"infrastructure.unavailable",
				"L’identité cryptographique de l’instance n’a pas été persistée.",
			);
		}
		this.assertMatches(persisted, cryptographicIdentity);
		this.identity = persisted;
		return cloneIdentity(persisted);
	}

	current(): CoreInstanceIdentity {
		if (!this.identity) {
			throw new CoreError(
				"lifecycle.invalid_state",
				"L’identité cryptographique de l’instance n’est pas initialisée.",
			);
		}
		return cloneIdentity(this.identity);
	}

	async signChallenge(
		challenge: InstanceIdentityChallenge,
	): Promise<SignedInstanceIdentityChallenge> {
		const identity = this.current();
		assertChallenge(challenge, this.now());
		const payload = JSON.stringify({
			audience: challenge.audience,
			expiresAt: challenge.expiresAt.toISOString(),
			formatVersion: identity.formatVersion,
			identityIdentifier: identity.identifier,
			instanceId: identity.instanceId,
			nonce: challenge.nonce,
		});
		const signature = await this.cryptography.sign(this.instanceId, Buffer.from(payload, "utf8"));
		return {
			identityIdentifier: identity.identifier,
			algorithm: identity.algorithm,
			formatVersion: identity.formatVersion,
			publicKey: Buffer.from(identity.publicKey).toString("base64url"),
			publicKeyFingerprint: identity.publicKeyFingerprint,
			payload: Buffer.from(payload, "utf8").toString("base64url"),
			signature: Buffer.from(signature).toString("base64url"),
		};
	}

	private assertMatches(
		stored: CoreInstanceIdentity,
		cryptographic: Awaited<ReturnType<InstanceIdentityCryptography["ensure"]>>,
	): void {
		if (
			stored.identifier !== cryptographic.identifier ||
			stored.algorithm !== cryptographic.algorithm ||
			stored.formatVersion !== cryptographic.formatVersion ||
			stored.publicKeyFingerprint !== cryptographic.publicKeyFingerprint ||
			stored.keyReference !== cryptographic.keyReference ||
			stored.assurance !== cryptographic.assurance ||
			!Buffer.from(stored.publicKey).equals(Buffer.from(cryptographic.publicKey))
		) {
			throw new CoreError(
				"lifecycle.invalid_state",
				"La clé privée disponible ne correspond pas à l’identité publique de l’instance.",
			);
		}
	}
}

function assertChallenge(challenge: InstanceIdentityChallenge, now: Date): void {
	if (!challenge.audience.trim() || challenge.audience.length > 255) {
		throw new CoreError("configuration.invalid", "L’audience du défi est invalide.");
	}
	if (!/^[A-Za-z0-9_-]{16,256}$/u.test(challenge.nonce)) {
		throw new CoreError("configuration.invalid", "Le nonce du défi est invalide.");
	}
	const remaining = challenge.expiresAt.getTime() - now.getTime();
	if (remaining <= 0 || remaining > 300_000) {
		throw new CoreError("configuration.invalid", "L’expiration du défi est invalide.");
	}
}

function cloneIdentity(identity: CoreInstanceIdentity): CoreInstanceIdentity {
	return { ...identity, publicKey: identity.publicKey.slice() };
}
