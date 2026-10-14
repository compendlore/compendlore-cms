import assert from "node:assert/strict";
import test from "node:test";
import {
	ConnectorEngine,
	connectorConnectionKey,
	DefaultCoreSecurityBoundary,
	FrontendNetworkPolicy,
	InMemoryConnectorTokenStore,
	PostgresConnectorTokenStore,
	SecureConnectorNetwork,
} from "../backend/build/core/src/index.js";

const outboundSecurity = {
	connectorIdentifier: "official.library",
	ownerIdentifier: "addon.library",
	audience: "internal",
	correlationId: "connector-network-test",
	capabilities: new Set(["network.outbound"]),
};

class TestCipher {
	seal(value) {
		return Buffer.from(value).toString("base64url");
	}
	open(value) {
		return Buffer.from(value, "base64url").toString("utf8");
	}
}

class TestSecrets {
	constructor(values) {
		this.values = values;
	}
	async resolve(reference) {
		if (!(reference in this.values)) throw new Error("Secret absent");
		return this.values[reference];
	}
}

class TestNetwork {
	requests = [];
	tokenCalls = 0;
	apiCalls = 0;
	unauthorizedOnce = false;
	omitRefreshToken = false;

	async execute(request) {
		this.requests.push(request);
		if (request.url.pathname === "/oauth/device") {
			return jsonResponse(200, {
				device_code: "device-code",
				user_code: "ABCD-EFGH",
				verification_uri: "https://auth.example.com/activate",
				expires_in: 600,
				interval: 5,
			});
		}
		if (request.url.pathname === "/oauth/token") {
			this.tokenCalls += 1;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return jsonResponse(200, {
				access_token: `access-${this.tokenCalls}`,
				...(this.omitRefreshToken ? {} : { refresh_token: "refresh-token" }),
				expires_in: "3600",
			});
		}
		this.apiCalls += 1;
		if (this.unauthorizedOnce) {
			this.unauthorizedOnce = false;
			return jsonResponse(401, { error: "expired" });
		}
		return jsonResponse(200, { id: 42, name: "Caerthia" });
	}
}

class TestConnectorTokenDatabase {
	rows = new Map();

	async query(statement) {
		if (statement.text.includes("INSERT INTO")) {
			this.rows.set(statement.values[0], statement.values[1]);
			return { rows: [], rowCount: 1 };
		}
		if (statement.text.includes("DELETE FROM")) {
			const deleted = this.rows.delete(statement.values[0]);
			return { rows: [], rowCount: deleted ? 1 : 0 };
		}
		const sealed = this.rows.get(statement.values[0]);
		return {
			rows: sealed ? [{ sealed_token: sealed }] : [],
			rowCount: sealed ? 1 : 0,
		};
	}
}

function jsonResponse(status, value) {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: Buffer.from(JSON.stringify(value)),
	};
}

function connector(overrides = {}) {
	return {
		identifier: "official.library",
		baseUrl: "https://api.example.com/",
		allowedDomains: ["api.example.com", "auth.example.com"],
		authentication: {
			kind: "oauth2",
			flow: "client-credentials",
			clientIdSecretReference: "env:CLIENT_ID",
			clientSecretReference: "env:CLIENT_SECRET",
			tokenEndpoint: "https://auth.example.com/oauth/token",
			scopes: ["catalog.read"],
		},
		endpoints: [
			{
				identifier: "catalog.read",
				path: "/catalog/:id",
				method: "GET",
				parameters: [
					{ name: "id", location: "path", required: true },
					{ name: "locale", location: "query" },
				],
				successStatuses: [200],
				response: { format: "json", requiredJsonPaths: ["id", "name"] },
				cacheTtlSeconds: 60,
				retries: 1,
			},
		],
		connectionTestEndpoint: "catalog.read",
		quota: { limit: 20, windowSeconds: 60 },
		...overrides,
	};
}

test("chaîne OAuth, mutualise la connexion et masque les secrets", async () => {
	const network = new TestNetwork();
	const engine = new ConnectorEngine(
		new TestSecrets({ "env:CLIENT_ID": "client-id", "env:CLIENT_SECRET": "client-secret" }),
		new InMemoryConnectorTokenStore(new TestCipher()),
		network,
	);
	const input = {
		connector: connector(),
		endpointIdentifier: "catalog.read",
		scope: { kind: "instance" },
		parameters: { id: 42, locale: "fr" },
	};
	const [first, second] = await Promise.all([engine.execute(input), engine.execute(input)]);
	assert.equal(network.tokenCalls, 1);
	assert.equal(first.data.name, "Caerthia");
	assert.equal(second.data.name, "Caerthia");
	assert.equal(network.requests.at(-1).headers.authorization, "Bearer access-1");
	assert.doesNotMatch(JSON.stringify(input.connector), /client-secret/);
	assert.equal((await engine.execute(input)).fromCache, true);
});

test("normalise le test de connexion déclaré par le connecteur", async () => {
	const definition = connector({
		endpoints: [
			{
				identifier: "connection.health",
				path: "/health",
				method: "GET",
				successStatuses: [200],
				response: { format: "json", requiredJsonPaths: ["id"] },
			},
		],
		connectionTestEndpoint: "connection.health",
	});
	const now = new Date("2026-10-14T12:00:00.000Z");
	const connected = await new ConnectorEngine(
		new TestSecrets({ "env:CLIENT_ID": "client-id", "env:CLIENT_SECRET": "client-secret" }),
		new InMemoryConnectorTokenStore(new TestCipher()),
		new TestNetwork(),
		() => now,
	).testConnection(definition, { kind: "instance" });
	assert.deepEqual(connected, { connected: true, checkedAt: now, status: 200 });

	const unavailable = await new ConnectorEngine(
		new TestSecrets({ "env:CLIENT_ID": "client-id", "env:CLIENT_SECRET": "client-secret" }),
		new InMemoryConnectorTokenStore(new TestCipher()),
		{
			async execute() {
				throw new Error("External service unavailable.");
			},
		},
		() => now,
	).testConnection(definition, { kind: "instance" });
	assert.deepEqual(unavailable, { connected: false, checkedAt: now });
});

test("applique les authentifications none, API Key, Basic et Bearer", async () => {
	const cases = [
		{
			authentication: { kind: "none" },
			secrets: {},
			assertHeaders(headers) {
				assert.equal(headers.authorization, undefined);
			},
		},
		{
			authentication: {
				kind: "api-key",
				secretReference: "env:API_KEY",
				header: "X-API-Key",
			},
			secrets: { "env:API_KEY": "api-secret" },
			assertHeaders(headers) {
				assert.equal(headers["x-api-key"], "api-secret");
			},
		},
		{
			authentication: {
				kind: "basic",
				usernameSecretReference: "env:BASIC_USER",
				passwordSecretReference: "env:BASIC_PASSWORD",
			},
			secrets: { "env:BASIC_USER": "user", "env:BASIC_PASSWORD": "basic-secret" },
			assertHeaders(headers) {
				assert.equal(
					headers.authorization,
					`Basic ${Buffer.from("user:basic-secret").toString("base64")}`,
				);
			},
		},
		{
			authentication: { kind: "bearer", secretReference: "env:BEARER_TOKEN" },
			secrets: { "env:BEARER_TOKEN": "bearer-secret" },
			assertHeaders(headers) {
				assert.equal(headers.authorization, "Bearer bearer-secret");
			},
		},
	];

	for (const entry of cases) {
		const network = new TestNetwork();
		const definition = connector({ authentication: entry.authentication, cacheTtlSeconds: 0 });
		const engine = new ConnectorEngine(
			new TestSecrets(entry.secrets),
			new InMemoryConnectorTokenStore(new TestCipher()),
			network,
		);
		await engine.execute({
			connector: definition,
			endpointIdentifier: "catalog.read",
			scope: { kind: "instance" },
			parameters: { id: 42 },
		});
		entry.assertHeaders(network.requests.at(-1).headers);
		assert.doesNotMatch(JSON.stringify(definition), /api-secret|basic-secret|bearer-secret/);
	}
});

test("exécute les parcours OAuth PKCE et Device Code", async () => {
	const network = new TestNetwork();
	const tokens = new InMemoryConnectorTokenStore(new TestCipher());
	const secrets = new TestSecrets({ "env:CLIENT_ID": "client-id" });
	const pkce = connector({
		authentication: {
			kind: "oauth2",
			flow: "authorization-code-pkce",
			clientIdSecretReference: "env:CLIENT_ID",
			tokenEndpoint: "https://auth.example.com/oauth/token",
			authorizationEndpoint: "https://auth.example.com/oauth/authorize",
			scopes: ["catalog.read"],
		},
	});
	const engine = new ConnectorEngine(secrets, tokens, network);
	const scope = { kind: "user", userId: "user-pkce" };
	const pending = await engine.beginPkceAuthorization(
		pkce,
		scope,
		"https://cms.example.com/oauth/callback",
	);
	const authorizationUrl = new URL(pending.authorizationUrl);
	assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
	assert.equal(authorizationUrl.searchParams.get("state"), pending.state);
	assert.equal(authorizationUrl.searchParams.get("scope"), "catalog.read");
	await engine.completePkceAuthorization({
		connector: pkce,
		scope,
		state: pending.state,
		code: "authorization-code",
		redirectUri: "https://cms.example.com/oauth/callback",
	});
	const pkceTokenRequest = network.requests.find(
		(request) => request.url.pathname === "/oauth/token",
	);
	assert.match(pkceTokenRequest.body, /grant_type=authorization_code/);
	assert.match(pkceTokenRequest.body, /code_verifier=/);

	const device = connector({
		authentication: {
			kind: "oauth2",
			flow: "device-code",
			clientIdSecretReference: "env:CLIENT_ID",
			tokenEndpoint: "https://auth.example.com/oauth/token",
			deviceAuthorizationEndpoint: "https://auth.example.com/oauth/device",
		},
	});
	const authorization = await engine.beginDeviceAuthorization(device);
	assert.deepEqual(authorization, {
		deviceCode: "device-code",
		userCode: "ABCD-EFGH",
		verificationUri: "https://auth.example.com/activate",
		expiresInSeconds: 600,
		intervalSeconds: 5,
	});
	await engine.authorizeDeviceCode({
		connector: device,
		scope: { kind: "user", userId: "user-device" },
		deviceCode: authorization.deviceCode,
	});
	assert.match(network.requests.at(-1).body, /device_code=device-code/);
});

test("normalise les réponses OAuth invalides sans exposer leur contenu", async () => {
	const engine = new ConnectorEngine(
		new TestSecrets({ "env:CLIENT_ID": "client-id", "env:CLIENT_SECRET": "client-secret" }),
		new InMemoryConnectorTokenStore(new TestCipher()),
		{
			async execute() {
				return { status: 200, headers: {}, body: Buffer.from("not-json secret-token") };
			},
		},
	);
	await assert.rejects(
		engine.execute({
			connector: connector(),
			endpointIdentifier: "catalog.read",
			scope: { kind: "instance" },
			parameters: { id: 42 },
		}),
		(error) =>
			error.code === "infrastructure.unavailable" && !error.message.includes("secret-token"),
	);
});

test("renouvelle le jeton et reprend la requête initiale après un refus", async () => {
	const network = new TestNetwork();
	const engine = new ConnectorEngine(
		new TestSecrets({ "env:CLIENT_ID": "client-id", "env:CLIENT_SECRET": "client-secret" }),
		new InMemoryConnectorTokenStore(new TestCipher()),
		network,
	);
	await engine.execute({
		connector: connector({
			cacheTtlSeconds: 0,
			endpoints: [{ ...connector().endpoints[0], cacheTtlSeconds: 0 }],
		}),
		endpointIdentifier: "catalog.read",
		scope: { kind: "user", userId: "user-1" },
		parameters: { id: 42 },
	});
	network.unauthorizedOnce = true;
	await engine.execute({
		connector: connector({
			cacheTtlSeconds: 0,
			endpoints: [{ ...connector().endpoints[0], cacheTtlSeconds: 0 }],
		}),
		endpointIdentifier: "catalog.read",
		scope: { kind: "user", userId: "user-1" },
		parameters: { id: 43 },
	});
	assert.equal(network.tokenCalls, 2);
	assert.equal(network.apiCalls, 3);
});

test("conserve le jeton de renouvellement d’un flux utilisateur après un refus", async () => {
	const network = new TestNetwork();
	const tokenStore = new InMemoryConnectorTokenStore(new TestCipher());
	const scope = { kind: "user", userId: "user-2" };
	const definition = connector({
		authentication: {
			kind: "oauth2",
			flow: "authorization-code-pkce",
			clientIdSecretReference: "env:CLIENT_ID",
			tokenEndpoint: "https://auth.example.com/oauth/token",
			authorizationEndpoint: "https://auth.example.com/oauth/authorize",
		},
		cacheTtlSeconds: 0,
		endpoints: [{ ...connector().endpoints[0], cacheTtlSeconds: 0 }],
	});
	await tokenStore.set(connectorConnectionKey(definition.identifier, scope), {
		accessToken: "rejected-access-token",
		refreshToken: "preserved-refresh-token",
		expiresAt: new Date(Date.now() + 60_000),
	});
	const engine = new ConnectorEngine(
		new TestSecrets({ "env:CLIENT_ID": "client-id" }),
		tokenStore,
		network,
	);
	network.unauthorizedOnce = true;
	await engine.execute({
		connector: definition,
		endpointIdentifier: "catalog.read",
		scope,
		parameters: { id: 44 },
	});
	assert.equal(network.tokenCalls, 1);
	assert.match(
		network.requests.find((request) => request.url.pathname === "/oauth/token").body,
		/grant_type=refresh_token/,
	);
	assert.match(
		network.requests.find((request) => request.url.pathname === "/oauth/token").body,
		/refresh_token=preserved-refresh-token/,
	);
});

test("conserve durablement les jetons chiffrés sans stocker la portée en clair", async () => {
	const database = new TestConnectorTokenDatabase();
	const store = new PostgresConnectorTokenStore(database, new TestCipher());
	const key = "official.library:user:sensitive-user-id";
	const token = {
		accessToken: "access-secret",
		refreshToken: "refresh-secret",
		expiresAt: new Date("2026-10-14T14:00:00.000Z"),
	};
	await store.set(key, token);
	const [storedKey, sealed] = [...database.rows.entries()][0];
	assert.match(storedKey, /^[0-9a-f]{64}$/);
	assert.doesNotMatch(storedKey, /sensitive-user-id/);
	assert.doesNotMatch(sealed, /access-secret|refresh-secret|sensitive-user-id/);
	assert.deepEqual(await store.get(key), token);
	await store.delete(key);
	assert.equal(await store.get(key), undefined);
});

test("préserve le refresh token absent de la réponse de renouvellement", async () => {
	const network = new TestNetwork();
	network.omitRefreshToken = true;
	const tokenStore = new InMemoryConnectorTokenStore(new TestCipher());
	const scope = { kind: "user", userId: "user-refresh" };
	const definition = connector({
		authentication: {
			kind: "oauth2",
			flow: "authorization-code-pkce",
			clientIdSecretReference: "env:CLIENT_ID",
			tokenEndpoint: "https://auth.example.com/oauth/token",
			authorizationEndpoint: "https://auth.example.com/oauth/authorize",
		},
		cacheTtlSeconds: 0,
		endpoints: [{ ...connector().endpoints[0], cacheTtlSeconds: 0 }],
	});
	await tokenStore.set(connectorConnectionKey(definition.identifier, scope), {
		accessToken: "expired-access-token",
		refreshToken: "stable-refresh-token",
		expiresAt: new Date(0),
	});
	const engine = new ConnectorEngine(
		new TestSecrets({ "env:CLIENT_ID": "client-id" }),
		tokenStore,
		network,
	);
	await engine.execute({
		connector: definition,
		endpointIdentifier: "catalog.read",
		scope,
		parameters: { id: 45 },
	});
	assert.match(network.requests[0].body, /grant_type=refresh_token/);
	assert.match(network.requests[0].body, /refresh_token=stable-refresh-token/);
	assert.equal(
		(await tokenStore.get(connectorConnectionKey(definition.identifier, scope))).refreshToken,
		"stable-refresh-token",
	);
});

test("isole les connexions d’instance, utilisateur, groupe et addon", async () => {
	const network = new TestNetwork();
	const tokenStore = new InMemoryConnectorTokenStore(new TestCipher());
	const engine = new ConnectorEngine(
		new TestSecrets({ "env:CLIENT_ID": "client-id", "env:CLIENT_SECRET": "client-secret" }),
		tokenStore,
		network,
	);
	const definition = connector({
		quota: { limit: 1, windowSeconds: 60 },
	});
	const scopes = [
		{ kind: "instance" },
		{ kind: "user", userId: "user-1" },
		{ kind: "group", groupIdentifier: "editors" },
		{ kind: "addon", addonIdentifier: "official.maps" },
	];

	for (const scope of scopes) {
		await engine.execute({
			connector: definition,
			endpointIdentifier: "catalog.read",
			scope,
			parameters: { id: 42 },
		});
	}
	assert.equal(network.tokenCalls, scopes.length);
	assert.equal(
		new Set(scopes.map((scope) => connectorConnectionKey(definition.identifier, scope))).size,
		4,
	);
	for (const scope of scopes) {
		assert.ok(await tokenStore.get(connectorConnectionKey(definition.identifier, scope)));
	}
});

test("refuse les portées inconnues ou ambiguës avant tout appel réseau", async () => {
	const network = new TestNetwork();
	const engine = new ConnectorEngine(
		new TestSecrets({ "env:CLIENT_ID": "client-id", "env:CLIENT_SECRET": "client-secret" }),
		new InMemoryConnectorTokenStore(new TestCipher()),
		network,
	);
	const invalidScopes = [
		null,
		{},
		{ kind: "tenant", tenantId: "tenant-1" },
		{ kind: "instance", userId: "user-1" },
		{ kind: "user", userId: "" },
		{ kind: "user", userId: "user-1", groupIdentifier: "editors" },
		{ kind: "group", groupIdentifier: "group:admin" },
		{ kind: "addon", addonIdentifier: "../official.maps" },
	];
	for (const scope of invalidScopes) {
		await assert.rejects(
			engine.execute({
				connector: connector(),
				endpointIdentifier: "catalog.read",
				scope,
				parameters: { id: 42 },
			}),
			{ code: "configuration.invalid" },
		);
	}
	assert.equal(network.requests.length, 0);
});

test("bloque les destinations privées, les redirections locales et les réponses trop grandes", async () => {
	let fetchCalls = 0;
	const network = new SecureConnectorNetwork(
		async () => {
			fetchCalls += 1;
			return new Response("ok");
		},
		async () => ["127.0.0.1"],
	);
	await assert.rejects(
		() =>
			network.execute({
				url: new URL("https://api.example.com/data"),
				method: "GET",
				headers: {},
				timeoutMs: 1_000,
				maximumResponseBytes: 100,
				allowedDomains: new Set(["api.example.com"]),
				security: outboundSecurity,
			}),
		{ code: "network.denied" },
	);
	assert.equal(fetchCalls, 0);

	for (const address of [
		"not-an-ip-address",
		"100.64.0.1",
		"192.0.2.1",
		"198.51.100.1",
		"203.0.113.1",
		"::ffff:127.0.0.1",
		"2001:db8::1",
		"ff02::1",
	]) {
		const reserved = new SecureConnectorNetwork(
			async () => {
				fetchCalls += 1;
				return new Response("ok");
			},
			async () => [address],
		);
		await assert.rejects(
			() =>
				reserved.execute({
					url: new URL("https://api.example.com/data"),
					method: "GET",
					headers: {},
					timeoutMs: 1_000,
					maximumResponseBytes: 100,
					allowedDomains: new Set(["api.example.com"]),
					security: outboundSecurity,
				}),
			{ code: "network.denied" },
		);
	}
	assert.equal(fetchCalls, 0);

	const oversized = new SecureConnectorNetwork(
		async () => new Response("x".repeat(20), { headers: { "content-length": "20" } }),
		async () => ["93.184.216.34"],
	);
	await assert.rejects(
		() =>
			oversized.execute({
				url: new URL("https://api.example.com/data"),
				method: "GET",
				headers: {},
				timeoutMs: 1_000,
				maximumResponseBytes: 10,
				allowedDomains: new Set(["api.example.com"]),
				security: outboundSecurity,
			}),
		{ code: "network.denied" },
	);
});

test("contrôle les redirections sans transmettre les secrets à une autre origine", async () => {
	const requests = [];
	const network = new SecureConnectorNetwork(
		async (url, init) => {
			requests.push({ url: url.toString(), authorization: init?.headers.authorization });
			return new Response(null, {
				status: 302,
				headers: { location: "https://auth.example.com/collect" },
			});
		},
		async () => ["93.184.216.34"],
	);
	await assert.rejects(
		() =>
			network.execute({
				url: new URL("https://api.example.com/data"),
				method: "GET",
				headers: { authorization: "Bearer connector-secret" },
				timeoutMs: 1_000,
				maximumResponseBytes: 100,
				allowedDomains: new Set(["api.example.com", "auth.example.com"]),
				security: outboundSecurity,
			}),
		{ code: "network.denied" },
	);
	assert.deepEqual(requests, [
		{ url: "https://api.example.com/data", authorization: "Bearer connector-secret" },
	]);
});

test("borne les flux sans longueur déclarée et masque les erreurs du transport", async () => {
	const oversized = new SecureConnectorNetwork(
		async () => new Response("x".repeat(20)),
		async () => ["93.184.216.34"],
	);
	await assert.rejects(
		() =>
			oversized.execute({
				url: new URL("https://api.example.com/data"),
				method: "GET",
				headers: {},
				timeoutMs: 1_000,
				maximumResponseBytes: 10,
				allowedDomains: new Set(["api.example.com"]),
				security: outboundSecurity,
			}),
		{ code: "network.denied" },
	);

	const secret = "connector-secret-that-must-not-leak";
	const unavailable = new SecureConnectorNetwork(
		async () => {
			throw new Error(`request failed for ?token=${secret}`);
		},
		async () => ["93.184.216.34"],
	);
	await assert.rejects(
		() =>
			unavailable.execute({
				url: new URL(`https://api.example.com/data?token=${secret}`),
				method: "GET",
				headers: { authorization: `Bearer ${secret}` },
				timeoutMs: 1_000,
				maximumResponseBytes: 100,
				allowedDomains: new Set(["api.example.com"]),
				security: outboundSecurity,
			}),
		(error) => {
			assert.equal(error.code, "infrastructure.unavailable");
			assert.equal(JSON.stringify(error).includes(secret), false);
			assert.equal(String(error.stack).includes(secret), false);
			return true;
		},
	);
});

test("lie le flux sortant au connecteur, au propriétaire et à l’audience", async () => {
	const baseBoundary = new DefaultCoreSecurityBoundary();
	const securedInputs = [];
	const validatedDestinations = [];
	const boundary = {
		async secureInput(input) {
			securedInputs.push(input);
			return baseBoundary.secureInput(input);
		},
		secureOutput(input) {
			return baseBoundary.secureOutput(input);
		},
		assertEvidence(evidence, expected) {
			baseBoundary.assertEvidence(evidence, expected);
		},
	};
	const network = new SecureConnectorNetwork(
		async (_url, _init, addresses) => {
			validatedDestinations.push([...addresses]);
			return new Response("ok");
		},
		async () => ["93.184.216.34"],
		boundary,
	);
	await network.execute({
		url: new URL("https://api.example.com/data?token=private-query"),
		method: "POST",
		headers: { authorization: "Bearer private-header" },
		body: "private-body",
		timeoutMs: 1_000,
		maximumResponseBytes: 100,
		allowedDomains: new Set(["api.example.com"]),
		security: { ...outboundSecurity, audience: "administration" },
	});
	assert.equal(securedInputs.length, 1);
	assert.equal(securedInputs[0].value.connectorIdentifier, "official.library");
	assert.equal(securedInputs[0].value.ownerIdentifier, "addon.library");
	assert.equal(securedInputs[0].value.audience, "administration");
	assert.equal(JSON.stringify(securedInputs[0].value).includes("private-"), false);
	assert.deepEqual(validatedDestinations, [["93.184.216.34"]]);
});

test("refuse l’altération et le rejeu d’une décision de flux sortant", async () => {
	const baseBoundary = new DefaultCoreSecurityBoundary();
	const headers = { authorization: "Bearer initial-token" };
	let replayedDecision;
	let transportCalls = 0;
	const tamperingBoundary = {
		async secureInput(input) {
			const decision = await baseBoundary.secureInput(input);
			headers.authorization = "Bearer altered-token";
			return decision;
		},
		secureOutput(input) {
			return baseBoundary.secureOutput(input);
		},
		assertEvidence(evidence, expected) {
			baseBoundary.assertEvidence(evidence, expected);
		},
	};
	const tampered = new SecureConnectorNetwork(
		async () => {
			transportCalls += 1;
			return new Response("ok");
		},
		async () => ["93.184.216.34"],
		tamperingBoundary,
	);
	await assert.rejects(
		() =>
			tampered.execute({
				url: new URL("https://api.example.com/data"),
				method: "GET",
				headers,
				timeoutMs: 1_000,
				maximumResponseBytes: 100,
				allowedDomains: new Set(["api.example.com"]),
				security: outboundSecurity,
			}),
		{ code: "network.denied" },
	);
	assert.equal(transportCalls, 0);

	const replayBoundary = {
		async secureInput(input) {
			if (!replayedDecision) replayedDecision = await baseBoundary.secureInput(input);
			return replayedDecision;
		},
		secureOutput(input) {
			return baseBoundary.secureOutput(input);
		},
		assertEvidence(evidence, expected) {
			baseBoundary.assertEvidence(evidence, expected);
		},
	};
	const replayed = new SecureConnectorNetwork(
		async () => {
			transportCalls += 1;
			return new Response("ok");
		},
		async () => ["93.184.216.34"],
		replayBoundary,
	);
	const request = {
		url: new URL("https://api.example.com/data"),
		method: "GET",
		headers: {},
		timeoutMs: 1_000,
		maximumResponseBytes: 100,
		allowedDomains: new Set(["api.example.com"]),
		security: outboundSecurity,
	};
	await replayed.execute(request);
	await assert.rejects(() => replayed.execute(request), { code: "network.denied" });
	assert.equal(transportCalls, 1);
});

test("refuse un flux sortant privé de capacité réseau", async () => {
	let transportCalls = 0;
	const network = new SecureConnectorNetwork(
		async () => {
			transportCalls += 1;
			return new Response("ok");
		},
		async () => ["93.184.216.34"],
	);
	await assert.rejects(
		() =>
			network.execute({
				url: new URL("https://api.example.com/data"),
				method: "GET",
				headers: {},
				timeoutMs: 1_000,
				maximumResponseBytes: 100,
				allowedDomains: new Set(["api.example.com"]),
				security: { ...outboundSecurity, capabilities: new Set() },
			}),
		{ code: "network.denied" },
	);
	assert.equal(transportCalls, 0);
});

test("ouvre puis referme le coupe-circuit d’un connecteur défaillant", async () => {
	let calls = 0;
	let failing = true;
	let now = new Date("2026-10-14T12:00:00.000Z");
	const engine = new ConnectorEngine(
		new TestSecrets({ "env:CLIENT_ID": "client-id", "env:CLIENT_SECRET": "client-secret" }),
		new InMemoryConnectorTokenStore(new TestCipher()),
		{
			async execute(request) {
				calls += 1;
				if (request.url.pathname === "/oauth/token") {
					return jsonResponse(200, { access_token: "access-token", expires_in: 3600 });
				}
				return jsonResponse(failing ? 503 : 200, { id: 42, name: "Recovered" });
			},
		},
		() => now,
	);
	const input = {
		connector: connector({ retries: 0 }),
		endpointIdentifier: "catalog.read",
		scope: { kind: "instance" },
		parameters: { id: 42 },
	};
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await assert.rejects(() => engine.execute(input), { code: "infrastructure.unavailable" });
	}
	const callsBeforeOpenCircuit = calls;
	await assert.rejects(() => engine.execute(input), { code: "infrastructure.unavailable" });
	assert.equal(calls, callsBeforeOpenCircuit);

	failing = false;
	now = new Date(now.getTime() + 30_001);
	const recovered = await engine.execute(input);
	assert.equal(recovered.status, 200);
});

test("applique capacité, consentement, retrait et CSP au réseau frontend", () => {
	const policy = new FrontendNetworkPolicy();
	assert.throws(
		() => policy.assertAllowed("addon.maps", new URL("https://tiles.example.com/map"), "GET"),
		{ code: "network.denied" },
	);
	assert.throws(
		() =>
			policy.register({
				definition: {
					ownerIdentifier: "addon.maps",
					domains: ["tiles.example.com"],
					methods: ["GET"],
					requiresConsent: true,
				},
				capabilityGranted: true,
				consentGranted: false,
			}),
		{ code: "authorization.denied" },
	);
	policy.register({
		definition: {
			ownerIdentifier: "addon.maps",
			domains: ["tiles.example.com"],
			methods: ["GET"],
			requiresConsent: true,
		},
		capabilityGranted: true,
		consentGranted: true,
	});
	policy.assertAllowed("addon.maps", new URL("https://tiles.example.com/map"), "GET");
	assert.equal(policy.contentSecurityPolicy(), "'self' https://tiles.example.com");
	assert.deepEqual(policy.publicCatalog(), [
		{
			ownerIdentifier: "addon.maps",
			domains: ["tiles.example.com"],
			methods: ["GET"],
			requiresConsent: true,
		},
	]);
	assert.throws(
		() => policy.assertAllowed("addon.maps", new URL("https://evil.example.net/map"), "GET"),
		{ code: "network.denied" },
	);
	policy.withdraw("addon.maps");
	assert.equal(policy.contentSecurityPolicy(), "'self'");
	assert.throws(
		() => policy.assertAllowed("addon.maps", new URL("https://tiles.example.com/map"), "GET"),
		{ code: "network.denied" },
	);
});

test("canonise les autorisations frontend et refuse toute donnée serveur", () => {
	const policy = new FrontendNetworkPolicy();
	const definition = {
		ownerIdentifier: "addon.maps",
		domains: ["tiles.example.com"],
		methods: ["GET"],
		requiresConsent: false,
	};
	policy.register({ definition, capabilityGranted: true, consentGranted: false });
	definition.domains[0] = "evil.example.net";
	definition.methods[0] = "POST";
	policy.assertAllowed("addon.maps", new URL("https://tiles.example.com/map"), "GET");
	assert.deepEqual(policy.publicCatalog()[0].domains, ["tiles.example.com"]);

	for (const invalidDefinition of [
		{ ...definition, secretReference: "env:SERVER_SECRET" },
		{ ...definition, domains: ["tiles.example.com", "tiles.example.com"] },
		{ ...definition, methods: ["GET", "GET"] },
		{ ...definition, methods: ["TRACE"] },
		{ ...definition, requiresConsent: "yes" },
	]) {
		assert.throws(
			() =>
				policy.register({
					definition: invalidDefinition,
					capabilityGranted: true,
					consentGranted: true,
				}),
			{ code: "configuration.invalid" },
		);
	}
});
