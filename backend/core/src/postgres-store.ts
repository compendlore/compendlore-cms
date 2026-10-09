import { AsyncLocalStorage } from "node:async_hooks";
import {
	sql,
	type CoreDatabase,
	type DatabaseResult,
	type TransactionContext,
} from "./database.js";
import type {
	AuditRecord,
	CoreSession,
	CoreStore,
	CoreRole,
	CoreUser,
	TwoFactorRegistration,
} from "./store.js";
import type { SecretCipher } from "./services.js";
import { CoreError } from "./errors.js";

interface InstanceRow {
	[key: string]: unknown;
	id: string;
}

interface CountRow {
	[key: string]: unknown;
	count: string;
}

interface UserRow {
	[key: string]: unknown;
	id: string;
	login: string;
	display_name: string;
	password_digest: string;
	is_founder: boolean;
	is_active: boolean;
	created_at: Date;
}

interface SessionRow {
	[key: string]: unknown;
	id: string;
	user_id: string;
	token_digest: string;
	expires_at: Date;
	created_at: Date;
	revoked_at: Date | null;
	second_factor_verified_at: Date | null;
}

interface TwoFactorRow {
	[key: string]: unknown;
	secret_ciphertext: string;
	recovery_codes: string[];
}

export class PostgresCoreStore implements CoreStore {
	private readonly transactionStorage = new AsyncLocalStorage<TransactionContext>();

	constructor(
		private readonly database: CoreDatabase,
		private readonly secretCipher: SecretCipher,
	) {}

	async transaction<Result>(operation: () => Promise<Result>): Promise<Result> {
		if (this.transactionStorage.getStore()) return operation();
		return this.database.transaction(async (transaction) => {
			return this.transactionStorage.run(transaction, operation);
		});
	}

	async getInstanceId(): Promise<string | undefined> {
		const result = await this.query<InstanceRow>(/* pgsql */ sql`
			SELECT
				id
			FROM
				core.instances
			LIMIT 1
		`);
		return result.rows[0]?.id;
	}

	async setInstanceId(instanceId: string): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.instances (id)
			VALUES (${instanceId})
			ON CONFLICT DO NOTHING
		`);
	}

	async countUsers(): Promise<number> {
		const result = await this.query<CountRow>(/* pgsql */ sql`
			SELECT
				count(*)::text AS count
			FROM
				core.users
		`);
		return Number(result.rows[0]?.count ?? 0);
	}

	async createUser(user: CoreUser): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.users (
				id,
				login,
				display_name,
				password_digest,
				is_founder,
				is_active,
				created_at
			)
			VALUES (
				${user.id},
				${user.login},
				${user.displayName},
				${user.passwordDigest},
				${user.founder},
				${user.active},
				${user.createdAt}
			)
		`);
	}

	async findUserById(userId: string): Promise<CoreUser | undefined> {
		const result = await this.query<UserRow>(/* pgsql */ sql`
			SELECT
				id,
				login,
				display_name,
				password_digest,
				is_founder,
				is_active,
				created_at
			FROM
				core.users
			WHERE
				id = ${userId}
		`);
		return result.rows[0] ? mapUser(result.rows[0]) : undefined;
	}

	async findUserByLogin(login: string): Promise<CoreUser | undefined> {
		const result = await this.query<UserRow>(/* pgsql */ sql`
			SELECT
				id,
				login,
				display_name,
				password_digest,
				is_founder,
				is_active,
				created_at
			FROM
				core.users
			WHERE
				login = ${login}
		`);
		return result.rows[0] ? mapUser(result.rows[0]) : undefined;
	}

	async setUserActive(userId: string, active: boolean): Promise<void> {
		const user = await this.findUserById(userId);
		if (user?.founder && !active) {
			throw new CoreError("authorization.founder_protected", "Le compte fondateur est protégé.");
		}
		await this.query(/* pgsql */ sql`
			UPDATE core.users
			SET
				is_active = ${active},
				updated_at = now()
			WHERE
				id = ${userId}
				AND (NOT is_founder OR ${active})
		`);
	}

	async grantCapability(userId: string, capability: string): Promise<void> {
		await this.transaction(async () => {
			await this.query(/* pgsql */ sql`
				INSERT INTO core.capabilities (identifier, is_core)
				VALUES (${capability}, ${capability.startsWith("core.")})
				ON CONFLICT (identifier) DO NOTHING
			`);
			await this.query(/* pgsql */ sql`
				INSERT INTO core.user_capabilities (user_id, capability_identifier)
				VALUES (${userId}, ${capability})
				ON CONFLICT DO NOTHING
			`);
		});
	}

	async createRole(role: CoreRole): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.roles (id, identifier, display_name, is_protected)
			VALUES (${role.id}, ${role.identifier}, ${role.displayName}, ${role.protected})
		`);
	}

	async grantRoleCapability(roleId: string, capability: string): Promise<void> {
		await this.transaction(async () => {
			await this.query(/* pgsql */ sql`
				INSERT INTO core.capabilities (identifier, is_core)
				VALUES (${capability}, ${capability.startsWith("core.")})
				ON CONFLICT (identifier) DO NOTHING
			`);
			await this.query(/* pgsql */ sql`
				INSERT INTO core.role_capabilities (role_id, capability_identifier)
				VALUES (${roleId}, ${capability})
				ON CONFLICT DO NOTHING
			`);
		});
	}

	async assignRole(userId: string, roleId: string): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.user_roles (user_id, role_id)
			VALUES (${userId}, ${roleId})
			ON CONFLICT DO NOTHING
		`);
	}

	async hasCapability(userId: string, capability: string): Promise<boolean> {
		const result = await this.query(/* pgsql */ sql`
			SELECT
				1
			FROM
				core.user_capabilities
			WHERE
				user_id = ${userId}
				AND capability_identifier = ${capability}
			UNION ALL
			SELECT
				1
			FROM
				core.user_roles ur
				INNER JOIN core.role_capabilities rc ON rc.role_id = ur.role_id
			WHERE
				ur.user_id = ${userId}
				AND rc.capability_identifier = ${capability}
			LIMIT 1
		`);
		return (result.rowCount ?? 0) > 0;
	}

	async createSession(session: CoreSession): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.sessions (
				id,
				user_id,
				token_digest,
				created_at,
				expires_at,
				revoked_at,
				second_factor_verified_at
			)
			VALUES (
				${session.id},
				${session.userId},
				${session.tokenDigest},
				${session.createdAt},
				${session.expiresAt},
				${session.revokedAt ?? null},
				${session.secondFactorVerifiedAt ?? null}
			)
		`);
	}

	async findSessionByTokenDigest(tokenDigest: string): Promise<CoreSession | undefined> {
		const result = await this.query<SessionRow>(/* pgsql */ sql`
			SELECT
				id,
				user_id,
				token_digest,
				created_at,
				expires_at,
				revoked_at,
				second_factor_verified_at
			FROM
				core.sessions
			WHERE
				token_digest = ${tokenDigest}
		`);
		return result.rows[0] ? mapSession(result.rows[0]) : undefined;
	}

	async revokeSession(sessionId: string, revokedAt: Date): Promise<void> {
		await this.query(/* pgsql */ sql`
			UPDATE core.sessions
			SET
				revoked_at = ${revokedAt}
			WHERE
				id = ${sessionId}
		`);
	}

	async markSecondFactorVerified(sessionId: string, verifiedAt: Date): Promise<void> {
		await this.query(/* pgsql */ sql`
			UPDATE core.sessions
			SET
				second_factor_verified_at = ${verifiedAt}
			WHERE
				id = ${sessionId}
		`);
	}

	async setTwoFactor(userId: string, registration: TwoFactorRegistration): Promise<void> {
		await this.transaction(async () => {
			await this.query(/* pgsql */ sql`
				INSERT INTO core.two_factor (user_id, secret_ciphertext)
				VALUES (${userId}, ${this.secretCipher.seal(registration.secret)})
				ON CONFLICT (user_id) DO UPDATE
				SET
					secret_ciphertext = EXCLUDED.secret_ciphertext,
					updated_at = now()
			`);
			await this.query(/* pgsql */ sql`
				DELETE FROM core.two_factor_recovery_codes
				WHERE
					user_id = ${userId}
			`);
			for (const codeDigest of registration.recoveryCodeDigests) {
				await this.query(/* pgsql */ sql`
					INSERT INTO core.two_factor_recovery_codes (user_id, code_digest)
					VALUES (${userId}, ${codeDigest})
				`);
			}
		});
	}

	async getTwoFactor(userId: string): Promise<TwoFactorRegistration | undefined> {
		const result = await this.query<TwoFactorRow>(/* pgsql */ sql`
			SELECT
				tf.secret_ciphertext,
				coalesce(array_agg(rc.code_digest) FILTER (WHERE rc.consumed_at IS NULL), '{}') AS recovery_codes
			FROM
				core.two_factor tf
				LEFT JOIN core.two_factor_recovery_codes rc ON rc.user_id = tf.user_id
			WHERE
				tf.user_id = ${userId}
			GROUP BY
				tf.secret_ciphertext
		`);
		const row = result.rows[0];
		return row
			? {
					secret: this.secretCipher.open(row.secret_ciphertext),
					recoveryCodeDigests: new Set(row.recovery_codes),
				}
			: undefined;
	}

	async consumeRecoveryCode(userId: string, codeDigest: string): Promise<boolean> {
		const result = await this.query(/* pgsql */ sql`
			UPDATE core.two_factor_recovery_codes
			SET
				consumed_at = now()
			WHERE
				user_id = ${userId}
				AND code_digest = ${codeDigest}
				AND consumed_at IS NULL
			RETURNING
				user_id
		`);
		return (result.rowCount ?? 0) === 1;
	}

	async appendAudit(record: AuditRecord): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.audit_log (
				id,
				occurred_at,
				action,
				outcome,
				actor_id,
				subject_id,
				correlation_id,
				metadata
			)
			VALUES (
				${record.id},
				${record.occurredAt},
				${record.action},
				${record.outcome},
				${record.actorId ?? null},
				${record.subjectId ?? null},
				${record.correlationId},
				${JSON.stringify(record.metadata)}
			)
		`);
	}

	private query<Row extends Record<string, unknown> = Record<string, unknown>>(
		statement: Parameters<CoreDatabase["query"]>[0],
	): Promise<DatabaseResult<Row>> {
		return (this.transactionStorage.getStore() ?? this.database).query<Row>(statement);
	}
}

function mapUser(row: UserRow): CoreUser {
	return {
		id: row.id,
		login: row.login,
		displayName: row.display_name,
		passwordDigest: row.password_digest,
		founder: row.is_founder,
		active: row.is_active,
		createdAt: row.created_at,
	};
}

function mapSession(row: SessionRow): CoreSession {
	return {
		id: row.id,
		userId: row.user_id,
		tokenDigest: row.token_digest,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
		...(row.second_factor_verified_at
			? { secondFactorVerifiedAt: row.second_factor_verified_at }
			: {}),
	};
}
