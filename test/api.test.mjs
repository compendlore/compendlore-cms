import assert from "node:assert/strict";
import test from "node:test";
import {
	ApiGateway,
	InMemoryApiAudit,
	InMemoryApiAuthenticator,
	InMemoryApiExposurePolicy,
	InMemoryApiTechnicalLog,
	RealtimeHub,
} from "../backend/build/api/src/index.js";
import {
	createInMemoryCmsRegistry,
	RegistryError,
} from "../backend/build/cms-registry/src/index.js";
import { CoreRegistryPort, InMemoryCoreStore } from "../backend/build/core/src/index.js";

const owner = { kind: "native-module", identifier: "native.editorial" };
const inputSchema = {
	type: "object",
	properties: { title: { type: "string", maximumLength: 80 } },
	required: ["title"],
	additionalProperties: false,
};
const outputSchema = {
	type: "object",
	properties: { slug: { type: "string" } },
	required: ["slug"],
	additionalProperties: false,
};

async function createApi({
	audience = "site",
	endpointRequiresCapability = true,
	methodRequiresCapability = true,
	security,
	output = outputSchema,
	execute,
	sessionIdentity,
	securityBoundary,
	quota = { limit: 2, windowSeconds: 60 },
} = {}) {
	const store = new InMemoryCoreStore();
	const registry = createInMemoryCmsRegistry(new CoreRegistryPort(store));
	const actorId = "00000000-0000-4000-8000-000000000061";
	await store.createUser({
		id: actorId,
		login: "api-user",
		displayName: "API User",
		passwordDigest: "unused",
		founder: false,
		active: true,
		createdAt: new Date("2026-10-11T00:00:00.000Z"),
	});
	await store.grantCapability(actorId, "editorial.slug.generate");
	await registry.registerMethod(
		{
			type: "method",
			identifier: "editorial.generate-slug",
			owner,
			version: "1.0.0",
			withdrawalPolicy: "archive",
			method: {
				...(methodRequiresCapability ? { requiredCapability: "editorial.slug.generate" } : {}),
				transaction: "required",
				timeoutMs: 1_000,
				idempotent: true,
			},
		},
		{
			validateInput: (value) => Boolean(value && typeof value === "object" && "title" in value),
			validateOutput: (value) => Boolean(value && typeof value === "object" && "slug" in value),
			async execute(_context, input) {
				if (execute) return execute(input);
				if (input.title === "reserved") {
					throw new RegistryError("editorial.title_reserved", "Internal business detail");
				}
				if (input.title === "explode") {
					throw new Error("Sensitive infrastructure detail");
				}
				return { slug: input.title.toLowerCase().replaceAll(" ", "-") };
			},
		},
		{ requester: owner },
	);
	await registry.activate("method.editorial.generate-slug", { requester: owner });
	await registry.register(
		{
			type: "api-endpoint",
			identifier: "editorial.slug",
			owner,
			version: "1.0.0",
			withdrawalPolicy: "archive",
			dependencies: [{ contributionKey: "method.editorial.generate-slug" }],
			endpoint: {
				audience,
				method: "POST",
				route: "/editorial/slug",
				contractVersion: "1.0.0",
				businessMethodIdentifier: "editorial.generate-slug",
				...(endpointRequiresCapability ? { requiredCapability: "editorial.slug.generate" } : {}),
				input: inputSchema,
				output,
				quota,
				...(security ? { security } : {}),
				publicErrors: [
					{
						code: "editorial.title_reserved",
						httpStatus: 409,
						message: { en: "This title is reserved.", "fr-FR": "Ce titre est réservé." },
					},
				],
			},
		},
		{ requester: owner },
	);
	await registry.activate("api-endpoint.editorial.slug", { requester: owner });
	const authentication = new InMemoryApiAuthenticator();
	authentication.registerSession(
		"session-token",
		sessionIdentity ?? {
			id: actorId,
			kind: "user",
			capabilities: new Set(["editorial.slug.generate"]),
		},
	);
	const exposure = new InMemoryApiExposurePolicy();
	const audit = new InMemoryApiAudit();
	const technicalLog = new InMemoryApiTechnicalLog();
	return {
		registry,
		authentication,
		exposure,
		audit,
		technicalLog,
		gateway: new ApiGateway(
			registry,
			authentication,
			exposure,
			audit,
			undefined,
			technicalLog,
			securityBoundary,
		),
	};
}

test("le frontend invoque une méthode enregistrée sans connaître son module", async () => {
	const { gateway, audit } = await createApi();
	const response = await gateway.invoke({
		audience: "site",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		body: { title: "Mon Univers" },
		credentials: { sessionToken: "session-token" },
		idempotencyKey: "page-42",
	});
	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { slug: "mon-univers" });
	assert.equal(audit.records.at(-1).outcome, "allowed");
});

test("centralise validation, autorisation, quota et erreurs publiques", async () => {
	const { gateway } = await createApi();
	const unauthenticated = await gateway.invoke({
		audience: "site",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		body: { title: "test" },
	});
	assert.equal(unauthenticated.status, 401);
	assert.equal(unauthenticated.body.messageKey, "api.authentication_required");

	const invalid = await gateway.invoke({
		audience: "site",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		body: { title: "ok", unknown: true },
		credentials: { sessionToken: "session-token" },
	});
	assert.equal(invalid.status, 400);
	assert.equal(invalid.body.messageKey, "api.input_invalid");

	const declared = await gateway.invoke({
		audience: "site",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		body: { title: "reserved" },
		credentials: { sessionToken: "session-token" },
		locale: "fr-FR",
	});
	assert.equal(declared.status, 409);
	assert.equal(declared.body.messageKey, "editorial.title_reserved");
	assert.equal(declared.body.message, "Ce titre est réservé.");

	await gateway.invoke({
		audience: "site",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		body: { title: "first" },
		credentials: { sessionToken: "session-token" },
	});
	const limited = await gateway.invoke({
		audience: "site",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		body: { title: "second" },
		credentials: { sessionToken: "session-token" },
	});
	assert.equal(limited.status, 429);
});

test("masque les erreurs internes et corrèle réponse, audit et journal technique", async () => {
	const { gateway, authentication, audit, technicalLog } = await createApi();
	const correlationId = "request_error_0001";
	const hidden = await gateway.invoke({
		audience: "site",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		body: { title: "explode" },
		credentials: { sessionToken: "session-token" },
		correlationId,
	});
	assert.equal(hidden.status, 500);
	assert.equal(hidden.correlationId, correlationId);
	assert.deepEqual(hidden.body, {
		error: "api.internal",
		messageKey: "api.internal",
		message: "An internal error occurred.",
		correlationId,
	});
	assert.equal(audit.records.at(-1).correlationId, correlationId);
	assert.equal(audit.records.at(-1).outcome, "failed");
	assert.deepEqual(
		{
			correlationId: technicalLog.records.at(-1).correlationId,
			endpointKey: technicalLog.records.at(-1).endpointKey,
			errorCode: technicalLog.records.at(-1).errorCode,
			errorType: technicalLog.records.at(-1).errorType,
		},
		{
			correlationId,
			endpointKey: "api-endpoint.editorial.slug",
			errorCode: "registry.method_failed",
			errorType: "RegistryError",
		},
	);

	authentication.registerSession("diagnostic-session", {
		id: "00000000-0000-4000-8000-000000000061",
		kind: "user",
		capabilities: new Set(["editorial.slug.generate", "core.errors.details"]),
	});
	const detailed = await gateway.invoke({
		audience: "site",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		body: { title: "explode" },
		credentials: { sessionToken: "diagnostic-session" },
		correlationId: "request_error_0002",
	});
	assert.equal(detailed.status, 500);
	assert.equal(detailed.body.message, "The registered method failed.");

	const replacedCorrelation = await gateway.invoke({
		audience: "site",
		method: "POST",
		route: "/missing",
		contractVersion: "1.0.0",
		body: {},
		correlationId: "invalid correlation id",
	});
	assert.match(replacedCorrelation.correlationId, /^[0-9a-f-]{36}$/);
});

test("fait traverser les entrées et sorties par le Security Kernel", async () => {
	const received = [];
	const { gateway } = await createApi({
		security: {
			policyVersion: "1.0.0",
			allowedOrigins: ["https://cms.example"],
			csrfRequired: true,
			replayProtection: true,
			maximumDepth: 4,
			maximumStringLength: 80,
			output: { omittedFields: ["internal"], maskedFields: ["secret"] },
		},
		output: {
			type: "object",
			properties: {
				slug: { type: "string" },
				secret: { type: "string" },
				internal: { type: "string" },
			},
			required: ["slug", "secret", "internal"],
			additionalProperties: false,
		},
		execute(input) {
			received.push(input);
			return { slug: "secured", secret: "top-secret", internal: "private" };
		},
		quota: { limit: 20, windowSeconds: 60 },
	});
	const body = { title: "Protected page" };
	const response = await gateway.invoke({
		audience: "site",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		body,
		credentials: { sessionToken: "session-token" },
		idempotencyKey: "secured-request-1",
		origin: "https://cms.example",
		csrfToken: "csrf-token-value",
		csrfCookie: "csrf-token-value",
	});
	assert.equal(response.status, 200);
	assert.equal(response.body.slug, "secured");
	assert.notEqual(response.body.secret, "top-secret");
	assert.equal(response.body.secret.startsWith("to"), true);
	assert.equal(Object.hasOwn(response.body, "internal"), false);
	assert.deepEqual(received, [body]);
	assert.notEqual(received[0], body);
});

test("refuse les politiques de sécurité API invalides avant persistance", async () => {
	const { registry } = await createApi();
	const baseEndpoint = {
		audience: "site",
		method: "POST",
		route: "/editorial/security-policy",
		contractVersion: "1.0.0",
		businessMethodIdentifier: "editorial.generate-slug",
		input: inputSchema,
		output: outputSchema,
	};
	for (const [identifier, security] of [
		["editorial.invalid-policy-version", { policyVersion: "latest" }],
		[
			"editorial.invalid-policy-origin",
			{ policyVersion: "1.0.0", allowedOrigins: ["http://cms.example"] },
		],
		["editorial.invalid-policy-depth", { policyVersion: "1.0.0", maximumDepth: 64 }],
		[
			"editorial.invalid-policy-output",
			{ policyVersion: "1.0.0", output: { omittedFields: ["private.path"] } },
		],
	]) {
		await assert.rejects(
			registry.register(
				{
					type: "api-endpoint",
					identifier,
					owner,
					version: "1.0.0",
					withdrawalPolicy: "archive",
					dependencies: [{ contributionKey: "method.editorial.generate-slug" }],
					endpoint: { ...baseEndpoint, security },
				},
				{ requester: owner },
			),
			(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
		);
	}
});

test("refuse origine, CSRF, élévation expirée et rejeu avant la logique métier", async () => {
	let executions = 0;
	const api = await createApi({
		security: {
			policyVersion: "1.0.0",
			allowedOrigins: ["https://cms.example"],
			csrfRequired: true,
			replayProtection: true,
			multiFactorMaximumAgeSeconds: 60,
		},
		sessionIdentity: {
			id: "00000000-0000-4000-8000-000000000061",
			kind: "user",
			capabilities: new Set(["editorial.slug.generate"]),
			multiFactorVerifiedAt: new Date(Date.now() - 120_000),
		},
		execute(input) {
			executions += 1;
			return { slug: input.title };
		},
		quota: { limit: 20, windowSeconds: 60 },
	});
	const request = {
		audience: "site",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		body: { title: "secured" },
		credentials: { sessionToken: "session-token" },
		idempotencyKey: "secured-request-2",
		origin: "https://cms.example",
		csrfToken: "csrf-token-value",
		csrfCookie: "csrf-token-value",
	};
	const invalidOrigin = await api.gateway.invoke({ ...request, origin: "https://evil.example" });
	assert.equal(invalidOrigin.status, 403);
	assert.equal(invalidOrigin.body.messageKey, "api.origin_denied");
	const invalidCsrf = await api.gateway.invoke({ ...request, csrfToken: "wrong-token" });
	assert.equal(invalidCsrf.status, 403);
	assert.equal(invalidCsrf.body.messageKey, "api.csrf_invalid");
	const expiredElevation = await api.gateway.invoke(request);
	assert.equal(expiredElevation.status, 403);
	assert.equal(expiredElevation.body.messageKey, "api.step_up_required");
	assert.equal(executions, 0);

	api.authentication.registerSession("session-token", {
		id: "00000000-0000-4000-8000-000000000061",
		kind: "user",
		capabilities: new Set(["editorial.slug.generate"]),
		multiFactorVerifiedAt: new Date(),
	});
	const first = await api.gateway.invoke(request);
	assert.equal(first.status, 200);
	const replay = await api.gateway.invoke({ ...request, body: { title: "altered" } });
	assert.equal(replay.status, 409);
	assert.equal(replay.body.messageKey, "api.replay_detected");
	assert.equal(executions, 1);
});

test("échoue fermé sur décision expirée, concurrence et panne partielle", async () => {
	let executions = 0;
	const failingBoundary = {
		async secureInput({ operation, value }) {
			const issuedAt = new Date();
			return {
				status: "allowed",
				secured: {
					value,
					evidence: {
						id: "expired-evidence",
						operation,
						policyIdentifier: "api-endpoint.editorial.slug",
						policyVersion: "1.0.0",
						issuedAt,
						expiresAt: issuedAt,
					},
				},
			};
		},
		assertEvidence() {
			throw new Error("Security evidence expired.");
		},
		async secureOutput() {
			throw new Error("Output security must not run.");
		},
	};
	const failedApi = await createApi({
		security: { policyVersion: "1.0.0" },
		securityBoundary: failingBoundary,
		execute(input) {
			executions += 1;
			return { slug: input.title };
		},
		quota: { limit: 20, windowSeconds: 60 },
	});
	const failed = await failedApi.gateway.invoke({
		audience: "site",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		body: { title: "blocked" },
		credentials: { sessionToken: "session-token" },
	});
	assert.equal(failed.status, 500);
	assert.equal(failed.body.messageKey, "api.internal");
	assert.equal(executions, 0);

	const concurrentApi = await createApi({
		security: { policyVersion: "1.0.0", replayProtection: true },
		execute(input) {
			return { slug: input.title };
		},
		quota: { limit: 20, windowSeconds: 60 },
	});
	const base = {
		audience: "site",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		credentials: { sessionToken: "session-token" },
		idempotencyKey: "concurrent-request",
	};
	const responses = await Promise.all([
		concurrentApi.gateway.invoke({ ...base, body: { title: "first" } }),
		concurrentApi.gateway.invoke({ ...base, body: { title: "second" } }),
	]);
	assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
});

test("sépare les audiences et bloque les endpoints non exposés", async () => {
	const internalApi = await createApi({
		audience: "internal",
		endpointRequiresCapability: false,
		methodRequiresCapability: false,
	});
	const internalResponse = await internalApi.gateway.invoke({
		audience: "internal",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		body: { title: "Internal title" },
	});
	assert.equal(internalResponse.status, 200);
	assert.equal(internalApi.audit.records.at(-1).actorId, "core");

	const hiddenInternal = await internalApi.gateway.invoke({
		audience: "public",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		body: { title: "Hidden internal title" },
	});
	assert.equal(hiddenInternal.status, 404);

	const publicApi = await createApi({ audience: "public", methodRequiresCapability: false });
	const apiKey = publicApi.authentication.issueApiKey({
		id: "public-client",
		kind: "api-key",
		capabilities: new Set(["editorial.slug.generate"]),
	});
	const request = {
		audience: "public",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		body: { title: "Public title" },
		credentials: { apiKey },
	};
	assert.equal((await publicApi.gateway.invoke(request)).status, 404);

	publicApi.exposure.setPublicEnabled(true);
	assert.equal((await publicApi.gateway.invoke(request)).status, 200);

	publicApi.exposure.setEndpointAllowed("api-endpoint.editorial.slug", false);
	assert.equal((await publicApi.gateway.invoke(request)).status, 404);
	assert.deepEqual(
		publicApi.audit.records.map((record) => record.outcome),
		["denied", "allowed", "denied"],
	);
});

test("refuse les audiences et méthodes HTTP inconnues à l’enregistrement", async () => {
	const { registry } = await createApi();
	const baseEndpoint = {
		audience: "site",
		method: "POST",
		route: "/editorial/invalid",
		contractVersion: "1.0.0",
		businessMethodIdentifier: "editorial.generate-slug",
		input: inputSchema,
		output: outputSchema,
	};
	for (const [identifier, endpoint] of [
		["editorial.invalid-audience", { ...baseEndpoint, audience: "partner" }],
		["editorial.invalid-method", { ...baseEndpoint, method: "TRACE" }],
	]) {
		await assert.rejects(
			registry.register(
				{
					type: "api-endpoint",
					identifier,
					owner,
					version: "1.0.0",
					withdrawalPolicy: "archive",
					dependencies: [{ contributionKey: "method.editorial.generate-slug" }],
					endpoint,
				},
				{ requester: owner },
			),
			(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
		);
	}
});

test("enregistre un endpoint déclaratif complet et verrouille son contrat versionné", async () => {
	const { registry, gateway } = await createApi();
	const endpoint = (await registry.get("api-endpoint.editorial.slug")).endpoint;
	assert.deepEqual(endpoint, {
		audience: "site",
		method: "POST",
		route: "/editorial/slug",
		contractVersion: "1.0.0",
		businessMethodIdentifier: "editorial.generate-slug",
		requiredCapability: "editorial.slug.generate",
		input: inputSchema,
		output: outputSchema,
		quota: { limit: 2, windowSeconds: 60 },
		publicErrors: [
			{
				code: "editorial.title_reserved",
				httpStatus: 409,
				message: { en: "This title is reserved.", "fr-FR": "Ce titre est réservé." },
			},
		],
	});

	for (const request of [
		{
			audience: "site",
			method: "GET",
			route: "/editorial/slug",
			contractVersion: "1.0.0",
		},
		{
			audience: "site",
			method: "POST",
			route: "/editorial/slug",
			contractVersion: "2.0.0",
		},
	]) {
		const response = await gateway.invoke({
			...request,
			body: { title: "Versioned title" },
			credentials: { sessionToken: "session-token" },
		});
		assert.equal(response.status, 404);
		assert.equal(response.body.messageKey, "api.not_found");
	}

	await assert.rejects(
		registry.register(
			{
				type: "api-endpoint",
				identifier: "editorial.missing-method-dependency",
				owner,
				version: "1.0.0",
				withdrawalPolicy: "archive",
				endpoint: {
					audience: "site",
					method: "POST",
					route: "/editorial/missing-method-dependency",
					contractVersion: "1.0.0",
					businessMethodIdentifier: "editorial.generate-slug",
					input: inputSchema,
					output: outputSchema,
				},
			},
			{ requester: owner },
		),
		(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
	);
});

test("désactive l’API publique par défaut et révoque les identifiants", async () => {
	const authentication = new InMemoryApiAuthenticator();
	const identity = { id: "client-1", kind: "api-key", capabilities: new Set() };
	const apiKey = authentication.issueApiKey(identity);
	assert.equal((await authentication.authenticate({ apiKey }, "public")).id, "client-1");
	authentication.revoke(apiKey);
	assert.equal(await authentication.authenticate({ apiKey }, "public"), undefined);
	const policy = new InMemoryApiExposurePolicy();
	assert.equal(await policy.isPublicApiEnabled(), false);
	policy.setPublicEnabled(true);
	assert.equal(await policy.isPublicApiEnabled(), true);
});

test("sécurise clés API et OAuth publics avec expiration, révocation, quota et audit", async () => {
	const publicApi = await createApi({ audience: "public", methodRequiresCapability: false });
	publicApi.exposure.setPublicEnabled(true);
	const credentials = {
		apiKey: publicApi.authentication.issueApiKey({
			id: "public-api-client",
			kind: "api-key",
			capabilities: new Set(["editorial.slug.generate"]),
		}),
		oauthToken: publicApi.authentication.issueOAuthToken({
			id: "public-oauth-client",
			kind: "oauth-client",
			capabilities: new Set(["editorial.slug.generate"]),
		}),
	};
	const invoke = (selectedCredentials, title) =>
		publicApi.gateway.invoke({
			audience: "public",
			method: "POST",
			route: "/editorial/slug",
			contractVersion: "1.0.0",
			body: { title },
			credentials: selectedCredentials,
		});

	assert.equal((await invoke({ apiKey: credentials.apiKey }, "API key request")).status, 200);
	assert.equal((await invoke({ oauthToken: credentials.oauthToken }, "OAuth request")).status, 200);

	const missingCapability = publicApi.authentication.issueApiKey({
		id: "restricted-client",
		kind: "api-key",
		capabilities: new Set(),
	});
	assert.equal((await invoke({ apiKey: missingCapability }, "Denied request")).status, 403);

	const expired = publicApi.authentication.issueApiKey(
		{
			id: "expired-client",
			kind: "api-key",
			capabilities: new Set(["editorial.slug.generate"]),
		},
		new Date("2000-01-01T00:00:00.000Z"),
	);
	assert.equal((await invoke({ apiKey: expired }, "Expired request")).status, 401);

	publicApi.authentication.revoke(credentials.apiKey);
	assert.equal((await invoke({ apiKey: credentials.apiKey }, "Revoked request")).status, 401);

	const quotaKey = publicApi.authentication.issueApiKey({
		id: "quota-client",
		kind: "api-key",
		capabilities: new Set(["editorial.slug.generate"]),
	});
	assert.equal((await invoke({ apiKey: quotaKey }, "Quota first")).status, 200);
	assert.equal((await invoke({ apiKey: quotaKey }, "Quota second")).status, 200);
	assert.equal((await invoke({ apiKey: quotaKey }, "Quota third")).status, 429);

	assert.deepEqual(
		publicApi.audit.records.map((record) => record.outcome),
		["allowed", "allowed", "denied", "denied", "denied", "allowed", "allowed", "denied"],
	);
});

test("cible les communications, exige les accusés directs et ferme après inactivité", () => {
	let now = new Date("2026-10-11T10:00:00.000Z");
	const hub = new RealtimeHub(300_000, 50, () => now);
	const connection = hub.open({
		userId: "user-1",
		groups: new Set(["editors"]),
		roles: new Set(["founder"]),
	});
	const maintenance = hub.send({
		kind: "maintenance",
		mode: "simple",
		target: { kind: "all" },
		payload: { startsInSeconds: 10 },
		ttlMs: 60_000,
	});
	const direct = hub.send({
		kind: "notification",
		mode: "direct",
		target: { kind: "group", identifier: "editors" },
		payload: { saved: true },
		ttlMs: 60_000,
		acknowledgementTimeoutMs: 1_000,
		retryLimit: 2,
	});
	assert.deepEqual(
		hub.poll(connection).map((message) => message.id),
		[maintenance.id, direct.id],
	);
	now = new Date(now.getTime() + 1_001);
	assert.deepEqual(hub.retryDue(), [{ connectionId: connection, messageId: direct.id }]);
	assert.equal(hub.poll(connection)[0].id, direct.id);
	hub.acknowledge(connection, direct.id);
	assert.deepEqual(hub.retryDue(), []);
	now = new Date(now.getTime() + 300_001);
	assert.deepEqual(hub.disconnectInactive(), [connection]);
});

test("reprend les événements durables par curseur sans rejouer les messages simples", () => {
	const hub = new RealtimeHub();
	const catalog = hub.send({
		kind: "catalog-invalidation",
		mode: "durable",
		target: { kind: "all" },
		payload: { catalog: "navigation" },
		ttlMs: 60_000,
	});
	const firstConnection = hub.open({
		userId: "user-1",
		groups: new Set(["editors"]),
		roles: new Set(["founder"]),
	});
	assert.deepEqual(
		hub.poll(firstConnection).map((message) => message.id),
		[catalog.id],
	);

	hub.send({
		kind: "maintenance",
		mode: "simple",
		target: { kind: "all" },
		payload: { startsInSeconds: 30 },
		ttlMs: 60_000,
	});
	hub.close(firstConnection);
	const task = hub.send({
		kind: "task-progress",
		mode: "durable",
		target: { kind: "user", identifier: "user-1" },
		payload: { progress: 50 },
		ttlMs: 60_000,
	});
	const resumedConnection = hub.open(
		{
			userId: "user-1",
			groups: new Set(["editors"]),
			roles: new Set(["founder"]),
		},
		catalog.sequence,
	);
	assert.deepEqual(
		hub.poll(resumedConnection).map((message) => message.id),
		[task.id],
	);
});

test("valide strictement les messages, les cibles et la limite réelle des directs", () => {
	const hub = new RealtimeHub(300_000, 2);
	for (const userId of ["user-1", "user-2", "user-3"]) {
		hub.open({ userId, groups: new Set(["editors"]), roles: new Set() });
	}
	assert.throws(
		() =>
			hub.send({
				kind: "notification",
				mode: "direct",
				target: { kind: "group", identifier: "editors" },
				payload: { message: "Too many recipients" },
				ttlMs: 60_000,
			}),
		(error) => error.code === "realtime.direct_limit_exceeded",
	);
	assert.throws(
		() =>
			hub.send({
				kind: "unknown",
				mode: "simple",
				target: { kind: "all" },
				payload: {},
				ttlMs: 60_000,
			}),
		(error) => error.code === "realtime.message_invalid",
	);
	assert.throws(
		() =>
			hub.send({
				kind: "notification",
				mode: "simple",
				target: { kind: "users", identifiers: ["user-1", "user-1"] },
				payload: {},
				ttlMs: 60_000,
			}),
		(error) => error.code === "realtime.target_invalid",
	);
	const cyclic = {};
	cyclic.self = cyclic;
	assert.throws(
		() =>
			hub.send({
				kind: "notification",
				mode: "simple",
				target: { kind: "user", identifier: "user-1" },
				payload: cyclic,
				ttlMs: 60_000,
			}),
		(error) => error.code === "realtime.message_invalid",
	);
});
