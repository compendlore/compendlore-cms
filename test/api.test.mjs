import assert from "node:assert/strict";
import test from "node:test";
import {
	ApiGateway,
	InMemoryApiAudit,
	InMemoryApiAuthenticator,
	InMemoryApiExposurePolicy,
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

async function createApi() {
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
				requiredCapability: "editorial.slug.generate",
				transaction: "required",
				timeoutMs: 1_000,
				idempotent: true,
			},
		},
		{
			validateInput: (value) => Boolean(value && typeof value === "object" && "title" in value),
			validateOutput: (value) => Boolean(value && typeof value === "object" && "slug" in value),
			async execute(_context, input) {
				if (input.title === "reserved") {
					throw new RegistryError("editorial.title_reserved", "Internal business detail");
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
			},
		},
		{ requester: owner },
	);
	await registry.activate("api-endpoint.editorial.slug", { requester: owner });
	const authentication = new InMemoryApiAuthenticator();
	authentication.registerSession("session-token", {
		id: actorId,
		kind: "user",
		capabilities: new Set(["editorial.slug.generate"]),
	});
	const exposure = new InMemoryApiExposurePolicy();
	const audit = new InMemoryApiAudit();
	return {
		registry,
		authentication,
		exposure,
		audit,
		gateway: new ApiGateway(registry, authentication, exposure, audit),
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
