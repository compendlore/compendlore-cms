import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
	ApiAudience,
	ApiEndpointContractDefinition,
	ApiHttpMethod,
	ApiValueSchema,
	RegistryCatalog,
} from "../../cms-registry/src/index.js";
import type { RegisteredMethodInvoker } from "../../core/src/index.js";

const DETAILED_ERRORS_CAPABILITY = "core.errors.details";
const MAXIMUM_BODY_BYTES = 1_048_576;

export interface ApiIdentity {
	readonly id: string;
	readonly kind: "api-key" | "oauth-client" | "system" | "user";
	readonly capabilities: ReadonlySet<string>;
}

export interface ApiCredentials {
	readonly apiKey?: string;
	readonly oauthToken?: string;
	readonly sessionToken?: string;
}

export interface ApiInvocationRequest {
	readonly audience: ApiAudience;
	readonly method: ApiHttpMethod;
	readonly route: string;
	readonly contractVersion: string;
	readonly body: unknown;
	readonly credentials?: ApiCredentials;
	readonly idempotencyKey?: string;
	readonly locale?: string;
	readonly correlationId?: string;
}

export interface ApiInvocationResponse {
	readonly status: number;
	readonly correlationId: string;
	readonly body: unknown;
}

export interface ApiAuthenticationPort {
	authenticate(
		credentials: ApiCredentials | undefined,
		audience: ApiAudience,
	): Promise<ApiIdentity | undefined>;
}

export interface ApiExposurePolicy {
	isPublicApiEnabled(): Promise<boolean>;
	isEndpointAllowed(endpointKey: string): Promise<boolean>;
}

export interface ApiAuditRecord {
	readonly correlationId: string;
	readonly endpointKey?: string;
	readonly actorId?: string;
	readonly audience: ApiAudience;
	readonly outcome: "allowed" | "denied" | "failed";
	readonly occurredAt: Date;
}

export interface ApiAuditPort {
	record(record: ApiAuditRecord): Promise<void>;
}

export interface ApiTechnicalLogRecord {
	readonly correlationId: string;
	readonly endpointKey?: string;
	readonly errorCode?: string;
	readonly errorType: string;
	readonly occurredAt: Date;
}

export interface ApiTechnicalLogPort {
	record(record: ApiTechnicalLogRecord): Promise<void>;
}

export class InMemoryApiAudit implements ApiAuditPort {
	readonly records: ApiAuditRecord[] = [];

	async record(record: ApiAuditRecord): Promise<void> {
		this.records.push(record);
	}
}

export class InMemoryApiTechnicalLog implements ApiTechnicalLogPort {
	readonly records: ApiTechnicalLogRecord[] = [];

	async record(record: ApiTechnicalLogRecord): Promise<void> {
		this.records.push(record);
	}
}

export class InMemoryApiExposurePolicy implements ApiExposurePolicy {
	private readonly restrictions = new Map<string, boolean>();

	constructor(private publicEnabled = false) {}

	setPublicEnabled(enabled: boolean): void {
		this.publicEnabled = enabled;
	}

	setEndpointAllowed(endpointKey: string, allowed: boolean): void {
		this.restrictions.set(endpointKey, allowed);
	}

	async isPublicApiEnabled(): Promise<boolean> {
		return this.publicEnabled;
	}

	async isEndpointAllowed(endpointKey: string): Promise<boolean> {
		return this.restrictions.get(endpointKey) ?? true;
	}
}

interface StoredCredential {
	readonly identity: ApiIdentity;
	readonly digest: Buffer;
	readonly expiresAt?: Date;
	revokedAt?: Date;
}

export class InMemoryApiAuthenticator implements ApiAuthenticationPort {
	private readonly apiKeys: StoredCredential[] = [];
	private readonly oauthTokens: StoredCredential[] = [];
	private readonly sessions = new Map<string, ApiIdentity>();

	issueApiKey(identity: ApiIdentity, expiresAt?: Date): string {
		return this.issue(this.apiKeys, identity, expiresAt, "ldk");
	}

	issueOAuthToken(identity: ApiIdentity, expiresAt?: Date): string {
		return this.issue(this.oauthTokens, identity, expiresAt, "ldo");
	}

	registerSession(token: string, identity: ApiIdentity): void {
		this.sessions.set(digestText(token).toString("hex"), identity);
	}

	revoke(token: string): void {
		const digest = digestText(token);
		const credential = [...this.apiKeys, ...this.oauthTokens].find((candidate) =>
			safeEqual(candidate.digest, digest),
		);
		if (credential) credential.revokedAt = new Date();
		this.sessions.delete(digest.toString("hex"));
	}

	async authenticate(
		credentials: ApiCredentials | undefined,
		audience: ApiAudience,
	): Promise<ApiIdentity | undefined> {
		if (audience === "internal") {
			return { id: "core", kind: "system", capabilities: new Set(["*"]) };
		}
		if (!credentials) return undefined;
		if (credentials.sessionToken) {
			return this.sessions.get(digestText(credentials.sessionToken).toString("hex"));
		}
		if (credentials.apiKey) return this.find(this.apiKeys, credentials.apiKey);
		if (credentials.oauthToken) return this.find(this.oauthTokens, credentials.oauthToken);
		return undefined;
	}

	private issue(
		storage: StoredCredential[],
		identity: ApiIdentity,
		expiresAt: Date | undefined,
		prefix: string,
	): string {
		const token = `${prefix}_${randomBytes(32).toString("base64url")}`;
		storage.push({ identity, digest: digestText(token), ...(expiresAt ? { expiresAt } : {}) });
		return token;
	}

	private find(storage: readonly StoredCredential[], token: string): ApiIdentity | undefined {
		const digest = digestText(token);
		const credential = storage.find((candidate) => safeEqual(candidate.digest, digest));
		if (
			!credential ||
			credential.revokedAt ||
			(credential.expiresAt && credential.expiresAt <= new Date())
		) {
			return undefined;
		}
		return credential.identity;
	}
}

export class SlidingWindowRateLimiter {
	private readonly attempts = new Map<string, number[]>();

	consume(key: string, limit: number, windowSeconds: number, now = Date.now()): boolean {
		const threshold = now - windowSeconds * 1_000;
		const active = (this.attempts.get(key) ?? []).filter((attempt) => attempt > threshold);
		if (active.length >= limit) {
			this.attempts.set(key, active);
			return false;
		}
		active.push(now);
		this.attempts.set(key, active);
		return true;
	}
}

export class ApiGateway {
	constructor(
		private readonly registry: Pick<RegisteredMethodInvoker, "invokeRegisteredMethod"> & {
			catalog(): Promise<RegistryCatalog>;
		},
		private readonly authentication: ApiAuthenticationPort,
		private readonly exposure: ApiExposurePolicy,
		private readonly audit: ApiAuditPort,
		private readonly rateLimiter = new SlidingWindowRateLimiter(),
		private readonly technicalLog?: ApiTechnicalLogPort,
	) {}

	async invoke(request: ApiInvocationRequest): Promise<ApiInvocationResponse> {
		const correlationId = validateCorrelationId(request.correlationId ?? randomUUID());
		let endpointKey: string | undefined;
		let resolvedEndpoint: ResolvedEndpoint | undefined;
		let identity: ApiIdentity | undefined;
		try {
			validateBody(request.body);
			const endpoint = await this.resolveEndpoint(request);
			resolvedEndpoint = endpoint;
			endpointKey = endpoint.key;
			identity = await this.authentication.authenticate(request.credentials, request.audience);
			await this.authorize(endpoint, identity, request.audience);
			if (!matchesSchema(endpoint.contract.input, request.body)) {
				throw new ApiGatewayError("api.input_invalid", 400, "La requête est invalide.");
			}
			const quota = endpoint.contract.quota;
			if (
				quota &&
				!this.rateLimiter.consume(
					`${endpoint.key}:${identity?.id ?? "anonymous"}`,
					quota.limit,
					quota.windowSeconds,
				)
			) {
				throw new ApiGatewayError("api.quota_exceeded", 429, "Le quota est dépassé.");
			}
			const output = await this.registry.invokeRegisteredMethod({
				methodIdentifier: endpoint.contract.businessMethodIdentifier,
				input: request.body,
				...(identity?.kind === "user" ? { actorId: identity.id } : {}),
				...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
			});
			if (!matchesSchema(endpoint.contract.output, output)) {
				throw new ApiGatewayError("api.output_invalid", 500, "La réponse métier est invalide.");
			}
			await this.audit.record({
				correlationId,
				endpointKey,
				...(identity ? { actorId: identity.id } : {}),
				audience: request.audience,
				outcome: "allowed",
				occurredAt: new Date(),
			});
			return { status: 200, correlationId, body: output };
		} catch (error) {
			const errorCode = readErrorCode(error);
			const response = publicError(
				error,
				correlationId,
				identity,
				request.locale,
				resolvedEndpoint?.contract,
			);
			await this.audit.record({
				correlationId,
				...(endpointKey ? { endpointKey } : {}),
				...(identity ? { actorId: identity.id } : {}),
				audience: request.audience,
				outcome: response.status >= 500 ? "failed" : "denied",
				occurredAt: new Date(),
			});
			await this.technicalLog?.record({
				correlationId,
				...(endpointKey ? { endpointKey } : {}),
				...(errorCode ? { errorCode } : {}),
				errorType: error instanceof Error ? error.name : "UnknownError",
				occurredAt: new Date(),
			});
			return response;
		}
	}

	private async resolveEndpoint(request: ApiInvocationRequest): Promise<ResolvedEndpoint> {
		const candidates = (await this.registry.catalog()).byType["api-endpoint"];
		for (const contribution of candidates) {
			const contract = contribution.endpoint;
			if (
				contribution.state === "active" &&
				contract &&
				contract.audience === request.audience &&
				contract.method === request.method &&
				contract.contractVersion === request.contractVersion &&
				matchRoute(contract.route, request.route)
			) {
				return { key: contribution.key, contract };
			}
		}
		throw new ApiGatewayError("api.not_found", 404, "La ressource demandée est introuvable.");
	}

	private async authorize(
		endpoint: ResolvedEndpoint,
		identity: ApiIdentity | undefined,
		audience: ApiAudience,
	): Promise<void> {
		if (!(await this.exposure.isEndpointAllowed(endpoint.key))) {
			throw new ApiGatewayError("api.not_found", 404, "La ressource demandée est introuvable.");
		}
		if (audience === "public" && !(await this.exposure.isPublicApiEnabled())) {
			throw new ApiGatewayError("api.not_found", 404, "La ressource demandée est introuvable.");
		}
		if (audience === "site" && !identity) {
			throw new ApiGatewayError(
				"api.authentication_required",
				401,
				"Une authentification est requise.",
			);
		}
		if (
			endpoint.contract.requiredCapability &&
			!identity?.capabilities.has("*") &&
			!identity?.capabilities.has(endpoint.contract.requiredCapability)
		) {
			throw new ApiGatewayError(
				"api.authorization_denied",
				403,
				"Cette action n’est pas autorisée.",
			);
		}
	}
}

interface ResolvedEndpoint {
	readonly key: string;
	readonly contract: ApiEndpointContractDefinition;
}

export class ApiGatewayError extends Error {
	constructor(
		readonly code: string,
		readonly httpStatus: number,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ApiGatewayError";
	}
}

function publicError(
	error: unknown,
	correlationId: string,
	identity: ApiIdentity | undefined,
	locale: string | undefined,
	contract: ApiEndpointContractDefinition | undefined,
): ApiInvocationResponse {
	const detailed = identity?.capabilities.has(DETAILED_ERRORS_CAPABILITY) ?? false;
	const errorCode = readErrorCode(error);
	const declared = contract?.publicErrors?.find((candidate) => candidate.code === errorCode);
	if (declared) {
		return {
			status: declared.httpStatus,
			correlationId,
			body: {
				error: declared.code,
				message: localizedMessage(declared.message, locale),
				correlationId,
			},
		};
	}
	if (error instanceof ApiGatewayError) {
		return {
			status: error.httpStatus,
			correlationId,
			body: {
				error: error.code,
				message:
					error.httpStatus >= 500 && !detailed ? "Une erreur interne est survenue." : error.message,
				correlationId,
			},
		};
	}
	return {
		status: 500,
		correlationId,
		body: {
			error: "api.internal",
			message:
				detailed && error instanceof Error ? error.message : "Une erreur interne est survenue.",
			correlationId,
		},
	};
}

function readErrorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function localizedMessage(
	messages: Readonly<Record<string, string>>,
	locale: string | undefined,
): string {
	if (locale) {
		const normalized = locale.split(",", 1)[0]!.trim();
		if (messages[normalized]) return messages[normalized];
		const language = normalized.split("-", 1)[0]!;
		const match = Object.entries(messages).find(
			([candidate]) => candidate.split("-", 1)[0] === language,
		);
		if (match) return match[1];
	}
	return messages.en ?? Object.values(messages)[0] ?? "La requête a échoué.";
}

function matchesSchema(schema: ApiValueSchema, value: unknown): boolean {
	if (schema.type === "null") return value === null;
	if (schema.type === "boolean") return typeof value === "boolean";
	if (schema.type === "number") return typeof value === "number" && Number.isFinite(value);
	if (schema.type === "string") {
		return (
			typeof value === "string" &&
			(schema.maximumLength === undefined || value.length <= schema.maximumLength)
		);
	}
	if (schema.type === "array") {
		return (
			Array.isArray(value) &&
			(schema.maximumItems === undefined || value.length <= schema.maximumItems) &&
			value.every((item) => matchesSchema(schema.items, item))
		);
	}
	if (schema.type !== "object") return false;
	if (value === null || Array.isArray(value) || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if ((schema.required ?? []).some((key) => !Object.hasOwn(candidate, key))) return false;
	if (
		schema.additionalProperties === false &&
		Object.keys(candidate).some((key) => !Object.hasOwn(schema.properties, key))
	)
		return false;
	return Object.entries(schema.properties).every(
		([key, child]) => !Object.hasOwn(candidate, key) || matchesSchema(child, candidate[key]),
	);
}

function matchRoute(pattern: string, route: string): boolean {
	const expected = pattern.split("/");
	const actual = route.split("/");
	return (
		expected.length === actual.length &&
		expected.every((segment, index) => segment.startsWith(":") || segment === actual[index])
	);
}

function validateBody(body: unknown): void {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(body);
	} catch (error) {
		throw new ApiGatewayError("api.input_invalid", 400, "La requête n’est pas sérialisable.", {
			cause: error,
		});
	}
	if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAXIMUM_BODY_BYTES) {
		throw new ApiGatewayError("api.input_invalid", 400, "La requête dépasse la taille autorisée.");
	}
}

function validateCorrelationId(value: string): string {
	if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) return randomUUID();
	return value;
}

function digestText(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

function safeEqual(first: Buffer, second: Buffer): boolean {
	return first.length === second.length && timingSafeEqual(first, second);
}
