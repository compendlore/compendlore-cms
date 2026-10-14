import {
	createHash,
	createHmac,
	createCipheriv,
	createDecipheriv,
	randomBytes,
	randomUUID,
	scrypt as nodeScrypt,
	timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { CoreError } from "./errors.js";
import type { AccountSecurityService } from "./account-security.js";
import type { InstallationTokenService } from "./installation.js";
import type { SecretCipher } from "./services.js";
import {
	CORE_CAPABILITIES,
	type AuditRecord,
	type CoreSession,
	type CoreStore,
	type CoreUser,
} from "./store.js";

const scrypt = promisify(nodeScrypt);

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export class PasswordHasher {
	constructor(private readonly pepper: string) {}

	async hash(password: string): Promise<string> {
		if (password.length < 12) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		const salt = randomBytes(16).toString("hex");
		const derived = (await scrypt(`${password}\0${this.pepper}`, salt, 64)) as Buffer;
		return `scrypt$${salt}$${derived.toString("hex")}`;
	}

	async verify(password: string, encoded: string): Promise<boolean> {
		const [algorithm, salt, expectedHex] = encoded.split("$");
		if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
		const expected = Buffer.from(expectedHex, "hex");
		const actual = (await scrypt(`${password}\0${this.pepper}`, salt, expected.length)) as Buffer;
		return expected.length === actual.length && timingSafeEqual(expected, actual);
	}
}

export class AesGcmSecretCipher implements SecretCipher {
	private readonly key: Buffer;

	constructor(secret: string) {
		this.key = createHash("sha256").update(secret).digest();
	}

	seal(value: string): string {
		const initializationVector = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, initializationVector);
		const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
		return [
			"aes-256-gcm",
			initializationVector.toString("base64url"),
			cipher.getAuthTag().toString("base64url"),
			encrypted.toString("base64url"),
		].join(".");
	}

	open(value: string): string {
		const [algorithm, initializationVector, authenticationTag, encrypted] = value.split(".");
		if (algorithm !== "aes-256-gcm" || !initializationVector || !authenticationTag || !encrypted) {
			throw new CoreError(
				"infrastructure.unavailable",
				"The required infrastructure is unavailable.",
			);
		}
		try {
			const decipher = createDecipheriv(
				"aes-256-gcm",
				this.key,
				Buffer.from(initializationVector, "base64url"),
			);
			decipher.setAuthTag(Buffer.from(authenticationTag, "base64url"));
			return Buffer.concat([
				decipher.update(Buffer.from(encrypted, "base64url")),
				decipher.final(),
			]).toString("utf8");
		} catch (error) {
			throw new CoreError(
				"infrastructure.unavailable",
				"The required infrastructure is unavailable.",
				{
					cause: error,
				},
			);
		}
	}
}

export interface AuthenticatedSession {
	readonly token: string;
	readonly session: CoreSession;
	readonly user: CoreUser;
}

export class AuthenticationService {
	constructor(
		private readonly store: CoreStore,
		private readonly passwords: PasswordHasher,
		private readonly installationTokens: InstallationTokenService,
		private readonly accountSecurity: AccountSecurityService,
		private readonly loginRateLimiter: RateLimiter,
		private readonly sessionTtlMs: number,
		private readonly adminSessionTtlMs: number,
		private readonly now: () => Date = () => new Date(),
	) {}

	async createFounder(input: {
		login: string;
		displayName: string;
		password: string;
		installationToken: string;
		correlationId: string;
	}): Promise<CoreUser> {
		const founder = await this.store.transaction(async () => {
			if ((await this.store.countUsers()) !== 0) {
				throw new CoreError("authorization.denied", "Access denied.");
			}
			if (!(await this.installationTokens.consume(input.installationToken, this.now()))) {
				throw new CoreError(
					"installation.token_invalid",
					"The installation token is invalid or expired.",
				);
			}
			const user: CoreUser = {
				id: randomUUID(),
				login: normalizeLogin(input.login),
				displayName: input.displayName.trim(),
				passwordDigest: await this.passwords.hash(input.password),
				founder: true,
				active: true,
				createdAt: this.now(),
			};
			if (!user.login || !user.displayName) {
				throw new CoreError("configuration.invalid", "The identifier and name are required.");
			}
			await this.store.createUser(user);
			for (const capability of Object.values(CORE_CAPABILITIES)) {
				await this.store.grantCapability(user.id, capability);
			}
			await this.audit("security.founder.created", "allowed", input.correlationId, user.id);
			return user;
		});
		await this.installationTokens.complete();
		return founder;
	}

	async login(
		login: string,
		password: string,
		correlationId: string,
		context: { readonly address?: string } = {},
	): Promise<AuthenticatedSession> {
		const normalizedLogin = normalizeLogin(login);
		const rateLimitSubjects = [
			`login:${normalizedLogin}`,
			...(context.address
				? [`address:${this.accountSecurity.digestAddress(context.address)}`]
				: []),
		];
		try {
			for (const subject of rateLimitSubjects) {
				this.loginRateLimiter.consume("authentication.login", subject);
			}
		} catch (error) {
			await this.accountSecurity.recordAttempt({
				kind: "login",
				outcome: "blocked",
				subject: normalizedLogin,
				...(context.address ? { address: context.address } : {}),
			});
			await this.audit("security.login", "denied", correlationId);
			throw error;
		}
		try {
			await this.accountSecurity.assertAccessAllowed(undefined, context.address);
		} catch (error) {
			await this.accountSecurity.recordAttempt({
				kind: "login",
				outcome: "blocked",
				subject: normalizedLogin,
				...(context.address ? { address: context.address } : {}),
			});
			await this.audit("security.login", "denied", correlationId);
			throw new CoreError("authentication.invalid_credentials", "Invalid credentials.", {
				cause: error,
			});
		}
		const user = await this.store.findUserByLogin(normalizedLogin);
		if (user) {
			try {
				await this.accountSecurity.assertAccessAllowed(user.id, context.address);
			} catch (error) {
				await this.accountSecurity.recordAttempt({
					kind: "login",
					outcome: "blocked",
					subject: normalizedLogin,
					...(context.address ? { address: context.address } : {}),
				});
				await this.audit("security.login", "denied", correlationId, user.id);
				throw new CoreError("authentication.invalid_credentials", "Invalid credentials.", {
					cause: error,
				});
			}
		}
		if (!user?.active || !(await this.passwords.verify(password, user.passwordDigest))) {
			await this.accountSecurity.recordAttempt({
				kind: "login",
				outcome: "failed",
				subject: normalizedLogin,
				...(context.address ? { address: context.address } : {}),
			});
			await this.audit("security.login", "denied", correlationId, user?.id);
			throw new CoreError("authentication.invalid_credentials", "Invalid credentials.");
		}

		const token = randomBytes(32).toString("base64url");
		const createdAt = this.now();
		const session: CoreSession = {
			id: randomUUID(),
			userId: user.id,
			tokenDigest: digest(token),
			createdAt,
			expiresAt: new Date(createdAt.getTime() + this.sessionTtlMs),
		};
		await this.store.createSession(session);
		await this.accountSecurity.recordAttempt({
			kind: "login",
			outcome: "succeeded",
			subject: normalizedLogin,
			...(context.address ? { address: context.address } : {}),
		});
		for (const subject of rateLimitSubjects)
			this.loginRateLimiter.reset("authentication.login", subject);
		await this.audit("security.login", "allowed", correlationId, user.id);
		return { token, session, user };
	}

	async authenticate(token: string): Promise<AuthenticatedSession> {
		const session = await this.store.findSessionByTokenDigest(digest(token));
		if (!session || session.revokedAt || session.expiresAt.getTime() <= this.now().getTime()) {
			throw new CoreError(
				"authentication.session_expired",
				"The session is missing, revoked, or expired.",
			);
		}
		const user = await this.store.findUserById(session.userId);
		if (!user?.active)
			throw new CoreError(
				"authentication.session_expired",
				"The session is missing, revoked, or expired.",
			);
		await this.accountSecurity.assertAccessAllowed(user.id);
		return { token, session, user };
	}

	async revoke(token: string, correlationId: string): Promise<void> {
		if (!token) return;
		const session = await this.store.findSessionByTokenDigest(digest(token));
		if (!session || session.revokedAt) return;
		await this.store.revokeSession(session.id, this.now());
		await this.audit("security.session.revoked", "allowed", correlationId, session.userId);
	}

	async requireCapability(token: string, capability: string): Promise<AuthenticatedSession> {
		const authenticated = await this.authenticate(token);
		if (!(await this.store.hasCapability(authenticated.user.id, capability))) {
			throw new CoreError("authorization.denied", "Access denied.");
		}
		return authenticated;
	}

	async requireAdministration(
		token: string,
		correlationId = randomUUID(),
	): Promise<AuthenticatedSession> {
		let authenticated: AuthenticatedSession | undefined;
		try {
			authenticated = await this.authenticate(token);
			if (
				!(await this.store.hasCapability(
					authenticated.user.id,
					CORE_CAPABILITIES.administrationAccess,
				))
			) {
				throw new CoreError("authorization.denied", "Access denied.");
			}
			const verifiedAt = authenticated.session.secondFactorVerifiedAt?.getTime() ?? 0;
			if (verifiedAt + this.adminSessionTtlMs <= this.now().getTime()) {
				throw new CoreError(
					"authentication.two_factor_required",
					"Two-factor authentication is required.",
				);
			}
			await this.audit(
				"security.administration.access",
				"allowed",
				correlationId,
				authenticated.user.id,
			);
			return authenticated;
		} catch (error) {
			await this.audit(
				"security.administration.access",
				"denied",
				correlationId,
				authenticated?.user.id,
			);
			throw error;
		}
	}

	private async audit(
		action: string,
		outcome: AuditRecord["outcome"],
		correlationId: string,
		actorId?: string,
	): Promise<void> {
		await this.store.appendAudit({
			id: randomUUID(),
			occurredAt: this.now(),
			action,
			outcome,
			...(actorId ? { actorId } : {}),
			correlationId,
			metadata: {},
		});
	}
}

export class TwoFactorService {
	constructor(
		private readonly store: CoreStore,
		private readonly now: () => Date = () => new Date(),
	) {}

	async verify(session: CoreSession, code: string, correlationId = randomUUID()): Promise<void> {
		const registration = await this.store.getTwoFactor(session.userId);
		if (!registration) {
			await this.audit("denied", correlationId, session.userId);
			throw new CoreError(
				"authentication.two_factor_required",
				"Two-factor authentication is required.",
			);
		}
		const accepted = verifyTotp(registration.secret, code, this.now());
		const recoveryAccepted = accepted
			? false
			: await this.store.consumeRecoveryCode(session.userId, digest(code));
		if (!accepted && !recoveryAccepted) {
			await this.audit("denied", correlationId, session.userId);
			throw new CoreError("authentication.invalid_credentials", "Invalid credentials.");
		}
		await this.store.markSecondFactorVerified(session.id, this.now());
		await this.audit("allowed", correlationId, session.userId);
	}

	private async audit(
		outcome: AuditRecord["outcome"],
		correlationId: string,
		actorId: string,
	): Promise<void> {
		await this.store.appendAudit({
			id: randomUUID(),
			occurredAt: this.now(),
			action: "security.two_factor.verify",
			outcome,
			actorId,
			correlationId,
			metadata: {},
		});
	}
}

export class CsrfProtection {
	constructor(private readonly secret: string) {}

	issue(sessionId: string): string {
		const nonce = randomBytes(18).toString("base64url");
		return `${nonce}.${this.signature(sessionId, nonce)}`;
	}

	verify(sessionId: string, token: string): void {
		const [nonce, signature] = token.split(".");
		if (!nonce || !signature || !safeEqual(signature, this.signature(sessionId, nonce))) {
			throw new CoreError("security.csrf_invalid", "The CSRF token is invalid.");
		}
	}

	private signature(sessionId: string, nonce: string): string {
		return createHmac("sha256", this.secret).update(`${sessionId}.${nonce}`).digest("base64url");
	}
}

export class SessionSecurityService {
	constructor(
		private readonly authentication: AuthenticationService,
		private readonly csrf: CsrfProtection,
	) {}

	async issueCsrf(token: string): Promise<string> {
		const authenticated = await this.authentication.authenticate(token);
		return this.csrf.issue(authenticated.session.id);
	}

	async verifyCsrf(token: string, csrfToken: string): Promise<AuthenticatedSession> {
		const authenticated = await this.authentication.authenticate(token);
		this.csrf.verify(authenticated.session.id, csrfToken);
		return authenticated;
	}
}

export class RateLimiter {
	private readonly windows = new Map<string, { count: number; startedAt: number }>();

	constructor(
		private readonly limit: number,
		private readonly windowMs: number,
		private readonly now: () => Date = () => new Date(),
	) {}

	consume(scope: string, subject: string): void {
		const key = `${scope}:${subject}`;
		const now = this.now().getTime();
		const current = this.windows.get(key);
		if (!current || current.startedAt + this.windowMs <= now) {
			this.windows.set(key, { count: 1, startedAt: now });
			return;
		}
		if (current.count >= this.limit) {
			throw new CoreError("security.rate_limited", "Too many attempts.", { retryable: true });
		}
		current.count += 1;
	}

	reset(scope: string, subject: string): void {
		this.windows.delete(`${scope}:${subject}`);
	}
}

function normalizeLogin(login: string): string {
	return login.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyTotp(secret: string, code: string, now: Date): boolean {
	if (!/^\d{6}$/.test(code)) return false;
	const key = decodeBase32(secret);
	const currentStep = Math.floor(now.getTime() / 30_000);
	return [-1, 0, 1].some((offset) => totp(key, currentStep + offset) === code);
}

function totp(key: Buffer, counter: number): string {
	const value = Buffer.alloc(8);
	value.writeBigUInt64BE(BigInt(counter));
	const hash = createHmac("sha1", key).update(value).digest();
	const offset = hash.at(-1)! & 0x0f;
	const binary = (hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
	return binary.toString().padStart(6, "0");
}

function decodeBase32(value: string): Buffer {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = "";
	for (const character of value.toUpperCase().replaceAll("=", "")) {
		const index = alphabet.indexOf(character);
		if (index < 0) throw new CoreError("configuration.invalid", "Invalid configuration.");
		bits += index.toString(2).padStart(5, "0");
	}
	const bytes: number[] = [];
	for (let index = 0; index + 8 <= bits.length; index += 8) {
		bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
	}
	return Buffer.from(bytes);
}

export const securityDigest = digest;
