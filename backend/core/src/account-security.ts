import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { CoreError } from "./errors.js";
import { validateCoreJsonValue } from "./settings.js";
import type {
	CoreEmailAddress,
	CoreIpBan,
	CoreJsonValue,
	CorePasskey,
	CoreSecurityAttempt,
	CoreSecurityToken,
	CoreSessionDeviceProof,
	CoreStore,
	CoreUserBan,
	CoreWebAuthnChallenge,
	SecurityTokenPurpose,
} from "./store.js";

export class AccountSecurityService {
	constructor(
		private readonly store: CoreStore,
		private readonly digestSecret: string,
		private readonly now: () => Date = () => new Date(),
	) {}

	async registerEmail(input: {
		userId: string;
		email: string;
		primary?: boolean;
	}): Promise<CoreEmailAddress> {
		const email = input.email.trim();
		if (email.length > 320) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		const normalizedEmail = normalizeEmail(email);
		const now = this.now();
		const registered: CoreEmailAddress = {
			id: randomUUID(),
			userId: input.userId,
			email,
			normalizedEmail,
			primary: input.primary ?? false,
			createdAt: now,
			updatedAt: now,
		};
		await this.store.upsertEmailAddress(registered);
		return registered;
	}

	async verifyEmail(email: string, verifiedAt = this.now()): Promise<void> {
		const registered = await this.store.findEmailAddress(normalizeEmail(email));
		if (!registered) throw new CoreError("configuration.invalid", "Invalid configuration.");
		await this.store.markEmailVerified(registered.id, verifiedAt);
	}

	async issueSecurityToken(input: {
		purpose: SecurityTokenPurpose;
		userId?: string;
		ttlMs: number;
		metadata?: Readonly<Record<string, CoreJsonValue>>;
	}): Promise<{ readonly token: string; readonly record: CoreSecurityToken }> {
		assertPositiveTtl(input.ttlMs);
		validateCoreJsonValue(input.metadata ?? {});
		const token = randomBytes(32).toString("base64url");
		const createdAt = this.now();
		const record: CoreSecurityToken = {
			id: randomUUID(),
			...(input.userId ? { userId: input.userId } : {}),
			purpose: input.purpose,
			tokenDigest: this.digest(token),
			createdAt,
			expiresAt: new Date(createdAt.getTime() + input.ttlMs),
			metadata: input.metadata ?? {},
		};
		await this.store.createSecurityToken(record);
		return { token, record };
	}

	async consumeSecurityToken(
		purpose: SecurityTokenPurpose,
		token: string,
	): Promise<CoreSecurityToken> {
		const consumed = token
			? await this.store.consumeSecurityToken(purpose, this.digest(token), this.now())
			: undefined;
		if (!consumed) {
			throw new CoreError("authentication.invalid_credentials", "Invalid credentials.");
		}
		return consumed;
	}

	async registerPasskey(
		passkey: Omit<CorePasskey, "id" | "createdAt" | "lastUsedAt" | "signCount"> & {
			readonly signCount?: number;
		},
	): Promise<CorePasskey> {
		if (
			!passkey.displayName.trim() ||
			passkey.displayName.length > 128 ||
			passkey.credentialId.length === 0 ||
			passkey.credentialId.length > 1024 ||
			passkey.publicKey.length === 0 ||
			passkey.publicKey.length > 16_384 ||
			passkey.transports.length > 8 ||
			passkey.transports.some((transport) => !WEBAUTHN_TRANSPORTS.has(transport))
		) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		const registered: CorePasskey = {
			...passkey,
			id: randomUUID(),
			displayName: passkey.displayName.trim(),
			signCount: passkey.signCount ?? 0,
			createdAt: this.now(),
		};
		if (!Number.isSafeInteger(registered.signCount) || registered.signCount < 0) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		await this.store.createPasskey(registered);
		return registered;
	}

	listPasskeys(userId: string): Promise<readonly CorePasskey[]> {
		return this.store.listPasskeys(userId);
	}

	async recordPasskeyUse(userId: string, passkeyId: string, nextSignCount: number): Promise<void> {
		const passkey = (await this.store.listPasskeys(userId)).find(
			(candidate) => candidate.id === passkeyId,
		);
		if (!passkey || !Number.isSafeInteger(nextSignCount) || nextSignCount <= passkey.signCount) {
			throw new CoreError("authentication.invalid_credentials", "Invalid credentials.");
		}
		await this.store.updatePasskeyUsage(passkeyId, nextSignCount, this.now());
	}

	deletePasskey(userId: string, passkeyId: string): Promise<void> {
		return this.store.deletePasskey(passkeyId, userId);
	}

	async issueWebAuthnChallenge(input: {
		purpose: CoreWebAuthnChallenge["purpose"];
		userId?: string;
		sessionId?: string;
		ttlMs: number;
		metadata?: Readonly<Record<string, CoreJsonValue>>;
	}): Promise<{ readonly challenge: string; readonly record: CoreWebAuthnChallenge }> {
		assertPositiveTtl(input.ttlMs);
		validateCoreJsonValue(input.metadata ?? {});
		const challenge = randomBytes(32).toString("base64url");
		const createdAt = this.now();
		const record: CoreWebAuthnChallenge = {
			id: randomUUID(),
			...(input.userId ? { userId: input.userId } : {}),
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
			purpose: input.purpose,
			challengeDigest: this.digest(challenge),
			createdAt,
			expiresAt: new Date(createdAt.getTime() + input.ttlMs),
			metadata: input.metadata ?? {},
		};
		await this.store.createWebAuthnChallenge(record);
		return { challenge, record };
	}

	async consumeWebAuthnChallenge(
		purpose: CoreWebAuthnChallenge["purpose"],
		challenge: string,
	): Promise<CoreWebAuthnChallenge> {
		const consumed = challenge
			? await this.store.consumeWebAuthnChallenge(purpose, this.digest(challenge), this.now())
			: undefined;
		if (!consumed) {
			throw new CoreError("authentication.invalid_credentials", "Invalid credentials.");
		}
		return consumed;
	}

	async issueDeviceProof(input: {
		sessionId: string;
		deviceIdentifier: string;
		ttlMs: number;
	}): Promise<string> {
		assertPositiveTtl(input.ttlMs);
		if (!input.deviceIdentifier.trim()) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		const proof = randomBytes(32).toString("base64url");
		const createdAt = this.now();
		await this.store.upsertSessionDeviceProof({
			id: randomUUID(),
			sessionId: input.sessionId,
			deviceIdentifierDigest: this.digest(input.deviceIdentifier),
			proofDigest: this.digest(proof),
			createdAt,
			expiresAt: new Date(createdAt.getTime() + input.ttlMs),
			lastSeenAt: createdAt,
		});
		return proof;
	}

	async verifyDeviceProof(proof: string): Promise<CoreSessionDeviceProof> {
		const stored = proof ? await this.store.findSessionDeviceProof(this.digest(proof)) : undefined;
		if (!stored || stored.revokedAt || stored.expiresAt.getTime() <= this.now().getTime()) {
			throw new CoreError("authentication.invalid_credentials", "Invalid credentials.");
		}
		return stored;
	}

	revokeDeviceProof(proofId: string): Promise<void> {
		return this.store.revokeSessionDeviceProof(proofId, this.now());
	}

	async banUser(input: {
		userId: string;
		reason: string;
		createdBy?: string;
		expiresAt?: Date;
		metadata?: Readonly<Record<string, CoreJsonValue>>;
	}): Promise<CoreUserBan> {
		const now = this.now();
		assertBan(input.reason, input.expiresAt, now);
		validateCoreJsonValue(input.metadata ?? {});
		const ban: CoreUserBan = {
			id: randomUUID(),
			userId: input.userId,
			reason: input.reason.trim(),
			startsAt: now,
			...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
			...(input.createdBy ? { createdBy: input.createdBy } : {}),
			createdAt: now,
			metadata: input.metadata ?? {},
		};
		await this.store.createUserBan(ban);
		return ban;
	}

	async banAddress(input: {
		address: string;
		reason: string;
		createdBy?: string;
		expiresAt?: Date;
		metadata?: Readonly<Record<string, CoreJsonValue>>;
	}): Promise<CoreIpBan> {
		const now = this.now();
		assertBan(input.reason, input.expiresAt, now);
		validateCoreJsonValue(input.metadata ?? {});
		const ban: CoreIpBan = {
			id: randomUUID(),
			addressDigest: this.digestAddress(input.address),
			reason: input.reason.trim(),
			startsAt: now,
			...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
			...(input.createdBy ? { createdBy: input.createdBy } : {}),
			createdAt: now,
			metadata: input.metadata ?? {},
		};
		await this.store.createIpBan(ban);
		return ban;
	}

	revokeUserBan(banId: string, revokedBy?: string): Promise<void> {
		return this.store.revokeUserBan(banId, revokedBy, this.now());
	}

	revokeAddressBan(banId: string, revokedBy?: string): Promise<void> {
		return this.store.revokeIpBan(banId, revokedBy, this.now());
	}

	async assertAccessAllowed(userId?: string, address?: string): Promise<void> {
		const now = this.now();
		if (address && (await this.store.isAddressBanned(this.digestAddress(address), now))) {
			throw new CoreError("authorization.denied", "Access denied.");
		}
		if (userId && (await this.store.isUserBanned(userId, now))) {
			throw new CoreError("authorization.denied", "Access denied.");
		}
	}

	async recordAttempt(input: {
		kind: string;
		outcome: CoreSecurityAttempt["outcome"];
		subject?: string;
		address?: string;
		metadata?: Readonly<Record<string, CoreJsonValue>>;
	}): Promise<void> {
		if (!input.kind.trim()) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		validateCoreJsonValue(input.metadata ?? {});
		await this.store.appendSecurityAttempt({
			id: randomUUID(),
			kind: input.kind.trim(),
			...(input.subject ? { subjectDigest: this.digest(input.subject) } : {}),
			...(input.address ? { addressDigest: this.digestAddress(input.address) } : {}),
			outcome: input.outcome,
			occurredAt: this.now(),
			metadata: input.metadata ?? {},
		});
	}

	async purgeExpired(attemptRetentionMs: number): Promise<void> {
		assertPositiveTtl(attemptRetentionMs);
		const now = this.now();
		await this.store.purgeSecurityData(now, new Date(now.getTime() - attemptRetentionMs));
	}

	digestAddress(address: string): string {
		const normalized = address.trim().toLowerCase();
		if (!normalized) throw new CoreError("configuration.invalid", "Invalid configuration.");
		return this.digest(`network:${normalized}`);
	}

	private digest(value: string): string {
		return createHmac("sha256", this.digestSecret).update(value).digest("hex");
	}
}

function normalizeEmail(value: string): string {
	const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
		throw new CoreError("configuration.invalid", "Invalid configuration.");
	}
	return normalized;
}

function assertPositiveTtl(ttlMs: number): void {
	if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
		throw new CoreError("configuration.invalid", "Invalid configuration.");
	}
}

function assertBan(reason: string, expiresAt: Date | undefined, now: Date): void {
	if (!reason.trim() || reason.length > 2_000) {
		throw new CoreError("configuration.invalid", "Invalid configuration.");
	}
	if (expiresAt && expiresAt.getTime() <= now.getTime()) {
		throw new CoreError("configuration.invalid", "Invalid configuration.");
	}
}

const WEBAUTHN_TRANSPORTS = new Set([
	"ble",
	"cable",
	"hybrid",
	"internal",
	"nfc",
	"smart-card",
	"usb",
]);
