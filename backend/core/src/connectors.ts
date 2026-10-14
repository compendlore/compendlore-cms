import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { CoreError } from "./errors.js";
import type {
	ConnectorAuthentication,
	ConnectorDefinition,
	ConnectorEndpointDefinition,
	ConnectorScope,
} from "./connector-contracts.js";
import type { SecretCipher, SecretProvider } from "./services.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 2_097_152;
const MAXIMUM_REDIRECTS = 3;

export interface ConnectorNetworkRequest {
	readonly url: URL;
	readonly method: ConnectorEndpointDefinition["method"];
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly timeoutMs: number;
	readonly maximumResponseBytes: number;
	readonly allowedDomains: ReadonlySet<string>;
}

export interface ConnectorNetworkResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Uint8Array;
}

export interface ConnectorNetworkPort {
	execute(request: ConnectorNetworkRequest): Promise<ConnectorNetworkResponse>;
}

export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

export class SecureConnectorNetwork implements ConnectorNetworkPort {
	constructor(
		private readonly fetchImplementation: typeof fetch = fetch,
		private readonly resolveDns: DnsResolver = resolveHost,
	) {}

	async execute(request: ConnectorNetworkRequest): Promise<ConnectorNetworkResponse> {
		let url = new URL(request.url);
		for (let redirects = 0; redirects <= MAXIMUM_REDIRECTS; redirects += 1) {
			await assertSafeDestination(url, request.allowedDomains, this.resolveDns);
			let response: Response;
			try {
				response = await this.fetchImplementation(url, {
					method: request.method,
					headers: request.headers,
					...(request.body === undefined ? {} : { body: request.body }),
					redirect: "manual",
					signal: AbortSignal.timeout(request.timeoutMs),
				});
			} catch (error) {
				throw new CoreError(
					"infrastructure.unavailable",
					"The required infrastructure is unavailable.",
					{
						cause: error,
						retryable: true,
					},
				);
			}
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				if (!location || redirects === MAXIMUM_REDIRECTS) {
					throw new CoreError("network.denied", "Network access denied.");
				}
				url = new URL(location, url);
				continue;
			}
			return {
				status: response.status,
				headers: Object.fromEntries(response.headers.entries()),
				body: await readLimitedBody(response, request.maximumResponseBytes),
			};
		}
		throw new CoreError("network.denied", "Network access denied.");
	}
}

export interface ConnectorToken {
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt?: Date;
}

export interface ConnectorTokenStore {
	get(key: string): Promise<ConnectorToken | undefined>;
	set(key: string, token: ConnectorToken): Promise<void>;
	delete(key: string): Promise<void>;
}

export class InMemoryConnectorTokenStore implements ConnectorTokenStore {
	private readonly tokens = new Map<string, string>();

	constructor(private readonly cipher: SecretCipher) {}

	async get(key: string): Promise<ConnectorToken | undefined> {
		const sealed = this.tokens.get(key);
		if (!sealed) return undefined;
		const parsed = JSON.parse(this.cipher.open(sealed)) as {
			accessToken: string;
			refreshToken?: string;
			expiresAt?: string;
		};
		return {
			accessToken: parsed.accessToken,
			...(parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
			...(parsed.expiresAt ? { expiresAt: new Date(parsed.expiresAt) } : {}),
		};
	}

	async set(key: string, token: ConnectorToken): Promise<void> {
		this.tokens.set(key, this.cipher.seal(JSON.stringify(token)));
	}

	async delete(key: string): Promise<void> {
		this.tokens.delete(key);
	}
}

export interface ConnectorCallInput {
	readonly connector: ConnectorDefinition;
	readonly endpointIdentifier: string;
	readonly scope: ConnectorScope;
	readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface ConnectorCallResult {
	readonly status: number;
	readonly data: unknown;
	readonly fromCache: boolean;
}

interface CacheEntry {
	readonly expiresAt: number;
	readonly result: ConnectorCallResult;
}

interface PendingAuthorization {
	readonly state: string;
	readonly verifier: string;
	readonly expiresAt: number;
}

export class ConnectorEngine {
	private readonly tokenRequests = new Map<string, Promise<ConnectorToken>>();
	private readonly cache = new Map<string, CacheEntry>();
	private readonly quota = new Map<string, number[]>();
	private readonly pendingAuthorizations = new Map<string, PendingAuthorization>();

	constructor(
		private readonly secrets: SecretProvider,
		private readonly tokens: ConnectorTokenStore,
		private readonly network: ConnectorNetworkPort,
		private readonly now: () => Date = () => new Date(),
	) {}

	async execute(input: ConnectorCallInput): Promise<ConnectorCallResult> {
		const endpoint = input.connector.endpoints.find(
			(candidate) => candidate.identifier === input.endpointIdentifier,
		);
		if (!endpoint) throw new CoreError("configuration.invalid", "Invalid configuration.");
		const connectionKey = connectorConnectionKey(input.connector.identifier, input.scope);
		this.consumeQuota(connectionKey, input.connector.quota);
		const cacheKey = stableCacheKey(connectionKey, endpoint.identifier, input.parameters ?? {});
		const cached = this.cache.get(cacheKey);
		if (cached && cached.expiresAt > this.now().getTime()) {
			return { ...cached.result, fromCache: true };
		}
		const request = await this.buildRequest(
			input.connector,
			endpoint,
			input.scope,
			input.parameters ?? {},
		);
		const attempts = 1 + (endpoint.retries ?? input.connector.retries ?? 0);
		let response: ConnectorNetworkResponse | undefined;
		let lastError: unknown;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			try {
				response = await this.network.execute(request);
				if (response.status < 500 || !isRetrySafe(endpoint)) break;
			} catch (error) {
				lastError = error;
				if (!isRetrySafe(endpoint) || attempt + 1 >= attempts) throw error;
			}
		}
		if (!response) throw lastError;
		if (response.status === 401 && input.connector.authentication.kind === "oauth2") {
			const rejectedToken = await this.tokens.get(connectionKey);
			if (rejectedToken) {
				await this.tokens.set(connectionKey, {
					...rejectedToken,
					expiresAt: new Date(0),
				});
			} else {
				await this.tokens.delete(connectionKey);
			}
			response = await this.network.execute(
				await this.buildRequest(input.connector, endpoint, input.scope, input.parameters ?? {}),
			);
		}
		if (!endpoint.successStatuses.includes(response.status)) {
			throw new CoreError(
				"infrastructure.unavailable",
				"The required infrastructure is unavailable.",
				{
					retryable: response.status >= 500,
				},
			);
		}
		const result: ConnectorCallResult = {
			status: response.status,
			data: parseResponse(endpoint, response.body),
			fromCache: false,
		};
		const cacheTtl = endpoint.cacheTtlSeconds ?? input.connector.cacheTtlSeconds ?? 0;
		if (cacheTtl > 0 && endpoint.method === "GET") {
			this.cache.set(cacheKey, {
				expiresAt: this.now().getTime() + cacheTtl * 1_000,
				result,
			});
		}
		return result;
	}

	async testConnection(
		connector: ConnectorDefinition,
		scope: ConnectorScope,
	): Promise<{
		readonly connected: boolean;
		readonly checkedAt: Date;
		readonly status?: number;
	}> {
		try {
			const result = await this.execute({
				connector,
				endpointIdentifier: connector.connectionTestEndpoint,
				scope,
			});
			return { connected: true, checkedAt: this.now(), status: result.status };
		} catch {
			return { connected: false, checkedAt: this.now() };
		}
	}

	async beginPkceAuthorization(
		connector: ConnectorDefinition,
		scope: ConnectorScope,
		redirectUri: string,
	): Promise<{ readonly authorizationUrl: string; readonly state: string }> {
		const authentication = requireOAuthFlow(connector.authentication, "authorization-code-pkce");
		if (!authentication.authorizationEndpoint) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		const verifier = randomBytes(48).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const state = randomUUID();
		const key = connectorConnectionKey(connector.identifier, scope);
		this.pendingAuthorizations.set(key, {
			state,
			verifier,
			expiresAt: this.now().getTime() + 600_000,
		});
		const url = new URL(authentication.authorizationEndpoint, connector.baseUrl);
		url.searchParams.set("response_type", "code");
		url.searchParams.set(
			"client_id",
			await this.secrets.resolve(authentication.clientIdSecretReference),
		);
		url.searchParams.set("redirect_uri", redirectUri);
		url.searchParams.set("code_challenge", challenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("state", state);
		if (authentication.scopes?.length)
			url.searchParams.set("scope", authentication.scopes.join(" "));
		return { authorizationUrl: url.toString(), state };
	}

	async beginDeviceAuthorization(connector: ConnectorDefinition): Promise<{
		readonly deviceCode: string;
		readonly userCode: string;
		readonly verificationUri: string;
		readonly expiresInSeconds?: number;
		readonly intervalSeconds?: number;
	}> {
		const authentication = requireOAuthFlow(connector.authentication, "device-code");
		if (!authentication.deviceAuthorizationEndpoint) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		const body = new URLSearchParams({
			client_id: await this.secrets.resolve(authentication.clientIdSecretReference),
		});
		if (authentication.scopes?.length) body.set("scope", authentication.scopes.join(" "));
		const response = await this.network.execute({
			url: new URL(
				authentication.deviceAuthorizationEndpoint,
				ensureTrailingSlash(connector.baseUrl),
			),
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				accept: "application/json",
			},
			body: body.toString(),
			timeoutMs: connector.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			maximumResponseBytes: 262_144,
			allowedDomains: new Set(connector.allowedDomains.map((domain) => domain.toLowerCase())),
		});
		if (response.status < 200 || response.status >= 300) {
			throw new CoreError("authentication.invalid_credentials", "Invalid credentials.");
		}
		const payload = JSON.parse(Buffer.from(response.body).toString("utf8")) as unknown;
		const deviceCode = readJsonPath(payload, "device_code");
		const userCode = readJsonPath(payload, "user_code");
		const verificationUri = readJsonPath(payload, "verification_uri");
		if (
			typeof deviceCode !== "string" ||
			typeof userCode !== "string" ||
			typeof verificationUri !== "string"
		) {
			throw new CoreError(
				"infrastructure.unavailable",
				"The required infrastructure is unavailable.",
			);
		}
		const expiresIn = readJsonPath(payload, "expires_in");
		const interval = readJsonPath(payload, "interval");
		return {
			deviceCode,
			userCode,
			verificationUri,
			...(typeof expiresIn === "number" ? { expiresInSeconds: expiresIn } : {}),
			...(typeof interval === "number" ? { intervalSeconds: interval } : {}),
		};
	}

	async completePkceAuthorization(input: {
		readonly connector: ConnectorDefinition;
		readonly scope: ConnectorScope;
		readonly state: string;
		readonly code: string;
		readonly redirectUri: string;
	}): Promise<void> {
		const authentication = requireOAuthFlow(
			input.connector.authentication,
			"authorization-code-pkce",
		);
		const key = connectorConnectionKey(input.connector.identifier, input.scope);
		const pending = this.pendingAuthorizations.get(key);
		if (!pending || pending.state !== input.state || pending.expiresAt <= this.now().getTime()) {
			throw new CoreError("authorization.denied", "Access denied.");
		}
		this.pendingAuthorizations.delete(key);
		await this.tokens.set(
			key,
			await this.exchangeOAuthToken(input.connector, authentication, {
				grant_type: "authorization_code",
				code: input.code,
				redirect_uri: input.redirectUri,
				code_verifier: pending.verifier,
			}),
		);
	}

	async authorizeDeviceCode(input: {
		readonly connector: ConnectorDefinition;
		readonly scope: ConnectorScope;
		readonly deviceCode: string;
	}): Promise<void> {
		const authentication = requireOAuthFlow(input.connector.authentication, "device-code");
		const key = connectorConnectionKey(input.connector.identifier, input.scope);
		await this.tokens.set(
			key,
			await this.exchangeOAuthToken(input.connector, authentication, {
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: input.deviceCode,
			}),
		);
	}

	private async buildRequest(
		connector: ConnectorDefinition,
		endpoint: ConnectorEndpointDefinition,
		scope: ConnectorScope,
		parameters: Readonly<Record<string, unknown>>,
	): Promise<ConnectorNetworkRequest> {
		let path = endpoint.path;
		const query = new URLSearchParams();
		const headers: Record<string, string> = { accept: "application/json" };
		const body: Record<string, unknown> = {};
		const declared = new Set(endpoint.parameters?.map((parameter) => parameter.name));
		for (const key of Object.keys(parameters)) {
			if (!declared.has(key))
				throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		for (const parameter of endpoint.parameters ?? []) {
			const value = parameters[parameter.name];
			if (value === undefined) {
				if (parameter.required)
					throw new CoreError("configuration.invalid", "Invalid configuration.");
				continue;
			}
			if (parameter.location === "path")
				path = path.replace(`:${parameter.name}`, encodeURIComponent(String(value)));
			else if (parameter.location === "query") query.set(parameter.name, String(value));
			else if (parameter.location === "header") {
				const name = parameter.name.toLowerCase();
				if (name === "authorization" || name === "cookie" || name === "host") {
					throw new CoreError("network.denied", "Network access denied.");
				}
				headers[name] = String(value);
			} else body[parameter.name] = value;
		}
		if (/:[a-z][a-z0-9]*/i.test(path))
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		await this.applyAuthentication(connector, scope, headers);
		const url = new URL(path, ensureTrailingSlash(connector.baseUrl));
		for (const [key, value] of query) url.searchParams.set(key, value);
		const serializedBody = Object.keys(body).length > 0 ? JSON.stringify(body) : undefined;
		if (serializedBody) headers["content-type"] = "application/json";
		return {
			url,
			method: endpoint.method,
			headers,
			...(serializedBody ? { body: serializedBody } : {}),
			timeoutMs: endpoint.timeoutMs ?? connector.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			maximumResponseBytes: endpoint.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES,
			allowedDomains: new Set(connector.allowedDomains.map((domain) => domain.toLowerCase())),
		};
	}

	private async applyAuthentication(
		connector: ConnectorDefinition,
		scope: ConnectorScope,
		headers: Record<string, string>,
	): Promise<void> {
		const authentication = connector.authentication;
		if (authentication.kind === "none") return;
		if (authentication.kind === "api-key") {
			headers[authentication.header.toLowerCase()] = await this.secrets.resolve(
				authentication.secretReference,
			);
			return;
		}
		if (authentication.kind === "basic") {
			const [username, password] = await Promise.all([
				this.secrets.resolve(authentication.usernameSecretReference),
				this.secrets.resolve(authentication.passwordSecretReference),
			]);
			headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
			return;
		}
		if (authentication.kind === "bearer") {
			headers.authorization = `Bearer ${await this.secrets.resolve(authentication.secretReference)}`;
			return;
		}
		const token = await this.oauthToken(connector, scope, authentication);
		headers.authorization = `Bearer ${token.accessToken}`;
	}

	private async oauthToken(
		connector: ConnectorDefinition,
		scope: ConnectorScope,
		authentication: Extract<ConnectorAuthentication, { kind: "oauth2" }>,
	): Promise<ConnectorToken> {
		const key = connectorConnectionKey(connector.identifier, scope);
		const current = await this.tokens.get(key);
		if (
			current &&
			(!current.expiresAt || current.expiresAt.getTime() > this.now().getTime() + 30_000)
		)
			return current;
		if (authentication.flow !== "client-credentials" && !current?.refreshToken) {
			throw new CoreError(
				"authentication.session_expired",
				"The session is missing, revoked, or expired.",
			);
		}
		const existing = this.tokenRequests.get(key);
		if (existing) return existing;
		const request = this.exchangeOAuthToken(
			connector,
			authentication,
			current?.refreshToken
				? { grant_type: "refresh_token", refresh_token: current.refreshToken }
				: { grant_type: "client_credentials" },
		);
		this.tokenRequests.set(key, request);
		try {
			const token = await request;
			await this.tokens.set(key, token);
			return token;
		} finally {
			this.tokenRequests.delete(key);
		}
	}

	private async exchangeOAuthToken(
		connector: ConnectorDefinition,
		authentication: Extract<ConnectorAuthentication, { kind: "oauth2" }>,
		grant: Readonly<Record<string, string>>,
	): Promise<ConnectorToken> {
		const clientId = await this.secrets.resolve(authentication.clientIdSecretReference);
		const clientSecret = authentication.clientSecretReference
			? await this.secrets.resolve(authentication.clientSecretReference)
			: undefined;
		const body = new URLSearchParams({ client_id: clientId, ...grant });
		if (clientSecret) body.set("client_secret", clientSecret);
		if (authentication.scopes?.length && grant.grant_type === "client_credentials") {
			body.set("scope", authentication.scopes.join(" "));
		}
		const response = await this.network.execute({
			url: new URL(authentication.tokenEndpoint, ensureTrailingSlash(connector.baseUrl)),
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body: body.toString(),
			timeoutMs: connector.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			maximumResponseBytes: 262_144,
			allowedDomains: new Set(connector.allowedDomains.map((domain) => domain.toLowerCase())),
		});
		if (response.status < 200 || response.status >= 300) {
			throw new CoreError("authentication.invalid_credentials", "Invalid credentials.");
		}
		const payload = JSON.parse(Buffer.from(response.body).toString("utf8")) as unknown;
		const accessToken = readJsonPath(payload, authentication.accessTokenPath ?? "access_token");
		if (typeof accessToken !== "string" || !accessToken) {
			throw new CoreError(
				"infrastructure.unavailable",
				"The required infrastructure is unavailable.",
			);
		}
		const refreshToken = readJsonPath(payload, authentication.refreshTokenPath ?? "refresh_token");
		const expiresIn = readJsonPath(payload, authentication.expiresInPath ?? "expires_in");
		return {
			accessToken,
			...(typeof refreshToken === "string" ? { refreshToken } : {}),
			...(typeof expiresIn === "number" && Number.isFinite(expiresIn)
				? { expiresAt: new Date(this.now().getTime() + expiresIn * 1_000) }
				: {}),
		};
	}

	private consumeQuota(connectionKey: string, quota: ConnectorDefinition["quota"]): void {
		if (!quota) return;
		const now = this.now().getTime();
		const threshold = now - quota.windowSeconds * 1_000;
		const active = (this.quota.get(connectionKey) ?? []).filter((attempt) => attempt > threshold);
		if (active.length >= quota.limit)
			throw new CoreError("network.denied", "Network access denied.");
		active.push(now);
		this.quota.set(connectionKey, active);
	}
}

export function connectorConnectionKey(identifier: string, scope: ConnectorScope): string {
	if (scope.kind === "instance") return `${identifier}:instance`;
	if (scope.kind === "user") return `${identifier}:user:${scope.userId}`;
	if (scope.kind === "group") return `${identifier}:group:${scope.groupIdentifier}`;
	return `${identifier}:addon:${scope.addonIdentifier}`;
}

async function assertSafeDestination(
	url: URL,
	allowedDomains: ReadonlySet<string>,
	resolver: DnsResolver,
): Promise<void> {
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		(url.port && url.port !== "443")
	) {
		throw new CoreError("network.denied", "Network access denied.");
	}
	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if (!allowedDomains.has(hostname))
		throw new CoreError("network.denied", "Network access denied.");
	const addresses = isIP(hostname) ? [hostname] : await resolver(hostname);
	if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
		throw new CoreError("network.denied", "Network access denied.");
	}
}

async function resolveHost(hostname: string): Promise<readonly string[]> {
	return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function isPrivateAddress(address: string): boolean {
	if (
		address === "::1" ||
		address === "::" ||
		address.startsWith("fe80:") ||
		address.startsWith("fc") ||
		address.startsWith("fd")
	)
		return true;
	const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
	const ipv4 = mapped ?? (isIP(address) === 4 ? address : undefined);
	if (!ipv4) return false;
	const [first, second] = ipv4.split(".").map(Number);
	return (
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 169 && second === 254) ||
		(first === 172 && second! >= 16 && second! <= 31) ||
		(first === 192 && second === 168) ||
		first! >= 224
	);
}

async function readLimitedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maximumBytes) {
		throw new CoreError("network.denied", "Network access denied.");
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maximumBytes) {
			await reader.cancel();
			throw new CoreError("network.denied", "Network access denied.");
		}
		chunks.push(value);
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function parseResponse(endpoint: ConnectorEndpointDefinition, body: Uint8Array): unknown {
	if (endpoint.response.format === "bytes") return body;
	const text = Buffer.from(body).toString("utf8");
	if (endpoint.response.format === "text") return text;
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch (error) {
		throw new CoreError(
			"infrastructure.unavailable",
			"The required infrastructure is unavailable.",
			{
				cause: error,
			},
		);
	}
	for (const path of endpoint.response.requiredJsonPaths ?? []) {
		if (readJsonPath(value, path) === undefined) {
			throw new CoreError(
				"infrastructure.unavailable",
				"The required infrastructure is unavailable.",
			);
		}
	}
	return value;
}

function readJsonPath(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((current, segment) => {
		if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment))
			return undefined;
		return (current as Record<string, unknown>)[segment];
	}, value);
}

function requireOAuthFlow(
	authentication: ConnectorAuthentication,
	flow: Extract<ConnectorAuthentication, { kind: "oauth2" }>["flow"],
): Extract<ConnectorAuthentication, { kind: "oauth2" }> {
	if (authentication.kind !== "oauth2" || authentication.flow !== flow) {
		throw new CoreError("configuration.invalid", "Invalid configuration.");
	}
	return authentication;
}

function isRetrySafe(endpoint: ConnectorEndpointDefinition): boolean {
	return endpoint.method === "GET" || endpoint.retrySafe === true;
}

function stableCacheKey(
	connectionKey: string,
	endpointIdentifier: string,
	parameters: Readonly<Record<string, unknown>>,
): string {
	const stable = JSON.stringify(
		Object.fromEntries(
			Object.entries(parameters).sort(([first], [second]) => first.localeCompare(second)),
		),
	);
	return createHash("sha256")
		.update(`${connectionKey}\0${endpointIdentifier}\0${stable}`)
		.digest("hex");
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}
