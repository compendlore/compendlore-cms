import assert from "node:assert/strict";
import test from "node:test";
import {
	ConnectorEngine,
	connectorConnectionKey,
	FrontendNetworkPolicy,
	InMemoryConnectorTokenStore,
	SecureConnectorNetwork,
} from "../backend/build/core/src/index.js";

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

	async execute(request) {
		this.requests.push(request);
		if (request.url.pathname === "/oauth/token") {
			this.tokenCalls += 1;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return jsonResponse(200, {
				access_token: `access-${this.tokenCalls}`,
				refresh_token: "refresh-token",
				expires_in: 3600,
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
			}),
		/destination locale ou privée/i,
	);
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
			}),
		/dépasse la taille autorisée/i,
	);
});

test("bloque un appel frontend non déclaré et produit une CSP contrôlée", () => {
	const policy = new FrontendNetworkPolicy();
	assert.throws(
		() => policy.assertAllowed("addon.maps", new URL("https://tiles.example.com/map"), "GET"),
		/n’est pas déclaré/i,
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
		/consentement réseau/i,
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
	assert.throws(
		() => policy.assertAllowed("addon.maps", new URL("https://evil.example.net/map"), "GET"),
		/domaine frontend n’est pas déclaré/i,
	);
});
