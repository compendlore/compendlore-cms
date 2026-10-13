import { CoreError } from "./errors.js";

export const CORE_CAPABILITIES = Object.freeze({
	administrationAccess: "core.administration.access",
	founderProtection: "core.founder.protect",
	systemManagement: "core.system.manage",
});

export interface CoreUser {
	readonly id: string;
	readonly login: string;
	readonly displayName: string;
	readonly passwordDigest: string;
	readonly founder: boolean;
	readonly active: boolean;
	readonly createdAt: Date;
}

export interface CoreSession {
	readonly id: string;
	readonly userId: string;
	readonly tokenDigest: string;
	readonly expiresAt: Date;
	readonly createdAt: Date;
	readonly revokedAt?: Date;
	readonly secondFactorVerifiedAt?: Date;
}

export interface TwoFactorRegistration {
	readonly secret: string;
	readonly recoveryCodeDigests: ReadonlySet<string>;
}

export interface CoreRole {
	readonly id: string;
	readonly identifier: string;
	readonly displayName: string;
	readonly protected: boolean;
}

export interface AuditRecord {
	readonly id: string;
	readonly occurredAt: Date;
	readonly action: string;
	readonly outcome: "allowed" | "denied" | "failed";
	readonly actorId?: string;
	readonly subjectId?: string;
	readonly correlationId: string;
	readonly metadata: Readonly<Record<string, boolean | number | string | null>>;
}

export interface CoreInstallationToken {
	readonly instanceId: string;
	readonly tokenDigest: string;
	readonly createdAt: Date;
	readonly expiresAt: Date;
	readonly consumedAt?: Date;
}

export type CoreJsonValue =
	| boolean
	| number
	| string
	| null
	| readonly CoreJsonValue[]
	| { readonly [key: string]: CoreJsonValue };

export interface CoreEvent {
	readonly id: string;
	readonly sequence: bigint;
	readonly ownerIdentifier: string;
	readonly topic: string;
	readonly schemaVersion: number;
	readonly payload: Readonly<Record<string, CoreJsonValue>>;
	readonly payloadChecksum: string;
	readonly signature: string;
	readonly occurredAt: Date;
	readonly receivedAt: Date;
	readonly retentionUntil: Date;
	readonly idempotencyKey?: string;
}

export interface CoreEventConsumer {
	readonly identifier: string;
	readonly ownerIdentifier: string;
	readonly topics: readonly string[];
	readonly lastSequence: bigint;
	readonly active: boolean;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

export interface CoreEmailAddress {
	readonly id: string;
	readonly userId: string;
	readonly email: string;
	readonly normalizedEmail: string;
	readonly primary: boolean;
	readonly verifiedAt?: Date;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

export type SecurityTokenPurpose =
	"account-activation" | "email-verification" | "password-reset" | "two-factor-reset";

export interface CoreSecurityToken {
	readonly id: string;
	readonly userId?: string;
	readonly purpose: SecurityTokenPurpose;
	readonly tokenDigest: string;
	readonly createdAt: Date;
	readonly expiresAt: Date;
	readonly consumedAt?: Date;
	readonly metadata: Readonly<Record<string, CoreJsonValue>>;
}

export interface CorePasskey {
	readonly id: string;
	readonly userId: string;
	readonly credentialId: Uint8Array;
	readonly publicKey: Uint8Array;
	readonly signCount: number;
	readonly transports: readonly string[];
	readonly deviceType: "single-device" | "multi-device";
	readonly backedUp: boolean;
	readonly displayName: string;
	readonly createdAt: Date;
	readonly lastUsedAt?: Date;
}

export interface CoreWebAuthnChallenge {
	readonly id: string;
	readonly userId?: string;
	readonly sessionId?: string;
	readonly purpose: "authentication" | "registration";
	readonly challengeDigest: string;
	readonly createdAt: Date;
	readonly expiresAt: Date;
	readonly consumedAt?: Date;
	readonly metadata: Readonly<Record<string, CoreJsonValue>>;
}

export interface CoreSessionDeviceProof {
	readonly id: string;
	readonly sessionId: string;
	readonly deviceIdentifierDigest: string;
	readonly proofDigest: string;
	readonly createdAt: Date;
	readonly expiresAt: Date;
	readonly lastSeenAt: Date;
	readonly revokedAt?: Date;
}

export interface CoreUserBan {
	readonly id: string;
	readonly userId: string;
	readonly reason: string;
	readonly startsAt: Date;
	readonly expiresAt?: Date;
	readonly createdBy?: string;
	readonly createdAt: Date;
	readonly revokedAt?: Date;
	readonly revokedBy?: string;
	readonly metadata: Readonly<Record<string, CoreJsonValue>>;
}

export interface CoreIpBan {
	readonly id: string;
	readonly addressDigest: string;
	readonly reason: string;
	readonly startsAt: Date;
	readonly expiresAt?: Date;
	readonly createdBy?: string;
	readonly createdAt: Date;
	readonly revokedAt?: Date;
	readonly revokedBy?: string;
	readonly metadata: Readonly<Record<string, CoreJsonValue>>;
}

export interface CoreSecurityAttempt {
	readonly id: string;
	readonly kind: string;
	readonly subjectDigest?: string;
	readonly addressDigest?: string;
	readonly outcome: "allowed" | "succeeded" | "failed" | "blocked";
	readonly occurredAt: Date;
	readonly metadata: Readonly<Record<string, CoreJsonValue>>;
}

export interface CoreInstallationState {
	readonly instanceId: string;
	readonly status: "pending" | "in-progress" | "completed" | "failed";
	readonly bootstrapVersion: number;
	readonly lockOwner?: string;
	readonly lockedAt?: Date;
	readonly completedAt?: Date;
	readonly failureCode?: string;
	readonly updatedAt: Date;
}

export interface CoreStore {
	transaction<Result>(operation: () => Promise<Result>): Promise<Result>;
	getInstanceId(): Promise<string | undefined>;
	setInstanceId(instanceId: string): Promise<void>;
	countUsers(): Promise<number>;
	getInstallationToken(instanceId: string): Promise<CoreInstallationToken | undefined>;
	setInstallationToken(token: CoreInstallationToken): Promise<void>;
	consumeInstallationToken(
		instanceId: string,
		tokenDigest: string,
		consumedAt: Date,
	): Promise<boolean>;
	upsertEmailAddress(email: CoreEmailAddress): Promise<void>;
	findEmailAddress(normalizedEmail: string): Promise<CoreEmailAddress | undefined>;
	markEmailVerified(emailId: string, verifiedAt: Date): Promise<void>;
	createSecurityToken(token: CoreSecurityToken): Promise<void>;
	consumeSecurityToken(
		purpose: SecurityTokenPurpose,
		tokenDigest: string,
		consumedAt: Date,
	): Promise<CoreSecurityToken | undefined>;
	createPasskey(passkey: CorePasskey): Promise<void>;
	listPasskeys(userId: string): Promise<readonly CorePasskey[]>;
	updatePasskeyUsage(passkeyId: string, signCount: number, lastUsedAt: Date): Promise<void>;
	deletePasskey(passkeyId: string, userId: string): Promise<void>;
	createWebAuthnChallenge(challenge: CoreWebAuthnChallenge): Promise<void>;
	consumeWebAuthnChallenge(
		purpose: CoreWebAuthnChallenge["purpose"],
		challengeDigest: string,
		consumedAt: Date,
	): Promise<CoreWebAuthnChallenge | undefined>;
	upsertSessionDeviceProof(proof: CoreSessionDeviceProof): Promise<void>;
	findSessionDeviceProof(proofDigest: string): Promise<CoreSessionDeviceProof | undefined>;
	revokeSessionDeviceProof(proofId: string, revokedAt: Date): Promise<void>;
	createUserBan(ban: CoreUserBan): Promise<void>;
	createIpBan(ban: CoreIpBan): Promise<void>;
	revokeUserBan(banId: string, revokedBy: string | undefined, revokedAt: Date): Promise<void>;
	revokeIpBan(banId: string, revokedBy: string | undefined, revokedAt: Date): Promise<void>;
	isUserBanned(userId: string, at: Date): Promise<boolean>;
	isAddressBanned(addressDigest: string, at: Date): Promise<boolean>;
	appendSecurityAttempt(attempt: CoreSecurityAttempt): Promise<void>;
	purgeSecurityData(at: Date, attemptsBefore: Date): Promise<void>;
	setUserPreference(userId: string, key: string, value: CoreJsonValue): Promise<void>;
	getUserPreference(userId: string, key: string): Promise<CoreJsonValue | undefined>;
	setInstanceSetting(key: string, value: CoreJsonValue): Promise<void>;
	getInstanceSetting(key: string): Promise<CoreJsonValue | undefined>;
	setInstallationState(state: CoreInstallationState): Promise<void>;
	getInstallationState(instanceId: string): Promise<CoreInstallationState | undefined>;
	createUser(user: CoreUser): Promise<void>;
	findUserById(userId: string): Promise<CoreUser | undefined>;
	findUserByLogin(login: string): Promise<CoreUser | undefined>;
	setUserActive(userId: string, active: boolean): Promise<void>;
	grantCapability(userId: string, capability: string): Promise<void>;
	declareCapabilityImplication(capability: string, impliedCapability: string): Promise<void>;
	createRole(role: CoreRole): Promise<void>;
	grantRoleCapability(roleId: string, capability: string): Promise<void>;
	declareRoleIncompatibility(firstRoleId: string, secondRoleId: string): Promise<void>;
	assignRole(userId: string, roleId: string): Promise<void>;
	hasCapability(userId: string, capability: string): Promise<boolean>;
	createSession(session: CoreSession): Promise<void>;
	findSessionByTokenDigest(tokenDigest: string): Promise<CoreSession | undefined>;
	revokeSession(sessionId: string, revokedAt: Date): Promise<void>;
	markSecondFactorVerified(sessionId: string, verifiedAt: Date): Promise<void>;
	setTwoFactor(userId: string, registration: TwoFactorRegistration): Promise<void>;
	getTwoFactor(userId: string): Promise<TwoFactorRegistration | undefined>;
	consumeRecoveryCode(userId: string, digest: string): Promise<boolean>;
	appendAudit(record: AuditRecord): Promise<void>;
	appendEvent(event: Omit<CoreEvent, "sequence">): Promise<CoreEvent>;
	latestEventSequence(): Promise<bigint>;
	registerEventConsumer(consumer: CoreEventConsumer): Promise<CoreEventConsumer>;
	getEventConsumer(identifier: string): Promise<CoreEventConsumer | undefined>;
	readEventsForConsumer(identifier: string, limit: number): Promise<readonly CoreEvent[]>;
	advanceEventConsumer(identifier: string, sequence: bigint, updatedAt: Date): Promise<void>;
	setEventConsumerActive(identifier: string, active: boolean, updatedAt: Date): Promise<void>;
	purgeExpiredEvents(at: Date): Promise<number>;
}

interface Snapshot {
	instanceId: string | undefined;
	installationTokens: Map<string, CoreInstallationToken>;
	emailAddresses: Map<string, CoreEmailAddress>;
	securityTokens: Map<string, CoreSecurityToken>;
	passkeys: Map<string, CorePasskey>;
	webauthnChallenges: Map<string, CoreWebAuthnChallenge>;
	deviceProofs: Map<string, CoreSessionDeviceProof>;
	userBans: Map<string, CoreUserBan>;
	ipBans: Map<string, CoreIpBan>;
	securityAttempts: CoreSecurityAttempt[];
	userPreferences: Map<string, CoreJsonValue>;
	instanceSettings: Map<string, CoreJsonValue>;
	installationStates: Map<string, CoreInstallationState>;
	users: Map<string, CoreUser>;
	capabilities: Map<string, Set<string>>;
	capabilityImplications: Map<string, Set<string>>;
	roles: Map<string, CoreRole>;
	roleCapabilities: Map<string, Set<string>>;
	roleIncompatibilities: Map<string, Set<string>>;
	userRoles: Map<string, Set<string>>;
	sessions: Map<string, CoreSession>;
	twoFactor: Map<string, TwoFactorRegistration>;
	audit: AuditRecord[];
	events: CoreEvent[];
	eventConsumers: Map<string, CoreEventConsumer>;
	nextEventSequence: bigint;
}

export class InMemoryCoreStore implements CoreStore {
	private state: Snapshot = {
		instanceId: undefined,
		installationTokens: new Map(),
		emailAddresses: new Map(),
		securityTokens: new Map(),
		passkeys: new Map(),
		webauthnChallenges: new Map(),
		deviceProofs: new Map(),
		userBans: new Map(),
		ipBans: new Map(),
		securityAttempts: [],
		userPreferences: new Map(),
		instanceSettings: new Map(),
		installationStates: new Map(),
		users: new Map(),
		capabilities: new Map(),
		capabilityImplications: new Map(),
		roles: new Map(),
		roleCapabilities: new Map(),
		roleIncompatibilities: new Map(),
		userRoles: new Map(),
		sessions: new Map(),
		twoFactor: new Map(),
		audit: [],
		events: [],
		eventConsumers: new Map(),
		nextEventSequence: 1n,
	};

	async transaction<Result>(operation: () => Promise<Result>): Promise<Result> {
		const previous = this.clone();
		try {
			return await operation();
		} catch (error) {
			this.state = previous;
			throw error;
		}
	}

	async getInstanceId(): Promise<string | undefined> {
		return this.state.instanceId;
	}

	async setInstanceId(instanceId: string): Promise<void> {
		this.state.instanceId = instanceId;
	}

	async countUsers(): Promise<number> {
		return this.state.users.size;
	}

	async getInstallationToken(instanceId: string): Promise<CoreInstallationToken | undefined> {
		return this.state.installationTokens.get(instanceId);
	}

	async setInstallationToken(token: CoreInstallationToken): Promise<void> {
		this.state.installationTokens.set(token.instanceId, token);
	}

	async consumeInstallationToken(
		instanceId: string,
		tokenDigest: string,
		consumedAt: Date,
	): Promise<boolean> {
		const token = this.state.installationTokens.get(instanceId);
		if (
			!token ||
			token.consumedAt ||
			token.expiresAt.getTime() <= consumedAt.getTime() ||
			token.tokenDigest !== tokenDigest
		) {
			return false;
		}
		this.state.installationTokens.set(instanceId, { ...token, consumedAt });
		return true;
	}

	async upsertEmailAddress(email: CoreEmailAddress): Promise<void> {
		for (const candidate of this.state.emailAddresses.values()) {
			if (candidate.normalizedEmail === email.normalizedEmail && candidate.id !== email.id) {
				throw new CoreError("configuration.invalid", "Cette adresse électronique existe déjà.");
			}
		}
		if (email.primary) {
			for (const [id, candidate] of this.state.emailAddresses) {
				if (candidate.userId === email.userId && id !== email.id && candidate.primary) {
					this.state.emailAddresses.set(id, { ...candidate, primary: false });
				}
			}
		}
		this.state.emailAddresses.set(email.id, email);
	}

	async findEmailAddress(normalizedEmail: string): Promise<CoreEmailAddress | undefined> {
		return [...this.state.emailAddresses.values()].find(
			(email) => email.normalizedEmail === normalizedEmail,
		);
	}

	async markEmailVerified(emailId: string, verifiedAt: Date): Promise<void> {
		const email = this.state.emailAddresses.get(emailId);
		if (email)
			this.state.emailAddresses.set(emailId, { ...email, verifiedAt, updatedAt: verifiedAt });
	}

	async createSecurityToken(token: CoreSecurityToken): Promise<void> {
		if (
			[...this.state.securityTokens.values()].some(
				(candidate) => candidate.tokenDigest === token.tokenDigest,
			)
		) {
			throw new CoreError("configuration.invalid", "Ce jeton de sécurité existe déjà.");
		}
		this.state.securityTokens.set(token.id, token);
	}

	async consumeSecurityToken(
		purpose: SecurityTokenPurpose,
		tokenDigest: string,
		consumedAt: Date,
	): Promise<CoreSecurityToken | undefined> {
		const token = [...this.state.securityTokens.values()].find(
			(candidate) => candidate.purpose === purpose && candidate.tokenDigest === tokenDigest,
		);
		if (!token || token.consumedAt || token.expiresAt.getTime() <= consumedAt.getTime()) {
			return undefined;
		}
		const consumed = { ...token, consumedAt };
		this.state.securityTokens.set(token.id, consumed);
		return consumed;
	}

	async createPasskey(passkey: CorePasskey): Promise<void> {
		const credential = bytesKey(passkey.credentialId);
		if (
			[...this.state.passkeys.values()].some(
				(candidate) => bytesKey(candidate.credentialId) === credential,
			)
		) {
			throw new CoreError("configuration.invalid", "Cette passkey existe déjà.");
		}
		this.state.passkeys.set(passkey.id, clonePasskey(passkey));
	}

	async listPasskeys(userId: string): Promise<readonly CorePasskey[]> {
		return [...this.state.passkeys.values()]
			.filter((passkey) => passkey.userId === userId)
			.map(clonePasskey);
	}

	async updatePasskeyUsage(passkeyId: string, signCount: number, lastUsedAt: Date): Promise<void> {
		const passkey = this.state.passkeys.get(passkeyId);
		if (!passkey || signCount <= passkey.signCount) {
			throw new CoreError("authentication.invalid_credentials", "La passkey est invalide.");
		}
		this.state.passkeys.set(passkeyId, { ...passkey, signCount, lastUsedAt });
	}

	async deletePasskey(passkeyId: string, userId: string): Promise<void> {
		if (this.state.passkeys.get(passkeyId)?.userId === userId)
			this.state.passkeys.delete(passkeyId);
	}

	async createWebAuthnChallenge(challenge: CoreWebAuthnChallenge): Promise<void> {
		if (
			[...this.state.webauthnChallenges.values()].some(
				(candidate) => candidate.challengeDigest === challenge.challengeDigest,
			)
		) {
			throw new CoreError("configuration.invalid", "Ce défi WebAuthn existe déjà.");
		}
		this.state.webauthnChallenges.set(challenge.id, challenge);
	}

	async consumeWebAuthnChallenge(
		purpose: CoreWebAuthnChallenge["purpose"],
		challengeDigest: string,
		consumedAt: Date,
	): Promise<CoreWebAuthnChallenge | undefined> {
		const challenge = [...this.state.webauthnChallenges.values()].find(
			(candidate) => candidate.purpose === purpose && candidate.challengeDigest === challengeDigest,
		);
		if (
			!challenge ||
			challenge.consumedAt ||
			challenge.expiresAt.getTime() <= consumedAt.getTime()
		) {
			return undefined;
		}
		const consumed = { ...challenge, consumedAt };
		this.state.webauthnChallenges.set(challenge.id, consumed);
		return consumed;
	}

	async upsertSessionDeviceProof(proof: CoreSessionDeviceProof): Promise<void> {
		const existing = [...this.state.deviceProofs.values()].find(
			(candidate) =>
				candidate.sessionId === proof.sessionId &&
				candidate.deviceIdentifierDigest === proof.deviceIdentifierDigest,
		);
		if (existing && existing.id !== proof.id) this.state.deviceProofs.delete(existing.id);
		this.state.deviceProofs.set(proof.id, proof);
	}

	async findSessionDeviceProof(proofDigest: string): Promise<CoreSessionDeviceProof | undefined> {
		return [...this.state.deviceProofs.values()].find((proof) => proof.proofDigest === proofDigest);
	}

	async revokeSessionDeviceProof(proofId: string, revokedAt: Date): Promise<void> {
		const proof = this.state.deviceProofs.get(proofId);
		if (proof) this.state.deviceProofs.set(proofId, { ...proof, revokedAt });
	}

	async createUserBan(ban: CoreUserBan): Promise<void> {
		this.state.userBans.set(ban.id, ban);
	}

	async createIpBan(ban: CoreIpBan): Promise<void> {
		this.state.ipBans.set(ban.id, ban);
	}

	async revokeUserBan(
		banId: string,
		revokedBy: string | undefined,
		revokedAt: Date,
	): Promise<void> {
		const ban = this.state.userBans.get(banId);
		if (ban)
			this.state.userBans.set(banId, { ...ban, revokedAt, ...(revokedBy ? { revokedBy } : {}) });
	}

	async revokeIpBan(banId: string, revokedBy: string | undefined, revokedAt: Date): Promise<void> {
		const ban = this.state.ipBans.get(banId);
		if (ban)
			this.state.ipBans.set(banId, { ...ban, revokedAt, ...(revokedBy ? { revokedBy } : {}) });
	}

	async isUserBanned(userId: string, at: Date): Promise<boolean> {
		return [...this.state.userBans.values()].some(
			(ban) =>
				ban.userId === userId &&
				!ban.revokedAt &&
				ban.startsAt.getTime() <= at.getTime() &&
				(!ban.expiresAt || ban.expiresAt.getTime() > at.getTime()),
		);
	}

	async isAddressBanned(addressDigest: string, at: Date): Promise<boolean> {
		return [...this.state.ipBans.values()].some(
			(ban) =>
				ban.addressDigest === addressDigest &&
				!ban.revokedAt &&
				ban.startsAt.getTime() <= at.getTime() &&
				(!ban.expiresAt || ban.expiresAt.getTime() > at.getTime()),
		);
	}

	async appendSecurityAttempt(attempt: CoreSecurityAttempt): Promise<void> {
		this.state.securityAttempts.push(attempt);
	}

	async purgeSecurityData(at: Date, attemptsBefore: Date): Promise<void> {
		for (const [id, token] of this.state.securityTokens) {
			if (token.consumedAt || token.expiresAt.getTime() <= at.getTime()) {
				this.state.securityTokens.delete(id);
			}
		}
		for (const [id, challenge] of this.state.webauthnChallenges) {
			if (challenge.consumedAt || challenge.expiresAt.getTime() <= at.getTime()) {
				this.state.webauthnChallenges.delete(id);
			}
		}
		for (const [id, proof] of this.state.deviceProofs) {
			if (proof.revokedAt || proof.expiresAt.getTime() <= at.getTime()) {
				this.state.deviceProofs.delete(id);
			}
		}
		this.state.securityAttempts = this.state.securityAttempts.filter(
			(attempt) => attempt.occurredAt.getTime() >= attemptsBefore.getTime(),
		);
	}

	async setUserPreference(userId: string, key: string, value: CoreJsonValue): Promise<void> {
		this.state.userPreferences.set(mapKey(userId, key), value);
	}

	async getUserPreference(userId: string, key: string): Promise<CoreJsonValue | undefined> {
		return this.state.userPreferences.get(mapKey(userId, key));
	}

	async setInstanceSetting(key: string, value: CoreJsonValue): Promise<void> {
		this.state.instanceSettings.set(key, value);
	}

	async getInstanceSetting(key: string): Promise<CoreJsonValue | undefined> {
		return this.state.instanceSettings.get(key);
	}

	async setInstallationState(state: CoreInstallationState): Promise<void> {
		this.state.installationStates.set(state.instanceId, state);
	}

	async getInstallationState(instanceId: string): Promise<CoreInstallationState | undefined> {
		return this.state.installationStates.get(instanceId);
	}

	async createUser(user: CoreUser): Promise<void> {
		if ([...this.state.users.values()].some((candidate) => candidate.login === user.login)) {
			throw new CoreError("configuration.invalid", "Cet identifiant existe déjà.");
		}
		this.state.users.set(user.id, user);
	}

	async findUserById(userId: string): Promise<CoreUser | undefined> {
		return this.state.users.get(userId);
	}

	async findUserByLogin(login: string): Promise<CoreUser | undefined> {
		return [...this.state.users.values()].find((user) => user.login === login);
	}

	async setUserActive(userId: string, active: boolean): Promise<void> {
		const user = this.state.users.get(userId);
		if (!user) return;
		if (user.founder && !active) {
			throw new CoreError("authorization.founder_protected", "Le compte fondateur est protégé.");
		}
		this.state.users.set(userId, { ...user, active });
	}

	async grantCapability(userId: string, capability: string): Promise<void> {
		const grants = this.state.capabilities.get(userId) ?? new Set<string>();
		grants.add(capability);
		this.state.capabilities.set(userId, grants);
	}

	async declareCapabilityImplication(capability: string, impliedCapability: string): Promise<void> {
		if (capability === impliedCapability || this.capabilityImplies(impliedCapability, capability)) {
			throw new CoreError(
				"configuration.invalid",
				"Une implication de capacité ne peut pas créer de cycle.",
			);
		}
		const implications = this.state.capabilityImplications.get(capability) ?? new Set<string>();
		implications.add(impliedCapability);
		this.state.capabilityImplications.set(capability, implications);
	}

	async createRole(role: CoreRole): Promise<void> {
		if (
			[...this.state.roles.values()].some((candidate) => candidate.identifier === role.identifier)
		) {
			throw new CoreError("configuration.invalid", "Ce rôle existe déjà.");
		}
		this.state.roles.set(role.id, role);
	}

	async grantRoleCapability(roleId: string, capability: string): Promise<void> {
		if (!this.state.roles.has(roleId))
			throw new CoreError("configuration.invalid", "Rôle inconnu.");
		const capabilities = this.state.roleCapabilities.get(roleId) ?? new Set<string>();
		capabilities.add(capability);
		this.state.roleCapabilities.set(roleId, capabilities);
	}

	async declareRoleIncompatibility(firstRoleId: string, secondRoleId: string): Promise<void> {
		if (
			firstRoleId === secondRoleId ||
			!this.state.roles.has(firstRoleId) ||
			!this.state.roles.has(secondRoleId)
		) {
			throw new CoreError("configuration.invalid", "Les rôles incompatibles sont invalides.");
		}
		if (
			[...this.state.userRoles.values()].some(
				(roles) => roles.has(firstRoleId) && roles.has(secondRoleId),
			)
		) {
			throw new CoreError(
				"configuration.invalid",
				"Ces rôles sont déjà affectés ensemble à un utilisateur.",
			);
		}
		for (const [roleId, incompatibleRoleId] of [
			[firstRoleId, secondRoleId],
			[secondRoleId, firstRoleId],
		] as const) {
			const incompatible = this.state.roleIncompatibilities.get(roleId) ?? new Set<string>();
			incompatible.add(incompatibleRoleId);
			this.state.roleIncompatibilities.set(roleId, incompatible);
		}
	}

	async assignRole(userId: string, roleId: string): Promise<void> {
		if (!this.state.users.has(userId) || !this.state.roles.has(roleId)) {
			throw new CoreError("configuration.invalid", "Utilisateur ou rôle inconnu.");
		}
		const roles = this.state.userRoles.get(userId) ?? new Set<string>();
		if (
			[...roles].some((assignedRoleId) =>
				this.state.roleIncompatibilities.get(roleId)?.has(assignedRoleId),
			)
		) {
			throw new CoreError(
				"authorization.denied",
				"Ce rôle est incompatible avec un rôle existant.",
			);
		}
		roles.add(roleId);
		this.state.userRoles.set(userId, roles);
	}

	async hasCapability(userId: string, capability: string): Promise<boolean> {
		const granted = new Set(this.state.capabilities.get(userId) ?? []);
		for (const roleId of this.state.userRoles.get(userId) ?? []) {
			for (const grantedCapability of this.state.roleCapabilities.get(roleId) ?? []) {
				granted.add(grantedCapability);
			}
		}
		return [...granted].some(
			(grantedCapability) =>
				grantedCapability === capability || this.capabilityImplies(grantedCapability, capability),
		);
	}

	async createSession(session: CoreSession): Promise<void> {
		this.state.sessions.set(session.id, session);
	}

	async findSessionByTokenDigest(tokenDigest: string): Promise<CoreSession | undefined> {
		return [...this.state.sessions.values()].find((session) => session.tokenDigest === tokenDigest);
	}

	async revokeSession(sessionId: string, revokedAt: Date): Promise<void> {
		const session = this.state.sessions.get(sessionId);
		if (session) this.state.sessions.set(sessionId, { ...session, revokedAt });
	}

	async markSecondFactorVerified(sessionId: string, verifiedAt: Date): Promise<void> {
		const session = this.state.sessions.get(sessionId);
		if (session)
			this.state.sessions.set(sessionId, { ...session, secondFactorVerifiedAt: verifiedAt });
	}

	async setTwoFactor(userId: string, registration: TwoFactorRegistration): Promise<void> {
		this.state.twoFactor.set(userId, registration);
	}

	async getTwoFactor(userId: string): Promise<TwoFactorRegistration | undefined> {
		return this.state.twoFactor.get(userId);
	}

	async consumeRecoveryCode(userId: string, digest: string): Promise<boolean> {
		const registration = this.state.twoFactor.get(userId);
		if (!registration?.recoveryCodeDigests.has(digest)) return false;
		const remaining = new Set(registration.recoveryCodeDigests);
		remaining.delete(digest);
		this.state.twoFactor.set(userId, { ...registration, recoveryCodeDigests: remaining });
		return true;
	}

	async appendAudit(record: AuditRecord): Promise<void> {
		this.state.audit.push(record);
	}

	async appendEvent(event: Omit<CoreEvent, "sequence">): Promise<CoreEvent> {
		if (event.idempotencyKey) {
			const existing = this.state.events.find(
				(candidate) =>
					candidate.ownerIdentifier === event.ownerIdentifier &&
					candidate.idempotencyKey === event.idempotencyKey,
			);
			if (existing) return existing;
		}
		const stored = { ...event, sequence: this.state.nextEventSequence };
		this.state.nextEventSequence += 1n;
		this.state.events.push(stored);
		return stored;
	}

	async latestEventSequence(): Promise<bigint> {
		return this.state.nextEventSequence - 1n;
	}

	async registerEventConsumer(consumer: CoreEventConsumer): Promise<CoreEventConsumer> {
		const existing = this.state.eventConsumers.get(consumer.identifier);
		if (existing && existing.ownerIdentifier !== consumer.ownerIdentifier) {
			throw new CoreError("authorization.denied", "Le consommateur appartient à un autre module.");
		}
		const stored = existing
			? {
					...existing,
					topics: [...consumer.topics],
					active: consumer.active,
					updatedAt: consumer.updatedAt,
				}
			: { ...consumer, topics: [...consumer.topics] };
		this.state.eventConsumers.set(consumer.identifier, stored);
		return stored;
	}

	async getEventConsumer(identifier: string): Promise<CoreEventConsumer | undefined> {
		const consumer = this.state.eventConsumers.get(identifier);
		return consumer ? { ...consumer, topics: [...consumer.topics] } : undefined;
	}

	async readEventsForConsumer(identifier: string, limit: number): Promise<readonly CoreEvent[]> {
		const consumer = this.state.eventConsumers.get(identifier);
		if (!consumer?.active) return [];
		return this.state.events
			.filter(
				(event) => event.sequence > consumer.lastSequence && consumer.topics.includes(event.topic),
			)
			.sort((first, second) => (first.sequence < second.sequence ? -1 : 1))
			.slice(0, limit);
	}

	async advanceEventConsumer(identifier: string, sequence: bigint, updatedAt: Date): Promise<void> {
		const consumer = this.state.eventConsumers.get(identifier);
		if (!consumer?.active || sequence < consumer.lastSequence) {
			throw new CoreError("lifecycle.invalid_state", "Le curseur du consommateur est invalide.");
		}
		if (
			sequence !== consumer.lastSequence &&
			!this.state.events.some(
				(event) => event.sequence === sequence && consumer.topics.includes(event.topic),
			)
		) {
			throw new CoreError("lifecycle.invalid_state", "L’événement acquitté est invalide.");
		}
		this.state.eventConsumers.set(identifier, { ...consumer, lastSequence: sequence, updatedAt });
	}

	async setEventConsumerActive(
		identifier: string,
		active: boolean,
		updatedAt: Date,
	): Promise<void> {
		const consumer = this.state.eventConsumers.get(identifier);
		if (!consumer) {
			throw new CoreError("lifecycle.invalid_state", "Le consommateur d’événements est inconnu.");
		}
		this.state.eventConsumers.set(identifier, { ...consumer, active, updatedAt });
	}

	async purgeExpiredEvents(at: Date): Promise<number> {
		const before = this.state.events.length;
		this.state.events = this.state.events.filter((event) => {
			if (event.retentionUntil > at) return true;
			return [...this.state.eventConsumers.values()].some(
				(consumer) =>
					consumer.active &&
					consumer.topics.includes(event.topic) &&
					consumer.lastSequence < event.sequence,
			);
		});
		return before - this.state.events.length;
	}

	get auditRecords(): readonly AuditRecord[] {
		return this.state.audit;
	}

	get securityAttemptRecords(): readonly CoreSecurityAttempt[] {
		return this.state.securityAttempts;
	}

	get eventRecords(): readonly CoreEvent[] {
		return this.state.events;
	}

	private clone(): Snapshot {
		return {
			instanceId: this.state.instanceId,
			installationTokens: new Map(this.state.installationTokens),
			emailAddresses: new Map(this.state.emailAddresses),
			securityTokens: new Map(this.state.securityTokens),
			passkeys: new Map([...this.state.passkeys].map(([key, value]) => [key, clonePasskey(value)])),
			webauthnChallenges: new Map(this.state.webauthnChallenges),
			deviceProofs: new Map(this.state.deviceProofs),
			userBans: new Map(this.state.userBans),
			ipBans: new Map(this.state.ipBans),
			securityAttempts: [...this.state.securityAttempts],
			userPreferences: new Map(this.state.userPreferences),
			instanceSettings: new Map(this.state.instanceSettings),
			installationStates: new Map(this.state.installationStates),
			users: new Map(this.state.users),
			capabilities: new Map(
				[...this.state.capabilities].map(([key, values]) => [key, new Set(values)]),
			),
			capabilityImplications: new Map(
				[...this.state.capabilityImplications].map(([key, values]) => [key, new Set(values)]),
			),
			roles: new Map(this.state.roles),
			roleCapabilities: new Map(
				[...this.state.roleCapabilities].map(([key, values]) => [key, new Set(values)]),
			),
			roleIncompatibilities: new Map(
				[...this.state.roleIncompatibilities].map(([key, values]) => [key, new Set(values)]),
			),
			userRoles: new Map([...this.state.userRoles].map(([key, values]) => [key, new Set(values)])),
			sessions: new Map(this.state.sessions),
			twoFactor: new Map(
				[...this.state.twoFactor].map(([key, value]) => [
					key,
					{ ...value, recoveryCodeDigests: new Set(value.recoveryCodeDigests) },
				]),
			),
			audit: [...this.state.audit],
			events: [...this.state.events],
			eventConsumers: new Map(
				[...this.state.eventConsumers].map(([key, value]) => [
					key,
					{ ...value, topics: [...value.topics] },
				]),
			),
			nextEventSequence: this.state.nextEventSequence,
		};
	}

	private capabilityImplies(capability: string, expected: string): boolean {
		const pending = [capability];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const current = pending.pop()!;
			if (visited.has(current)) continue;
			visited.add(current);
			for (const implied of this.state.capabilityImplications.get(current) ?? []) {
				if (implied === expected) return true;
				pending.push(implied);
			}
		}
		return false;
	}
}

function mapKey(first: string, second: string): string {
	return `${first}\0${second}`;
}

function bytesKey(value: Uint8Array): string {
	return Buffer.from(value).toString("base64url");
}

function clonePasskey(passkey: CorePasskey): CorePasskey {
	return {
		...passkey,
		credentialId: passkey.credentialId.slice(),
		publicKey: passkey.publicKey.slice(),
		transports: [...passkey.transports],
	};
}
