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

export interface CoreStore {
	transaction<Result>(operation: () => Promise<Result>): Promise<Result>;
	getInstanceId(): Promise<string | undefined>;
	setInstanceId(instanceId: string): Promise<void>;
	countUsers(): Promise<number>;
	createUser(user: CoreUser): Promise<void>;
	findUserById(userId: string): Promise<CoreUser | undefined>;
	findUserByLogin(login: string): Promise<CoreUser | undefined>;
	setUserActive(userId: string, active: boolean): Promise<void>;
	grantCapability(userId: string, capability: string): Promise<void>;
	createRole(role: CoreRole): Promise<void>;
	grantRoleCapability(roleId: string, capability: string): Promise<void>;
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
}

interface Snapshot {
	instanceId: string | undefined;
	users: Map<string, CoreUser>;
	capabilities: Map<string, Set<string>>;
	roles: Map<string, CoreRole>;
	roleCapabilities: Map<string, Set<string>>;
	userRoles: Map<string, Set<string>>;
	sessions: Map<string, CoreSession>;
	twoFactor: Map<string, TwoFactorRegistration>;
	audit: AuditRecord[];
}

export class InMemoryCoreStore implements CoreStore {
	private state: Snapshot = {
		instanceId: undefined,
		users: new Map(),
		capabilities: new Map(),
		roles: new Map(),
		roleCapabilities: new Map(),
		userRoles: new Map(),
		sessions: new Map(),
		twoFactor: new Map(),
		audit: [],
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

	async assignRole(userId: string, roleId: string): Promise<void> {
		if (!this.state.users.has(userId) || !this.state.roles.has(roleId)) {
			throw new CoreError("configuration.invalid", "Utilisateur ou rôle inconnu.");
		}
		const roles = this.state.userRoles.get(userId) ?? new Set<string>();
		roles.add(roleId);
		this.state.userRoles.set(userId, roles);
	}

	async hasCapability(userId: string, capability: string): Promise<boolean> {
		if (this.state.capabilities.get(userId)?.has(capability)) return true;
		return [...(this.state.userRoles.get(userId) ?? [])].some(
			(roleId) => this.state.roleCapabilities.get(roleId)?.has(capability) ?? false,
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

	get auditRecords(): readonly AuditRecord[] {
		return this.state.audit;
	}

	private clone(): Snapshot {
		return {
			instanceId: this.state.instanceId,
			users: new Map(this.state.users),
			capabilities: new Map(
				[...this.state.capabilities].map(([key, values]) => [key, new Set(values)]),
			),
			roles: new Map(this.state.roles),
			roleCapabilities: new Map(
				[...this.state.roleCapabilities].map(([key, values]) => [key, new Set(values)]),
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
		};
	}
}
