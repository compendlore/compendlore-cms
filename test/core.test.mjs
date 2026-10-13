import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import test from "node:test";
import { URL } from "node:url";
import {
	bootstrapCore,
	AesGcmSecretCipher,
	CommunicationService,
	CoreError,
	CoreEventStream,
	CoreRuntime,
	CoreRestorationService,
	CsrfProtection,
	ensureInstanceIdentity,
	InMemoryCoreStore,
	InMemoryObjectStorage,
	InMemoryTaskQueue,
	loadCoreConfig,
	ManagedObjectStorage,
	MemoryLogger,
	OutboundGateway,
	RateLimiter,
	securityDigest,
} from "../backend/build/core/src/index.js";
import {
	InMemoryInstancePrivateKeyStore,
	InstanceIdentityCryptography,
} from "../backend/build/security-kernel/src/index.js";

const config = loadCoreConfig({
	CORE_ENVIRONMENT: "test",
	CORE_PUBLIC_ORIGIN: "http://localhost:4000",
	CORE_PASSWORD_PEPPER_SECRET_REF: "test:pepper",
	CORE_CSRF_SECRET_REF: "test:csrf",
	CORE_DATA_ENCRYPTION_SECRET_REF: "test:encryption",
	CORE_SECURITY_DIGEST_SECRET_REF: "test:security-digest",
});

const secrets = {
	async resolve(reference) {
		return `resolved-${reference}-with-sufficient-entropy`;
	},
};

test("initialise une instance vide et protège l'administration par 2FA", async () => {
	const store = new InMemoryCoreStore();
	const logger = new MemoryLogger();
	let installationToken;
	const application = await bootstrapCore({
		config,
		store,
		secrets,
		logger,
		installationTokenPublisher: {
			async publish(token) {
				installationToken = token;
			},
			async clear() {
				installationToken = undefined;
			},
		},
	});
	assert.equal(typeof installationToken, "string");
	assert.equal(JSON.stringify(logger.entries).includes(installationToken), false);
	await assert.rejects(
		application.authentication.createFounder({
			login: "Founder",
			displayName: "Fondatrice",
			password: "correct horse battery staple",
			installationToken: "invalid-installation-token",
			correlationId: "test-invalid-installation-token",
		}),
		(error) => error instanceof CoreError && error.code === "installation.token_invalid",
	);
	const founder = await application.authentication.createFounder({
		login: "Founder",
		displayName: "Fondatrice",
		password: "correct horse battery staple",
		installationToken,
		correlationId: "test-founder",
	});
	assert.equal(installationToken, undefined);
	await store.createRole({
		id: "00000000-0000-4000-8000-000000000001",
		identifier: "test.editor",
		displayName: "Éditeur de test",
		protected: false,
	});
	await store.grantRoleCapability("00000000-0000-4000-8000-000000000001", "test.content.read");
	await store.assignRole(founder.id, "00000000-0000-4000-8000-000000000001");
	assert.equal(await store.hasCapability(founder.id, "test.content.read"), true);
	const authenticated = await application.authentication.login(
		"founder",
		"correct horse battery staple",
		"test-login",
	);
	const sessionCsrf = await application.sessionSecurity.issueCsrf(authenticated.token);
	assert.equal(
		(await application.sessionSecurity.verifyCsrf(authenticated.token, sessionCsrf)).user.id,
		founder.id,
	);
	await assert.rejects(
		application.sessionSecurity.verifyCsrf(authenticated.token, "invalid-csrf-token"),
		(error) => error instanceof CoreError && error.code === "security.csrf_invalid",
	);
	await assert.rejects(
		application.authentication.requireAdministration(authenticated.token, "test-admin-denied"),
		(error) => error instanceof CoreError && error.code === "authentication.two_factor_required",
	);
	await store.setTwoFactor(founder.id, {
		secret: "JBSWY3DPEHPK3PXP",
		recoveryCodeDigests: new Set([securityDigest("recovery-code")]),
	});
	await assert.rejects(
		application.twoFactor.verify(authenticated.session, "000000", "test-two-factor-denied"),
		(error) => error instanceof CoreError && error.code === "authentication.invalid_credentials",
	);
	await application.twoFactor.verify(
		authenticated.session,
		"recovery-code",
		"test-two-factor-allowed",
	);
	assert.equal(
		(
			await application.authentication.requireAdministration(
				authenticated.token,
				"test-admin-allowed",
			)
		).user.id,
		founder.id,
	);
	await application.authentication.revoke(authenticated.token, "test-revoke");
	await application.authentication.revoke(authenticated.token, "test-revoke-idempotent");
	await assert.rejects(application.authentication.authenticate(authenticated.token), CoreError);
	await assert.rejects(store.setUserActive(founder.id, false), CoreError);
	assert.deepEqual(
		store.auditRecords
			.filter((record) =>
				["security.administration.access", "security.two_factor.verify"].includes(record.action),
			)
			.map((record) => [record.action, record.outcome]),
		[
			["security.administration.access", "denied"],
			["security.two_factor.verify", "denied"],
			["security.two_factor.verify", "allowed"],
			["security.administration.access", "allowed"],
		],
	);
	await application.runtime.stop();
});

test("persiste les décisions du Security Kernel sans données sensibles", async () => {
	const store = new InMemoryCoreStore();
	const application = await bootstrapCore({
		config,
		store,
		secrets,
		logger: new MemoryLogger(),
		installationTokenPublisher: {
			async publish() {},
			async clear() {},
		},
	});
	const decision = await application.securityBoundary.secureInput({
		operation: "core.settings.update",
		value: { displayName: "Compendlore" },
		context: {
			correlationId: "security-boundary-test",
			surface: "administration",
			subject: {
				id: "sensitive-user-identifier",
				kind: "user",
				capabilities: new Set(["core.settings.update"]),
			},
			resource: { kind: "settings", identifier: "private-instance-settings" },
		},
		policy: {
			identifier: "core.settings.update",
			version: "1.0.0",
			allowAnonymous: false,
			requiredCapabilities: ["core.settings.update"],
		},
	});
	assert.equal(decision.status, "allowed");
	application.securityBoundary.assertEvidence(decision.secured.evidence, {
		operation: "core.settings.update",
		resource: { kind: "settings", identifier: "private-instance-settings" },
	});
	const audit = store.securityAttemptRecords.at(-1);
	assert.equal(audit.kind, "security-kernel.allowed");
	assert.equal(audit.outcome, "allowed");
	assert.notEqual(audit.subjectDigest, "sensitive-user-identifier");
	assert.equal(JSON.stringify(audit.metadata).includes("private-instance-settings"), false);
	assert.equal(audit.metadata.correlationId, "security-boundary-test");
	await application.runtime.stop();
});

test("limite les connexions, expire les sessions et audite les refus", async () => {
	let now = new Date("2026-10-13T20:00:00.000Z");
	let installationToken;
	const store = new InMemoryCoreStore();
	const application = await bootstrapCore({
		config: loadCoreConfig({
			CORE_ENVIRONMENT: "test",
			CORE_PUBLIC_ORIGIN: "http://localhost:4000",
			CORE_PASSWORD_PEPPER_SECRET_REF: "test:pepper",
			CORE_CSRF_SECRET_REF: "test:csrf",
			CORE_DATA_ENCRYPTION_SECRET_REF: "test:encryption",
			CORE_SECURITY_DIGEST_SECRET_REF: "test:security-digest",
			CORE_SESSION_TTL_MS: "1000",
			CORE_ADMIN_SESSION_TTL_MS: "500",
			CORE_LOGIN_ATTEMPT_LIMIT: "2",
			CORE_LOGIN_ATTEMPT_WINDOW_MS: "60000",
		}),
		store,
		secrets,
		logger: new MemoryLogger(),
		installationTokenPublisher: {
			async publish(token) {
				installationToken = token;
			},
			async clear() {
				installationToken = undefined;
			},
		},
		now: () => now,
	});

	await application.authentication.createFounder({
		login: "limited-founder",
		displayName: "Limited Founder",
		password: "correct horse battery staple",
		installationToken,
		correlationId: "rate-founder",
	});
	for (const correlationId of ["rate-failure-1", "rate-failure-2"]) {
		await assert.rejects(
			application.authentication.login("limited-founder", "invalid password", correlationId, {
				address: "192.0.2.10",
			}),
			(error) => error instanceof CoreError && error.code === "authentication.invalid_credentials",
		);
	}
	await assert.rejects(
		application.authentication.login(
			"limited-founder",
			"correct horse battery staple",
			"rate-blocked",
			{ address: "192.0.2.10" },
		),
		(error) => error instanceof CoreError && error.code === "security.rate_limited",
	);

	now = new Date(now.getTime() + 60_001);
	const authenticated = await application.authentication.login(
		"limited-founder",
		"correct horse battery staple",
		"rate-recovered",
		{ address: "192.0.2.10" },
	);
	now = new Date(now.getTime() + 1_001);
	await assert.rejects(
		application.authentication.authenticate(authenticated.token),
		(error) => error instanceof CoreError && error.code === "authentication.session_expired",
	);
	await application.authentication.revoke(authenticated.token, "expired-revoke");
	await application.authentication.revoke(authenticated.token, "expired-revoke-again");

	assert.equal(
		store.auditRecords.some(
			(record) => record.action === "security.login" && record.correlationId === "rate-blocked",
		),
		true,
	);
	assert.equal(
		store.securityAttemptRecords.some(
			(record) => record.kind === "login" && record.outcome === "blocked",
		),
		true,
	);
	await application.runtime.stop();
});

test("applique CSRF, limitation, chiffrement et politique réseau", async () => {
	const csrf = new CsrfProtection("csrf-secret-with-sufficient-entropy");
	const csrfToken = csrf.issue("session-1");
	assert.doesNotThrow(() => csrf.verify("session-1", csrfToken));
	assert.throws(() => csrf.verify("session-2", csrfToken), CoreError);

	const limiter = new RateLimiter(2, 60_000);
	limiter.consume("login", "client-1");
	limiter.consume("login", "client-1");
	assert.throws(() => limiter.consume("login", "client-1"), CoreError);

	const cipher = new AesGcmSecretCipher("encryption-secret-with-sufficient-entropy");
	const sealed = cipher.seal("TOTP-SECRET");
	assert.notEqual(sealed, "TOTP-SECRET");
	assert.equal(cipher.open(sealed), "TOTP-SECRET");

	const gateway = new OutboundGateway(new Set(["api.example.test"]), async () => ({
		status: 204,
	}));
	assert.equal(
		(await gateway.execute({ url: new URL("https://api.example.test/health"), method: "GET" }))
			.status,
		204,
	);
	await assert.rejects(
		gateway.execute({ url: new URL("https://untrusted.example/"), method: "GET" }),
		CoreError,
	);
});

test("annule le démarrage partiel et arrête les services dans l'ordre inverse", async () => {
	const calls = [];
	const service = (name, fail = false) => ({
		name,
		async start() {
			calls.push(`start:${name}`);
			if (fail) throw new Error("failure");
		},
		async stop() {
			calls.push(`stop:${name}`);
		},
		async health() {
			return "healthy";
		},
	});
	const runtime = new CoreRuntime(
		[service("database"), service("storage"), service("events", true)],
		new MemoryLogger(),
	);
	await assert.rejects(runtime.start());
	assert.deepEqual(calls, [
		"start:database",
		"start:storage",
		"start:events",
		"stop:storage",
		"stop:database",
	]);
});

test("conserve l’identifiant unique de l’instance entre les démarrages", async () => {
	const store = new InMemoryCoreStore();
	const first = await ensureInstanceIdentity(store);
	const second = await ensureInstanceIdentity(store);

	assert.match(first, /^[0-9a-f-]{36}$/u);
	assert.equal(second, first);
});

test("conserve l’identité Ed25519 et prouve la possession de la clé privée", async () => {
	const store = new InMemoryCoreStore();
	const privateKeys = new InMemoryInstancePrivateKeyStore();
	const identityCryptography = new InstanceIdentityCryptography(privateKeys);
	const application = await bootstrapCore({
		config,
		store,
		secrets,
		logger: new MemoryLogger(),
		installationTokenPublisher: {
			async publish() {},
			async clear() {},
		},
		instanceIdentityCryptography: identityCryptography,
		now: () => new Date("2026-10-13T12:00:00.000Z"),
	});
	const identity = application.instanceIdentity.current();
	const persisted = await store.getInstanceIdentity(application.instanceId);
	assert.equal(persisted?.identifier, identity.identifier);
	assert.equal(persisted?.algorithm, "Ed25519");
	assert.equal("privateKey" in persisted, false);

	const proof = await application.instanceIdentity.signChallenge({
		audience: "https://hub.compendlore.example",
		nonce: "unique_challenge_123456789",
		expiresAt: new Date("2026-10-13T12:01:00.000Z"),
	});
	const publicKey = createPublicKey({
		key: Buffer.from(proof.publicKey, "base64url"),
		format: "der",
		type: "spki",
	});
	assert.equal(
		verify(
			null,
			Buffer.from(proof.payload, "base64url"),
			publicKey,
			Buffer.from(proof.signature, "base64url"),
		),
		true,
	);

	const restarted = await bootstrapCore({
		config,
		store,
		secrets,
		logger: new MemoryLogger(),
		installationTokenPublisher: {
			async publish() {},
			async clear() {},
		},
		instanceIdentityCryptography: new InstanceIdentityCryptography(privateKeys),
	});
	assert.equal(restarted.instanceIdentity.current().identifier, identity.identifier);

	await assert.rejects(
		bootstrapCore({
			config,
			store,
			secrets,
			logger: new MemoryLogger(),
			installationTokenPublisher: {
				async publish() {},
				async clear() {},
			},
			instanceIdentityCryptography: new InstanceIdentityCryptography(
				new InMemoryInstancePrivateKeyStore(),
			),
		}),
		(error) => error instanceof CoreError && error.code === "lifecycle.invalid_state",
	);
});

test("borne l’arrêt d’un service qui ne répond plus", async () => {
	const logger = new MemoryLogger();
	const runtime = new CoreRuntime(
		[
			{
				name: "blocked",
				async start() {},
				async stop() {
					await new Promise(() => undefined);
				},
				async health() {
					return "healthy";
				},
			},
		],
		logger,
		5,
	);

	await runtime.start();
	await runtime.stop();

	assert.equal(runtime.state, "stopped");
	assert.equal(
		logger.entries.some(
			(entry) => entry.event === "core.service_stop_failed" && entry.context.reason === "timeout",
		),
		true,
	);
});

test("valide les services fondamentaux de stockage, tâches et communication", async () => {
	const storage = new InMemoryObjectStorage();
	await storage.put("core/audit/item.json", new Uint8Array([1, 2, 3]), "application/json");
	assert.deepEqual(await storage.get("core/audit/item.json"), new Uint8Array([1, 2, 3]));
	await assert.rejects(storage.put("../secret", new Uint8Array(), "text/plain"), CoreError);

	const objects = new Map();
	const managedStorage = new ManagedObjectStorage({
		async upload(name, data) {
			objects.set(name, Buffer.from(data));
		},
		async download(name) {
			return Buffer.from(objects.get(name));
		},
		async exists(name) {
			return objects.has(name);
		},
		async remove(name) {
			objects.delete(name);
		},
	});
	assert.equal(await managedStorage.health(), "healthy");
	await managedStorage.put("core/files/item.txt", new Uint8Array([4, 5]), "text/plain");
	assert.deepEqual(await managedStorage.get("core/files/item.txt"), new Uint8Array([4, 5]));
	await managedStorage.delete("core/files/item.txt");
	assert.equal(await managedStorage.get("core/files/item.txt"), undefined);
	const unavailableStorage = new ManagedObjectStorage({
		async upload() {
			throw new Error("unavailable");
		},
		async download() {
			throw new Error("unavailable");
		},
		async exists() {
			throw new Error("unavailable");
		},
		async remove() {
			throw new Error("unavailable");
		},
	});
	assert.equal(await unavailableStorage.health(), "unhealthy");
	await assert.rejects(unavailableStorage.start(), CoreError);

	const tasks = new InMemoryTaskQueue();
	const firstTask = await tasks.schedule({
		type: "core.test.first",
		payload: { order: 1 },
		executeAt: new Date("2026-10-13T10:00:00.000Z"),
	});
	await tasks.schedule({
		type: "core.test.second",
		payload: { order: 2 },
		executeAt: new Date("2026-10-13T11:00:00.000Z"),
	});
	assert.deepEqual(
		(await tasks.claimDue(new Date("2026-10-13T10:30:00.000Z"))).map((task) => task.id),
		[firstTask.id],
	);
	await tasks.complete(firstTask.id);
	assert.deepEqual(await tasks.claimDue(new Date("2026-10-13T10:30:00.000Z")), []);

	const delivered = [];
	const communications = new CommunicationService({
		async deliver(message) {
			delivered.push(message);
			return message.target.kind === "users" ? message.target.ids : [];
		},
	});
	await assert.rejects(
		communications.send({ mode: "direct", topic: "restart", target: { kind: "all" }, payload: {} }),
		CoreError,
	);
	const result = await communications.send({
		mode: "direct",
		topic: "saved",
		target: { kind: "users", ids: ["user-1", "user-2"] },
		payload: { status: "ok" },
		acknowledgementDeadlineMs: 2_000,
		retryLimit: 2,
	});
	assert.deepEqual(result.recipients, ["user-1", "user-2"]);
	assert.equal(delivered.length, 1);
});

test("fournit un flux d’événements durable et agnostique pour les modules", async () => {
	const store = new InMemoryCoreStore();
	let now = new Date("2026-10-10T00:00:00.000Z");
	const events = new CoreEventStream(
		store,
		"event-integrity-key-with-sufficient-entropy",
		() => now,
	);
	await events.registerConsumer({
		identifier: "addon.statistics.ingestion",
		ownerIdentifier: "addon.statistics",
		topics: ["site.page.view"],
		startAt: "earliest",
	});

	const published = await events.publish({
		ownerIdentifier: "native.pages",
		topic: "site.page.view",
		schemaVersion: 1,
		payload: { page: "home", authenticated: false },
		retentionUntil: new Date("2026-10-11T00:00:00.000Z"),
		idempotencyKey: "request-1",
	});
	const duplicate = await events.publish({
		ownerIdentifier: "native.pages",
		topic: "site.page.view",
		schemaVersion: 1,
		payload: { page: "home", authenticated: false },
		retentionUntil: new Date("2026-10-11T00:00:00.000Z"),
		idempotencyKey: "request-1",
	});
	await assert.rejects(
		events.publish({
			ownerIdentifier: "native.pages",
			topic: "site.page.view",
			schemaVersion: 2,
			payload: { page: "home", authenticated: false },
			retentionUntil: new Date("2026-10-11T00:00:00.000Z"),
			idempotencyKey: "request-1",
		}),
		(error) => error instanceof CoreError && error.code === "configuration.invalid",
	);
	await events.publish({
		ownerIdentifier: "native.search",
		topic: "site.search.completed",
		schemaVersion: 1,
		payload: { resultCount: 0 },
		retentionUntil: new Date("2026-10-11T00:00:00.000Z"),
	});

	assert.equal(duplicate.id, published.id);
	assert.match(published.payloadChecksum, /^[0-9a-f]{64}$/);
	assert.match(published.signature, /^[0-9a-f]{64}$/);
	assert.equal((await events.read("addon.statistics.ingestion")).length, 1);
	now = new Date("2026-10-12T00:00:00.000Z");
	assert.equal(await events.purgeExpired(), 1);
	await events.acknowledge("addon.statistics.ingestion", published.sequence);
	assert.equal((await events.read("addon.statistics.ingestion")).length, 0);
	assert.equal(await events.purgeExpired(), 1);
	await events.deactivateConsumer("addon.statistics.ingestion");
	await events.registerConsumer({
		identifier: "core.integrity.validation",
		ownerIdentifier: "core.validation",
		topics: ["core.integrity.tampered"],
		startAt: "earliest",
	});
	const { sequence, ...tampered } = published;
	assert.ok(sequence > 0n);
	await store.appendEvent({
		...tampered,
		id: "00000000-0000-4000-8000-000000000037",
		topic: "core.integrity.tampered",
		payload: { page: "tampered", authenticated: false },
		idempotencyKey: "tampered-event",
	});
	await assert.rejects(events.read("core.integrity.validation"), CoreError);

	await assert.rejects(
		events.registerConsumer({
			identifier: "addon.statistics.ingestion",
			ownerIdentifier: "addon.other",
			topics: ["site.page.view"],
			startAt: "earliest",
		}),
		(error) => error instanceof CoreError && error.code === "authorization.denied",
	);
});

test("résout les implications de capacités et refuse les rôles incompatibles", async () => {
	const store = new InMemoryCoreStore();
	const userId = "00000000-0000-4000-8000-000000000010";
	const editorRoleId = "00000000-0000-4000-8000-000000000011";
	const restrictedRoleId = "00000000-0000-4000-8000-000000000012";
	await store.createUser({
		id: userId,
		login: "authorization-test",
		displayName: "Authorization Test",
		passwordDigest: "not-used-by-this-test",
		founder: false,
		active: true,
		createdAt: new Date("2026-10-09T00:00:00.000Z"),
	});
	await store.createRole({
		id: editorRoleId,
		identifier: "test.editor",
		displayName: "Editor",
		protected: false,
	});
	await store.createRole({
		id: restrictedRoleId,
		identifier: "test.restricted",
		displayName: "Restricted",
		protected: false,
	});
	await store.grantRoleCapability(editorRoleId, "test.content.manage");
	await store.declareCapabilityImplication("test.content.manage", "test.content.read");
	await store.declareCapabilityImplication("test.content.read", "test.content.inspect");
	await store.assignRole(userId, editorRoleId);

	assert.equal(await store.hasCapability(userId, "test.content.inspect"), true);
	await assert.rejects(
		store.declareCapabilityImplication("test.content.inspect", "test.content.manage"),
		CoreError,
	);

	await store.declareRoleIncompatibility(editorRoleId, restrictedRoleId);
	await assert.rejects(store.assignRole(userId, restrictedRoleId), CoreError);
});

test("exécute les parcours de sécurité de compte du Core", async () => {
	const store = new InMemoryCoreStore();
	let installationToken;
	const application = await bootstrapCore({
		config,
		store,
		secrets,
		logger: new MemoryLogger(),
		installationTokenPublisher: {
			async publish(token) {
				installationToken = token;
			},
			async clear() {
				installationToken = undefined;
			},
		},
	});
	const founder = await application.authentication.createFounder({
		login: "security-founder",
		displayName: "Security Founder",
		password: "correct horse battery staple",
		installationToken,
		correlationId: "security-founder",
	});

	const email = await application.accountSecurity.registerEmail({
		userId: founder.id,
		email: "Founder@Example.test",
		primary: true,
	});
	await application.accountSecurity.verifyEmail("founder@example.test");
	assert.ok((await store.findEmailAddress(email.normalizedEmail))?.verifiedAt);

	const reset = await application.accountSecurity.issueSecurityToken({
		purpose: "password-reset",
		userId: founder.id,
		ttlMs: 60_000,
	});
	assert.equal(
		(await application.accountSecurity.consumeSecurityToken("password-reset", reset.token)).userId,
		founder.id,
	);
	await assert.rejects(
		application.accountSecurity.consumeSecurityToken("password-reset", reset.token),
		CoreError,
	);

	const webauthn = await application.accountSecurity.issueWebAuthnChallenge({
		purpose: "registration",
		userId: founder.id,
		ttlMs: 60_000,
	});
	await application.accountSecurity.consumeWebAuthnChallenge("registration", webauthn.challenge);
	await assert.rejects(
		application.accountSecurity.consumeWebAuthnChallenge("registration", webauthn.challenge),
		CoreError,
	);

	const passkey = await application.accountSecurity.registerPasskey({
		userId: founder.id,
		credentialId: new Uint8Array([1, 2, 3]),
		publicKey: new Uint8Array([4, 5, 6]),
		transports: ["internal"],
		deviceType: "single-device",
		backedUp: false,
		displayName: "Clé principale",
	});
	await application.accountSecurity.recordPasskeyUse(founder.id, passkey.id, 1);
	await assert.rejects(
		application.accountSecurity.recordPasskeyUse(founder.id, passkey.id, 1),
		CoreError,
	);

	const authenticated = await application.authentication.login(
		"security-founder",
		"correct horse battery staple",
		"security-login",
		{ address: "192.0.2.10" },
	);
	const deviceProof = await application.accountSecurity.issueDeviceProof({
		sessionId: authenticated.session.id,
		deviceIdentifier: "test-device",
		ttlMs: 60_000,
	});
	const verifiedProof = await application.accountSecurity.verifyDeviceProof(deviceProof);
	await application.accountSecurity.revokeDeviceProof(verifiedProof.id);
	await assert.rejects(application.accountSecurity.verifyDeviceProof(deviceProof), CoreError);

	await application.accountSecurity.banUser({
		userId: founder.id,
		reason: "Test de suspension",
	});
	await assert.rejects(application.authentication.authenticate(authenticated.token), CoreError);
	await application.settings.setUserPreference(founder.id, "core.interface.compact", true);
	assert.equal(
		await application.settings.getUserPreference(founder.id, "core.interface.compact"),
		true,
	);
	assert.ok(store.securityAttemptRecords.some((attempt) => attempt.outcome === "succeeded"));
	await application.runtime.stop();
});

test("gère les réglages Core et verrouille l'état d'installation", async () => {
	const store = new InMemoryCoreStore();
	await store.setInstanceId("00000000-0000-4000-8000-000000000020");
	let installationToken;
	const application = await bootstrapCore({
		config,
		store,
		secrets,
		logger: new MemoryLogger(),
		installationTokenPublisher: {
			async publish(token) {
				installationToken = token;
			},
			async clear() {
				installationToken = undefined;
			},
		},
	});
	assert.equal(typeof installationToken, "string");

	await application.settings.setInstanceSetting("core.security.show-errors", false);
	assert.equal(await application.settings.getInstanceSetting("core.security.show-errors"), false);
	await assert.rejects(
		application.settings.setInstanceSetting("site.title", "Interdit"),
		CoreError,
	);

	const started = await application.installationState.begin("installer-1", 1);
	assert.equal(started.status, "in-progress");
	await assert.rejects(application.installationState.begin("installer-2", 1), CoreError);
	const completed = await application.installationState.complete("installer-1");
	assert.equal(completed.status, "completed");
	assert.equal(completed.lockOwner, undefined);
	await application.runtime.stop();
});

test("restaure atomiquement une sauvegarde Core sans sessions temporaires", async () => {
	const store = new InMemoryCoreStore();
	const application = await bootstrapCore({
		config,
		store,
		secrets,
		logger: new MemoryLogger(),
		installationTokenPublisher: {
			async publish() {},
			async clear() {},
		},
	});
	const userId = "00000000-0000-4000-8000-000000000030";
	const roleId = "00000000-0000-4000-8000-000000000031";
	const createdAt = new Date("2026-10-09T00:00:00.000Z");
	const bundle = {
		users: [
			{
				id: userId,
				login: "restored-founder",
				displayName: "Restored Founder",
				passwordDigest: "legacy-digest",
				founder: true,
				active: true,
				createdAt,
			},
		],
		emails: [
			{
				id: "00000000-0000-4000-8000-000000000032",
				userId,
				email: "restored@example.test",
				normalizedEmail: "restored@example.test",
				primary: true,
				verifiedAt: createdAt,
				createdAt,
				updatedAt: createdAt,
			},
		],
		roles: [
			{
				id: roleId,
				identifier: "restored.administrator",
				displayName: "Restored Administrator",
				protected: true,
			},
		],
		userCapabilities: [{ userId, capability: "core.system.manage" }],
		roleCapabilities: [{ roleId, capability: "core.administration.access" }],
		userRoles: [{ userId, roleId }],
		capabilityImplications: [],
		roleIncompatibilities: [],
		twoFactor: [],
	};

	await application.restoration.restore(bundle);
	assert.equal((await store.findUserById(userId))?.founder, true);
	assert.equal(await store.hasCapability(userId, "core.administration.access"), true);
	await assert.rejects(application.restoration.restore(bundle), CoreError);
	await application.runtime.stop();

	class FailingRestorationStore extends InMemoryCoreStore {
		async upsertEmailAddress() {
			throw new CoreError("infrastructure.unavailable", "Échec de restauration simulé.");
		}
	}
	const failingStore = new FailingRestorationStore();
	await assert.rejects(new CoreRestorationService(failingStore).restore(bundle), CoreError);
	assert.equal(await failingStore.countUsers(), 0);
});
