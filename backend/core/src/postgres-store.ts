import { AsyncLocalStorage } from "node:async_hooks";
import {
	sql,
	type CoreDatabase,
	type DatabaseResult,
	type TransactionContext,
} from "../database.js";
import type {
	AuditRecord,
	CoreEmailAddress,
	CoreEvent,
	CoreEventConsumer,
	CoreInstallationState,
	CoreInstallationToken,
	CoreInstanceIdentity,
	CoreIpBan,
	CoreJsonValue,
	CorePasskey,
	CoreSecurityAttempt,
	CoreSecurityToken,
	CoreSession,
	CoreSessionDeviceProof,
	CoreStore,
	CoreRole,
	CoreUserBan,
	CoreUser,
	CoreWebAuthnChallenge,
	SecurityTokenPurpose,
	TwoFactorRegistration,
} from "./store.js";
import type { SecretCipher } from "./services.js";
import { CoreError } from "./errors.js";

interface InstanceRow {
	[key: string]: unknown;
	id: string;
}

interface InstanceIdentityRow {
	[key: string]: unknown;
	instance_id: string;
	identity_identifier: string;
	algorithm: "Ed25519";
	format_version: 1;
	public_key: Uint8Array;
	public_key_fingerprint: string;
	key_reference: string;
	assurance_level: CoreInstanceIdentity["assurance"];
	created_at: Date;
	updated_at: Date;
}

interface CountRow {
	[key: string]: unknown;
	count: string;
}

interface InstallationTokenRow {
	[key: string]: unknown;
	instance_id: string;
	token_digest: string;
	created_at: Date;
	expires_at: Date;
	consumed_at: Date | null;
}

interface EmailAddressRow {
	[key: string]: unknown;
	id: string;
	user_id: string;
	email: string;
	normalized_email: string;
	is_primary: boolean;
	verified_at: Date | null;
	created_at: Date;
	updated_at: Date;
}

interface SecurityTokenRow {
	[key: string]: unknown;
	id: string;
	user_id: string | null;
	purpose: SecurityTokenPurpose;
	token_digest: string;
	created_at: Date;
	expires_at: Date;
	consumed_at: Date | null;
	metadata: Record<string, CoreJsonValue>;
}

interface PasskeyRow {
	[key: string]: unknown;
	id: string;
	user_id: string;
	credential_id: Uint8Array;
	public_key: Uint8Array;
	sign_count: string;
	transports: string[];
	device_type: CorePasskey["deviceType"];
	backed_up: boolean;
	display_name: string;
	created_at: Date;
	last_used_at: Date | null;
}

interface WebAuthnChallengeRow {
	[key: string]: unknown;
	id: string;
	user_id: string | null;
	session_id: string | null;
	purpose: CoreWebAuthnChallenge["purpose"];
	challenge_digest: string;
	created_at: Date;
	expires_at: Date;
	consumed_at: Date | null;
	metadata: Record<string, CoreJsonValue>;
}

interface SessionDeviceProofRow {
	[key: string]: unknown;
	id: string;
	session_id: string;
	device_identifier_digest: string;
	proof_digest: string;
	created_at: Date;
	expires_at: Date;
	last_seen_at: Date;
	revoked_at: Date | null;
}

interface JsonValueRow {
	[key: string]: unknown;
	value: CoreJsonValue;
}

interface InstallationStateRow {
	[key: string]: unknown;
	instance_id: string;
	status: CoreInstallationState["status"];
	bootstrap_version: number;
	lock_owner: string | null;
	locked_at: Date | null;
	completed_at: Date | null;
	failure_code: string | null;
	updated_at: Date;
}

interface EventRow {
	[key: string]: unknown;
	id: string;
	sequence: string;
	owner_identifier: string;
	topic: string;
	schema_version: number;
	payload: Record<string, CoreJsonValue>;
	payload_checksum: string | null;
	signature: string | null;
	occurred_at: Date;
	received_at: Date;
	retention_until: Date;
	idempotency_key: string | null;
}

interface EventConsumerRow {
	[key: string]: unknown;
	identifier: string;
	owner_identifier: string;
	topics: string[];
	last_sequence: string;
	is_active: boolean;
	created_at: Date;
	updated_at: Date;
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

	async getInstanceIdentity(instanceId: string): Promise<CoreInstanceIdentity | undefined> {
		const result = await this.query<InstanceIdentityRow>(/* pgsql */ sql`
			SELECT
				instance_id,
				identity_identifier,
				algorithm,
				format_version,
				public_key,
				public_key_fingerprint,
				key_reference,
				assurance_level,
				created_at,
				updated_at
			FROM
				core.instance_identities
			WHERE
				instance_id = ${instanceId}
		`);
		const row = result.rows[0];
		return row ? mapInstanceIdentity(row) : undefined;
	}

	async setInstanceIdentity(identity: CoreInstanceIdentity): Promise<void> {
		const result = await this.query<InstanceIdentityRow>(/* pgsql */ sql`
			INSERT INTO core.instance_identities (
				instance_id,
				identity_identifier,
				algorithm,
				format_version,
				public_key,
				public_key_fingerprint,
				key_reference,
				assurance_level,
				created_at,
				updated_at
			)
			VALUES (
				${identity.instanceId},
				${identity.identifier},
				${identity.algorithm},
				${identity.formatVersion},
				${Buffer.from(identity.publicKey)},
				${identity.publicKeyFingerprint},
				${identity.keyReference},
				${identity.assurance},
				${identity.createdAt},
				${identity.updatedAt}
			)
			ON CONFLICT (instance_id) DO NOTHING
			RETURNING
				instance_id,
				identity_identifier,
				algorithm,
				format_version,
				public_key,
				public_key_fingerprint,
				key_reference,
				assurance_level,
				created_at,
				updated_at
		`);
		if (result.rowCount === 1) return;
		const existing = await this.getInstanceIdentity(identity.instanceId);
		if (!existing || !sameInstanceIdentity(existing, identity)) {
			throw new CoreError("lifecycle.invalid_state", "The resource is in an invalid state.");
		}
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

	async getInstallationToken(instanceId: string): Promise<CoreInstallationToken | undefined> {
		const result = await this.query<InstallationTokenRow>(/* pgsql */ sql`
			SELECT
				instance_id,
				token_digest,
				created_at,
				expires_at,
				consumed_at
			FROM
				core.installation_tokens
			WHERE
				instance_id = ${instanceId}
		`);
		const row = result.rows[0];
		return row
			? {
					instanceId: row.instance_id,
					tokenDigest: row.token_digest,
					createdAt: row.created_at,
					expiresAt: row.expires_at,
					...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
				}
			: undefined;
	}

	async setInstallationToken(token: CoreInstallationToken): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.installation_tokens (
				instance_id,
				token_digest,
				created_at,
				expires_at,
				consumed_at
			)
			VALUES (
				${token.instanceId},
				${token.tokenDigest},
				${token.createdAt},
				${token.expiresAt},
				${token.consumedAt ?? null}
			)
			ON CONFLICT (instance_id) DO UPDATE
			SET
				token_digest = EXCLUDED.token_digest,
				created_at = EXCLUDED.created_at,
				expires_at = EXCLUDED.expires_at,
				consumed_at = EXCLUDED.consumed_at
		`);
	}

	async consumeInstallationToken(
		instanceId: string,
		tokenDigest: string,
		consumedAt: Date,
	): Promise<boolean> {
		const result = await this.query(/* pgsql */ sql`
			UPDATE core.installation_tokens
			SET
				consumed_at = ${consumedAt}
			WHERE
				instance_id = ${instanceId}
				AND token_digest = ${tokenDigest}
				AND consumed_at IS NULL
				AND expires_at > ${consumedAt}
			RETURNING
				instance_id
		`);
		return (result.rowCount ?? 0) === 1;
	}

	async upsertEmailAddress(email: CoreEmailAddress): Promise<void> {
		await this.transaction(async () => {
			if (email.primary) {
				await this.query(/* pgsql */ sql`
					UPDATE core.user_email_addresses
					SET
						is_primary = false,
						updated_at = ${email.updatedAt}
					WHERE
						user_id = ${email.userId}
						AND id <> ${email.id}
						AND is_primary
				`);
			}
			await this.query(/* pgsql */ sql`
				INSERT INTO core.user_email_addresses (
					id,
					user_id,
					email,
					normalized_email,
					is_primary,
					verified_at,
					created_at,
					updated_at
				)
				VALUES (
					${email.id},
					${email.userId},
					${email.email},
					${email.normalizedEmail},
					${email.primary},
					${email.verifiedAt ?? null},
					${email.createdAt},
					${email.updatedAt}
				)
				ON CONFLICT (id) DO UPDATE
				SET
					email = EXCLUDED.email,
					normalized_email = EXCLUDED.normalized_email,
					is_primary = EXCLUDED.is_primary,
					verified_at = EXCLUDED.verified_at,
					updated_at = EXCLUDED.updated_at
			`);
		});
	}

	async findEmailAddress(normalizedEmail: string): Promise<CoreEmailAddress | undefined> {
		const result = await this.query<EmailAddressRow>(/* pgsql */ sql`
			SELECT
				id,
				user_id,
				email,
				normalized_email,
				is_primary,
				verified_at,
				created_at,
				updated_at
			FROM
				core.user_email_addresses
			WHERE
				normalized_email = ${normalizedEmail}
		`);
		return result.rows[0] ? mapEmailAddress(result.rows[0]) : undefined;
	}

	async markEmailVerified(emailId: string, verifiedAt: Date): Promise<void> {
		await this.query(/* pgsql */ sql`
			UPDATE core.user_email_addresses
			SET
				verified_at = ${verifiedAt},
				updated_at = ${verifiedAt}
			WHERE
				id = ${emailId}
		`);
	}

	async createSecurityToken(token: CoreSecurityToken): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.security_tokens (
				id,
				user_id,
				purpose,
				token_digest,
				created_at,
				expires_at,
				consumed_at,
				metadata
			)
			VALUES (
				${token.id},
				${token.userId ?? null},
				${token.purpose},
				${token.tokenDigest},
				${token.createdAt},
				${token.expiresAt},
				${token.consumedAt ?? null},
				${JSON.stringify(token.metadata)}
			)
		`);
	}

	async consumeSecurityToken(
		purpose: SecurityTokenPurpose,
		tokenDigest: string,
		consumedAt: Date,
	): Promise<CoreSecurityToken | undefined> {
		const result = await this.query<SecurityTokenRow>(/* pgsql */ sql`
			UPDATE core.security_tokens
			SET
				consumed_at = ${consumedAt}
			WHERE
				purpose = ${purpose}
				AND token_digest = ${tokenDigest}
				AND consumed_at IS NULL
				AND expires_at > ${consumedAt}
			RETURNING
				id,
				user_id,
				purpose,
				token_digest,
				created_at,
				expires_at,
				consumed_at,
				metadata
		`);
		return result.rows[0] ? mapSecurityToken(result.rows[0]) : undefined;
	}

	async createPasskey(passkey: CorePasskey): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.user_passkeys (
				id,
				user_id,
				credential_id,
				public_key,
				sign_count,
				transports,
				device_type,
				backed_up,
				display_name,
				created_at,
				last_used_at
			)
			VALUES (
				${passkey.id},
				${passkey.userId},
				${Buffer.from(passkey.credentialId)},
				${Buffer.from(passkey.publicKey)},
				${passkey.signCount},
				${[...passkey.transports]},
				${passkey.deviceType},
				${passkey.backedUp},
				${passkey.displayName},
				${passkey.createdAt},
				${passkey.lastUsedAt ?? null}
			)
		`);
	}

	async listPasskeys(userId: string): Promise<readonly CorePasskey[]> {
		const result = await this.query<PasskeyRow>(/* pgsql */ sql`
			SELECT
				id,
				user_id,
				credential_id,
				public_key,
				sign_count::text AS sign_count,
				transports,
				device_type,
				backed_up,
				display_name,
				created_at,
				last_used_at
			FROM
				core.user_passkeys
			WHERE
				user_id = ${userId}
			ORDER BY
				created_at
		`);
		return result.rows.map(mapPasskey);
	}

	async updatePasskeyUsage(passkeyId: string, signCount: number, lastUsedAt: Date): Promise<void> {
		const result = await this.query(/* pgsql */ sql`
			UPDATE core.user_passkeys
			SET
				sign_count = ${signCount},
				last_used_at = ${lastUsedAt}
			WHERE
				id = ${passkeyId}
				AND sign_count < ${signCount}
			RETURNING
				id
		`);
		if ((result.rowCount ?? 0) !== 1) {
			throw new CoreError("authentication.invalid_credentials", "Invalid credentials.");
		}
	}

	async deletePasskey(passkeyId: string, userId: string): Promise<void> {
		await this.query(/* pgsql */ sql`
			DELETE FROM core.user_passkeys
			WHERE
				id = ${passkeyId}
				AND user_id = ${userId}
		`);
	}

	async createWebAuthnChallenge(challenge: CoreWebAuthnChallenge): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.webauthn_challenges (
				id,
				user_id,
				session_id,
				purpose,
				challenge_digest,
				created_at,
				expires_at,
				consumed_at,
				metadata
			)
			VALUES (
				${challenge.id},
				${challenge.userId ?? null},
				${challenge.sessionId ?? null},
				${challenge.purpose},
				${challenge.challengeDigest},
				${challenge.createdAt},
				${challenge.expiresAt},
				${challenge.consumedAt ?? null},
				${JSON.stringify(challenge.metadata)}
			)
		`);
	}

	async consumeWebAuthnChallenge(
		purpose: CoreWebAuthnChallenge["purpose"],
		challengeDigest: string,
		consumedAt: Date,
	): Promise<CoreWebAuthnChallenge | undefined> {
		const result = await this.query<WebAuthnChallengeRow>(/* pgsql */ sql`
			UPDATE core.webauthn_challenges
			SET
				consumed_at = ${consumedAt}
			WHERE
				purpose = ${purpose}
				AND challenge_digest = ${challengeDigest}
				AND consumed_at IS NULL
				AND expires_at > ${consumedAt}
			RETURNING
				id,
				user_id,
				session_id,
				purpose,
				challenge_digest,
				created_at,
				expires_at,
				consumed_at,
				metadata
		`);
		return result.rows[0] ? mapWebAuthnChallenge(result.rows[0]) : undefined;
	}

	async upsertSessionDeviceProof(proof: CoreSessionDeviceProof): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.session_device_proofs (
				id,
				session_id,
				device_identifier_digest,
				proof_digest,
				created_at,
				expires_at,
				last_seen_at,
				revoked_at
			)
			VALUES (
				${proof.id},
				${proof.sessionId},
				${proof.deviceIdentifierDigest},
				${proof.proofDigest},
				${proof.createdAt},
				${proof.expiresAt},
				${proof.lastSeenAt},
				${proof.revokedAt ?? null}
			)
			ON CONFLICT (session_id, device_identifier_digest) DO UPDATE
			SET
				proof_digest = EXCLUDED.proof_digest,
				expires_at = EXCLUDED.expires_at,
				last_seen_at = EXCLUDED.last_seen_at,
				revoked_at = EXCLUDED.revoked_at
		`);
	}

	async findSessionDeviceProof(proofDigest: string): Promise<CoreSessionDeviceProof | undefined> {
		const result = await this.query<SessionDeviceProofRow>(/* pgsql */ sql`
			SELECT
				id,
				session_id,
				device_identifier_digest,
				proof_digest,
				created_at,
				expires_at,
				last_seen_at,
				revoked_at
			FROM
				core.session_device_proofs
			WHERE
				proof_digest = ${proofDigest}
		`);
		return result.rows[0] ? mapSessionDeviceProof(result.rows[0]) : undefined;
	}

	async revokeSessionDeviceProof(proofId: string, revokedAt: Date): Promise<void> {
		await this.query(/* pgsql */ sql`
			UPDATE core.session_device_proofs
			SET
				revoked_at = ${revokedAt}
			WHERE
				id = ${proofId}
		`);
	}

	async createUserBan(ban: CoreUserBan): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.user_bans (
				id,
				user_id,
				reason,
				starts_at,
				expires_at,
				created_by,
				created_at,
				revoked_at,
				revoked_by,
				metadata
			)
			VALUES (
				${ban.id},
				${ban.userId},
				${ban.reason},
				${ban.startsAt},
				${ban.expiresAt ?? null},
				${ban.createdBy ?? null},
				${ban.createdAt},
				${ban.revokedAt ?? null},
				${ban.revokedBy ?? null},
				${JSON.stringify(ban.metadata)}
			)
		`);
	}

	async createIpBan(ban: CoreIpBan): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.ip_bans (
				id,
				address_digest,
				reason,
				starts_at,
				expires_at,
				created_by,
				created_at,
				revoked_at,
				revoked_by,
				metadata
			)
			VALUES (
				${ban.id},
				${ban.addressDigest},
				${ban.reason},
				${ban.startsAt},
				${ban.expiresAt ?? null},
				${ban.createdBy ?? null},
				${ban.createdAt},
				${ban.revokedAt ?? null},
				${ban.revokedBy ?? null},
				${JSON.stringify(ban.metadata)}
			)
		`);
	}

	async revokeUserBan(
		banId: string,
		revokedBy: string | undefined,
		revokedAt: Date,
	): Promise<void> {
		await this.query(/* pgsql */ sql`
			UPDATE core.user_bans
			SET
				revoked_at = ${revokedAt},
				revoked_by = ${revokedBy ?? null}
			WHERE
				id = ${banId}
				AND revoked_at IS NULL
		`);
	}

	async revokeIpBan(banId: string, revokedBy: string | undefined, revokedAt: Date): Promise<void> {
		await this.query(/* pgsql */ sql`
			UPDATE core.ip_bans
			SET
				revoked_at = ${revokedAt},
				revoked_by = ${revokedBy ?? null}
			WHERE
				id = ${banId}
				AND revoked_at IS NULL
		`);
	}

	async isUserBanned(userId: string, at: Date): Promise<boolean> {
		const result = await this.query(/* pgsql */ sql`
			SELECT
				1
			FROM
				core.user_bans
			WHERE
				user_id = ${userId}
				AND starts_at <= ${at}
				AND (expires_at IS NULL OR expires_at > ${at})
				AND revoked_at IS NULL
			LIMIT 1
		`);
		return (result.rowCount ?? 0) > 0;
	}

	async isAddressBanned(addressDigest: string, at: Date): Promise<boolean> {
		const result = await this.query(/* pgsql */ sql`
			SELECT
				1
			FROM
				core.ip_bans
			WHERE
				address_digest = ${addressDigest}
				AND starts_at <= ${at}
				AND (expires_at IS NULL OR expires_at > ${at})
				AND revoked_at IS NULL
			LIMIT 1
		`);
		return (result.rowCount ?? 0) > 0;
	}

	async appendSecurityAttempt(attempt: CoreSecurityAttempt): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.security_attempts (
				id,
				kind,
				subject_digest,
				address_digest,
				outcome,
				occurred_at,
				metadata
			)
			VALUES (
				${attempt.id},
				${attempt.kind},
				${attempt.subjectDigest ?? null},
				${attempt.addressDigest ?? null},
				${attempt.outcome},
				${attempt.occurredAt},
				${JSON.stringify(attempt.metadata)}
			)
		`);
	}

	async purgeSecurityData(at: Date, attemptsBefore: Date): Promise<void> {
		await this.transaction(async () => {
			await this.query(/* pgsql */ sql`
				DELETE FROM core.security_tokens
				WHERE
					consumed_at IS NOT NULL
					OR expires_at <= ${at}
			`);
			await this.query(/* pgsql */ sql`
				DELETE FROM core.webauthn_challenges
				WHERE
					consumed_at IS NOT NULL
					OR expires_at <= ${at}
			`);
			await this.query(/* pgsql */ sql`
				DELETE FROM core.session_device_proofs
				WHERE
					revoked_at IS NOT NULL
					OR expires_at <= ${at}
			`);
			await this.query(/* pgsql */ sql`
				DELETE FROM core.security_attempts
				WHERE
					occurred_at < ${attemptsBefore}
			`);
		});
	}

	async setUserPreference(userId: string, key: string, value: CoreJsonValue): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.user_preferences (user_id, preference_key, value)
			VALUES (${userId}, ${key}, ${JSON.stringify(value)})
			ON CONFLICT (user_id, preference_key) DO UPDATE
			SET
				value = EXCLUDED.value,
				updated_at = now()
		`);
	}

	async getUserPreference(userId: string, key: string): Promise<CoreJsonValue | undefined> {
		const result = await this.query<JsonValueRow>(/* pgsql */ sql`
			SELECT
				value
			FROM
				core.user_preferences
			WHERE
				user_id = ${userId}
				AND preference_key = ${key}
		`);
		return result.rows[0]?.value;
	}

	async setInstanceSetting(key: string, value: CoreJsonValue): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.instance_settings (setting_key, value)
			VALUES (${key}, ${JSON.stringify(value)})
			ON CONFLICT (setting_key) DO UPDATE
			SET
				value = EXCLUDED.value,
				updated_at = now()
		`);
	}

	async getInstanceSetting(key: string): Promise<CoreJsonValue | undefined> {
		const result = await this.query<JsonValueRow>(/* pgsql */ sql`
			SELECT
				value
			FROM
				core.instance_settings
			WHERE
				setting_key = ${key}
		`);
		return result.rows[0]?.value;
	}

	async setInstallationState(state: CoreInstallationState): Promise<void> {
		await this.query(/* pgsql */ sql`
			INSERT INTO core.installation_state (
				instance_id,
				status,
				bootstrap_version,
				lock_owner,
				locked_at,
				completed_at,
				failure_code,
				updated_at
			)
			VALUES (
				${state.instanceId},
				${state.status},
				${state.bootstrapVersion},
				${state.lockOwner ?? null},
				${state.lockedAt ?? null},
				${state.completedAt ?? null},
				${state.failureCode ?? null},
				${state.updatedAt}
			)
			ON CONFLICT (instance_id) DO UPDATE
			SET
				status = EXCLUDED.status,
				bootstrap_version = EXCLUDED.bootstrap_version,
				lock_owner = EXCLUDED.lock_owner,
				locked_at = EXCLUDED.locked_at,
				completed_at = EXCLUDED.completed_at,
				failure_code = EXCLUDED.failure_code,
				updated_at = EXCLUDED.updated_at
		`);
	}

	async getInstallationState(instanceId: string): Promise<CoreInstallationState | undefined> {
		const result = await this.query<InstallationStateRow>(/* pgsql */ sql`
			SELECT
				instance_id,
				status,
				bootstrap_version,
				lock_owner,
				locked_at,
				completed_at,
				failure_code,
				updated_at
			FROM
				core.installation_state
			WHERE
				instance_id = ${instanceId}
		`);
		return result.rows[0] ? mapInstallationState(result.rows[0]) : undefined;
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
			throw new CoreError("authorization.founder_protected", "The founder account is protected.");
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

	async declareCapabilityImplication(capability: string, impliedCapability: string): Promise<void> {
		if (capability === impliedCapability) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		await this.transaction(async () => {
			await this.query(/* pgsql */ sql`
				SELECT
					pg_advisory_xact_lock(hashtext('core.capability_implications'))
			`);
			for (const identifier of [capability, impliedCapability]) {
				await this.query(/* pgsql */ sql`
					INSERT INTO core.capabilities (identifier, is_core)
					VALUES (${identifier}, ${identifier.startsWith("core.")})
					ON CONFLICT (identifier) DO NOTHING
				`);
			}
			const cycle = await this.query(/* pgsql */ sql`
				WITH RECURSIVE implied (identifier) AS (
					SELECT
						implied_capability_identifier
					FROM
						core.capability_implications
					WHERE
						capability_identifier = ${impliedCapability}
					UNION
					SELECT
						ci.implied_capability_identifier
					FROM
						core.capability_implications ci
						INNER JOIN implied i ON i.identifier = ci.capability_identifier
				)
				SELECT
					1
				FROM
					implied
				WHERE
					identifier = ${capability}
				LIMIT 1
			`);
			if ((cycle.rowCount ?? 0) > 0) {
				throw new CoreError("configuration.invalid", "Invalid configuration.");
			}
			await this.query(/* pgsql */ sql`
				INSERT INTO core.capability_implications (
					capability_identifier,
					implied_capability_identifier
				)
				VALUES (${capability}, ${impliedCapability})
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

	async declareRoleIncompatibility(firstRoleId: string, secondRoleId: string): Promise<void> {
		if (firstRoleId === secondRoleId) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		const [lowerRoleId, upperRoleId] =
			firstRoleId < secondRoleId ? [firstRoleId, secondRoleId] : [secondRoleId, firstRoleId];
		await this.transaction(async () => {
			await this.lockRoleAssignments();
			const conflict = await this.query(/* pgsql */ sql`
				SELECT
					1
				FROM
					core.user_roles first_assignment
					INNER JOIN core.user_roles second_assignment ON second_assignment.user_id = first_assignment.user_id
				WHERE
					first_assignment.role_id = ${lowerRoleId}
					AND second_assignment.role_id = ${upperRoleId}
				LIMIT 1
			`);
			if ((conflict.rowCount ?? 0) > 0) {
				throw new CoreError("configuration.invalid", "Invalid configuration.");
			}
			await this.query(/* pgsql */ sql`
				INSERT INTO core.role_incompatibilities (lower_role_id, upper_role_id)
				VALUES (${lowerRoleId}, ${upperRoleId})
				ON CONFLICT DO NOTHING
			`);
		});
	}

	async assignRole(userId: string, roleId: string): Promise<void> {
		await this.transaction(async () => {
			await this.lockRoleAssignments();
			const incompatible = await this.query(/* pgsql */ sql`
				SELECT
					1
				FROM
					core.user_roles ur
					INNER JOIN core.role_incompatibilities ri ON (
						ri.lower_role_id = ur.role_id
						AND ri.upper_role_id = ${roleId}
					)
					OR (
						ri.upper_role_id = ur.role_id
						AND ri.lower_role_id = ${roleId}
					)
				WHERE
					ur.user_id = ${userId}
				LIMIT 1
			`);
			if ((incompatible.rowCount ?? 0) > 0) {
				throw new CoreError("authorization.denied", "Access denied.");
			}
			await this.query(/* pgsql */ sql`
				INSERT INTO core.user_roles (user_id, role_id)
				VALUES (${userId}, ${roleId})
				ON CONFLICT DO NOTHING
			`);
		});
	}

	async hasCapability(userId: string, capability: string): Promise<boolean> {
		const result = await this.query(/* pgsql */ sql`
			WITH RECURSIVE granted (identifier) AS (
				SELECT
					capability_identifier
				FROM
					core.user_capabilities
				WHERE
					user_id = ${userId}
				UNION
				SELECT
					rc.capability_identifier
				FROM
					core.user_roles ur
					INNER JOIN core.role_capabilities rc ON rc.role_id = ur.role_id
				WHERE
					ur.user_id = ${userId}
			), effective (identifier) AS (
				SELECT
					identifier
				FROM
					granted
				UNION
				SELECT
					ci.implied_capability_identifier
				FROM
					core.capability_implications ci
					INNER JOIN effective e ON e.identifier = ci.capability_identifier
			)
			SELECT
				1
			FROM
				effective
			WHERE
				identifier = ${capability}
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

	async appendEvent(event: Omit<CoreEvent, "sequence">): Promise<CoreEvent> {
		const result = await this.query<EventRow>(/* pgsql */ sql`
			INSERT INTO core.events (
				id,
				owner_identifier,
				topic,
				schema_version,
				payload,
				payload_checksum,
				signature,
				occurred_at,
				received_at,
				retention_until,
				idempotency_key
			)
			VALUES (
				${event.id},
				${event.ownerIdentifier},
				${event.topic},
				${event.schemaVersion},
				${JSON.stringify(event.payload)},
				${event.payloadChecksum},
				${event.signature},
				${event.occurredAt},
				${event.receivedAt},
				${event.retentionUntil},
				${event.idempotencyKey ?? null}
			)
			ON CONFLICT (owner_identifier, idempotency_key)
				WHERE idempotency_key IS NOT NULL
			DO UPDATE SET
				idempotency_key = excluded.idempotency_key
			RETURNING
				id,
				sequence::text AS sequence,
				owner_identifier,
				topic,
				schema_version,
				payload,
				payload_checksum,
				signature,
				occurred_at,
				received_at,
				retention_until,
				idempotency_key
		`);
		const row = result.rows[0];
		if (!row)
			throw new CoreError(
				"infrastructure.unavailable",
				"The required infrastructure is unavailable.",
			);
		return mapEvent(row);
	}

	async latestEventSequence(): Promise<bigint> {
		const result = await this.query<CountRow>(/* pgsql */ sql`
			SELECT
				coalesce(max(sequence), 0)::text AS count
			FROM
				core.events
		`);
		return BigInt(result.rows[0]?.count ?? "0");
	}

	async registerEventConsumer(consumer: CoreEventConsumer): Promise<CoreEventConsumer> {
		const result = await this.query<EventConsumerRow>(/* pgsql */ sql`
			INSERT INTO core.event_consumers (
				identifier,
				owner_identifier,
				topics,
				last_sequence,
				is_active,
				created_at,
				updated_at
			)
			VALUES (
				${consumer.identifier},
				${consumer.ownerIdentifier},
				${[...consumer.topics]},
				${consumer.lastSequence},
				${consumer.active},
				${consumer.createdAt},
				${consumer.updatedAt}
			)
			ON CONFLICT (identifier) DO UPDATE SET
				topics = excluded.topics,
				is_active = excluded.is_active,
				updated_at = excluded.updated_at
			WHERE
				core.event_consumers.owner_identifier = excluded.owner_identifier
			RETURNING
				identifier,
				owner_identifier,
				topics,
				last_sequence::text AS last_sequence,
				is_active,
				created_at,
				updated_at
		`);
		const row = result.rows[0];
		if (!row) {
			throw new CoreError("authorization.denied", "Access denied.");
		}
		return mapEventConsumer(row);
	}

	async getEventConsumer(identifier: string): Promise<CoreEventConsumer | undefined> {
		const result = await this.query<EventConsumerRow>(/* pgsql */ sql`
			SELECT
				identifier,
				owner_identifier,
				topics,
				last_sequence::text AS last_sequence,
				is_active,
				created_at,
				updated_at
			FROM
				core.event_consumers
			WHERE
				identifier = ${identifier}
		`);
		const row = result.rows[0];
		return row ? mapEventConsumer(row) : undefined;
	}

	async readEventsForConsumer(identifier: string, limit: number): Promise<readonly CoreEvent[]> {
		const result = await this.query<EventRow>(/* pgsql */ sql`
			SELECT
				e.id,
				e.sequence::text AS sequence,
				e.owner_identifier,
				e.topic,
				e.schema_version,
				e.payload,
				e.payload_checksum,
				e.signature,
				e.occurred_at,
				e.received_at,
				e.retention_until,
				e.idempotency_key
			FROM
				core.events e
				INNER JOIN core.event_consumers c ON c.identifier = ${identifier}
			WHERE
				c.is_active = true
				AND e.sequence > c.last_sequence
				AND e.topic = ANY(c.topics)
			ORDER BY
				e.sequence ASC
			LIMIT ${limit}
		`);
		return result.rows.map(mapEvent);
	}

	async advanceEventConsumer(identifier: string, sequence: bigint, updatedAt: Date): Promise<void> {
		const result = await this.query(/* pgsql */ sql`
			UPDATE core.event_consumers c
			SET
				last_sequence = ${sequence},
				updated_at = ${updatedAt}
			WHERE
				c.identifier = ${identifier}
				AND c.is_active = true
				AND ${sequence} >= c.last_sequence
				AND (
					${sequence} = c.last_sequence
					OR EXISTS (
						SELECT
							1
						FROM
							core.events e
						WHERE
							e.sequence = ${sequence}
							AND e.topic = ANY(c.topics)
					)
				)
			RETURNING
				c.identifier
		`);
		if (result.rowCount !== 1) {
			throw new CoreError("lifecycle.invalid_state", "The resource is in an invalid state.");
		}
	}

	async setEventConsumerActive(
		identifier: string,
		active: boolean,
		updatedAt: Date,
	): Promise<void> {
		const result = await this.query(/* pgsql */ sql`
			UPDATE core.event_consumers
			SET
				is_active = ${active},
				updated_at = ${updatedAt}
			WHERE
				identifier = ${identifier}
			RETURNING
				identifier
		`);
		if (result.rowCount !== 1) {
			throw new CoreError("lifecycle.invalid_state", "The resource is in an invalid state.");
		}
	}

	async purgeExpiredEvents(at: Date): Promise<number> {
		const result = await this.query(/* pgsql */ sql`
			DELETE FROM core.events e
			WHERE
				e.retention_until <= ${at}
				AND NOT EXISTS (
					SELECT
						1
					FROM
						core.event_consumers c
					WHERE
						c.is_active = true
						AND e.topic = ANY(c.topics)
						AND c.last_sequence < e.sequence
				)
			RETURNING
				e.id
		`);
		return result.rowCount;
	}

	private query<Row extends Record<string, unknown> = Record<string, unknown>>(
		statement: Parameters<CoreDatabase["query"]>[0],
	): Promise<DatabaseResult<Row>> {
		return (this.transactionStorage.getStore() ?? this.database).query<Row>(statement);
	}

	private async lockRoleAssignments(): Promise<void> {
		await this.query(/* pgsql */ sql`
			SELECT
				pg_advisory_xact_lock(hashtext('core.role_assignments'))
		`);
	}
}

function mapEvent(row: EventRow): CoreEvent {
	if (!row.payload_checksum || !row.signature) {
		throw new CoreError(
			"infrastructure.unavailable",
			"The required infrastructure is unavailable.",
		);
	}
	return {
		id: row.id,
		sequence: BigInt(row.sequence),
		ownerIdentifier: row.owner_identifier,
		topic: row.topic,
		schemaVersion: row.schema_version,
		payload: row.payload,
		payloadChecksum: row.payload_checksum,
		signature: row.signature,
		occurredAt: row.occurred_at,
		receivedAt: row.received_at,
		retentionUntil: row.retention_until,
		...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
	};
}

function mapInstanceIdentity(row: InstanceIdentityRow): CoreInstanceIdentity {
	return {
		instanceId: row.instance_id,
		identifier: row.identity_identifier,
		algorithm: row.algorithm,
		formatVersion: row.format_version,
		publicKey: Uint8Array.from(row.public_key),
		publicKeyFingerprint: row.public_key_fingerprint,
		keyReference: row.key_reference,
		assurance: row.assurance_level,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function sameInstanceIdentity(first: CoreInstanceIdentity, second: CoreInstanceIdentity): boolean {
	return (
		first.identifier === second.identifier &&
		first.algorithm === second.algorithm &&
		first.formatVersion === second.formatVersion &&
		first.publicKeyFingerprint === second.publicKeyFingerprint &&
		first.keyReference === second.keyReference &&
		first.assurance === second.assurance &&
		Buffer.from(first.publicKey).equals(Buffer.from(second.publicKey))
	);
}

function mapEventConsumer(row: EventConsumerRow): CoreEventConsumer {
	return {
		identifier: row.identifier,
		ownerIdentifier: row.owner_identifier,
		topics: row.topics,
		lastSequence: BigInt(row.last_sequence),
		active: row.is_active,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
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

function mapEmailAddress(row: EmailAddressRow): CoreEmailAddress {
	return {
		id: row.id,
		userId: row.user_id,
		email: row.email,
		normalizedEmail: row.normalized_email,
		primary: row.is_primary,
		...(row.verified_at ? { verifiedAt: row.verified_at } : {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapSecurityToken(row: SecurityTokenRow): CoreSecurityToken {
	return {
		id: row.id,
		...(row.user_id ? { userId: row.user_id } : {}),
		purpose: row.purpose,
		tokenDigest: row.token_digest,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
		metadata: row.metadata,
	};
}

function mapPasskey(row: PasskeyRow): CorePasskey {
	return {
		id: row.id,
		userId: row.user_id,
		credentialId: Uint8Array.from(row.credential_id),
		publicKey: Uint8Array.from(row.public_key),
		signCount: Number(row.sign_count),
		transports: row.transports,
		deviceType: row.device_type,
		backedUp: row.backed_up,
		displayName: row.display_name,
		createdAt: row.created_at,
		...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
	};
}

function mapWebAuthnChallenge(row: WebAuthnChallengeRow): CoreWebAuthnChallenge {
	return {
		id: row.id,
		...(row.user_id ? { userId: row.user_id } : {}),
		...(row.session_id ? { sessionId: row.session_id } : {}),
		purpose: row.purpose,
		challengeDigest: row.challenge_digest,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
		metadata: row.metadata,
	};
}

function mapSessionDeviceProof(row: SessionDeviceProofRow): CoreSessionDeviceProof {
	return {
		id: row.id,
		sessionId: row.session_id,
		deviceIdentifierDigest: row.device_identifier_digest,
		proofDigest: row.proof_digest,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		lastSeenAt: row.last_seen_at,
		...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
	};
}

function mapInstallationState(row: InstallationStateRow): CoreInstallationState {
	return {
		instanceId: row.instance_id,
		status: row.status,
		bootstrapVersion: row.bootstrap_version,
		...(row.lock_owner ? { lockOwner: row.lock_owner } : {}),
		...(row.locked_at ? { lockedAt: row.locked_at } : {}),
		...(row.completed_at ? { completedAt: row.completed_at } : {}),
		...(row.failure_code ? { failureCode: row.failure_code } : {}),
		updatedAt: row.updated_at,
	};
}
