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
	InMemoryMessagingRepository,
	InMemoryMessagingCampaignRepository,
	InMemoryMessageAudienceDirectory,
	InMemoryMessageDeliveryRepository,
	InMemoryNotificationTemplateRepository,
	InMemoryObjectStorage,
	InMemoryTaskQueue,
	loadCoreConfig,
	ManagedObjectStorage,
	MessagingCampaignService,
	MessageDeliveryService,
	NotificationTemplateService,
	MemoryLogger,
	OutboundGateway,
	PersistentMessagingService,
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

test("persiste idempotemment un message et son outbox transactionnelle", async () => {
	const repository = new InMemoryMessagingRepository();
	let currentTime = new Date("2026-10-14T12:00:00.000Z");
	const messaging = new PersistentMessagingService(repository, () => currentTime);
	await messaging.registerTopicVersion({
		topicIdentifier: "core.validation.message",
		ownerIdentifier: "core.validation",
		schemaVersion: "1.0.0",
		definition: { type: "object" },
	});

	const input = {
		topicIdentifier: "core.validation.message",
		schemaVersion: "1.0.0",
		producerIdentifier: "core.validation",
		priority: "normal",
		payload: { value: "first" },
		correlationId: "phase-6-6-correlation",
		idempotencyKey: "phase-6-6-idempotency",
		availableAt: currentTime,
	};
	const first = await messaging.enqueue(input);
	const duplicate = await messaging.enqueue(input);
	assert.equal(first.created, true);
	assert.equal(duplicate.created, false);
	assert.equal(duplicate.message.id, first.message.id);
	assert.equal(repository.inspectOutbox().length, 1);
	await assert.rejects(
		messaging.enqueue({ ...input, payload: { value: "conflicting" } }),
		(error) => error instanceof CoreError && error.code === "infrastructure.conflict",
	);

	const published = [];
	assert.deepEqual(
		await messaging.dispatchOutbox({
			async publish(message) {
				published.push(message.id);
			},
		}),
		{ published: 1, failed: 0 },
	);
	assert.deepEqual(published, [first.message.id]);
	assert.equal(repository.inspectOutbox()[0].status, "published");
	assert.equal(await messaging.cancel(first.message.id), false);

	currentTime = new Date("2026-10-14T12:01:00.000Z");
	const delayed = await messaging.enqueue({
		...input,
		payload: { value: "delayed" },
		idempotencyKey: "phase-6-6-delayed",
		availableAt: new Date("2026-10-14T13:00:00.000Z"),
	});
	assert.deepEqual(await messaging.dispatchOutbox({ async publish() {} }), {
		published: 0,
		failed: 0,
	});
	assert.equal(await messaging.cancel(delayed.message.id), true);
	assert.equal(
		repository.inspectOutbox().find((entry) => entry.messageId === delayed.message.id).status,
		"cancelled",
	);
});

test("relance l’outbox avec un délai borné après un échec de transport", async () => {
	const repository = new InMemoryMessagingRepository();
	let currentTime = new Date("2026-10-14T14:00:00.000Z");
	const messaging = new PersistentMessagingService(repository, () => currentTime);
	await messaging.registerTopicVersion({
		topicIdentifier: "core.validation.retry",
		ownerIdentifier: "core.validation",
		schemaVersion: "1.0.0",
		definition: { type: "object" },
	});
	await messaging.enqueue({
		topicIdentifier: "core.validation.retry",
		schemaVersion: "1.0.0",
		producerIdentifier: "core.validation",
		priority: "high",
		payload: { attempt: 1 },
		availableAt: currentTime,
	});

	assert.deepEqual(
		await messaging.dispatchOutbox(
			{
				async publish() {
					throw Object.assign(new Error("Transport unavailable."), {
						code: "transport.unavailable",
					});
				},
			},
			{ retryDelayMs: 1_000 },
		),
		{ published: 0, failed: 1 },
	);
	let outbox = repository.inspectOutbox()[0];
	assert.equal(outbox.status, "pending");
	assert.equal(outbox.attemptCount, 1);
	assert.equal(outbox.lastErrorCode, "transport.unavailable");
	assert.equal(outbox.availableAt.toISOString(), "2026-10-14T14:00:01.000Z");

	currentTime = new Date("2026-10-14T14:00:01.000Z");
	assert.deepEqual(await messaging.dispatchOutbox({ async publish() {} }), {
		published: 1,
		failed: 0,
	});
	outbox = repository.inspectOutbox()[0];
	assert.equal(outbox.status, "published");
	assert.equal(outbox.attemptCount, 2);
});

test("verrouille la propriété et la version des sujets de messagerie", async () => {
	const messaging = new PersistentMessagingService(new InMemoryMessagingRepository());
	const topic = {
		topicIdentifier: "site.validation.topic",
		ownerIdentifier: "site.validation",
		schemaVersion: "1.0.0",
		definition: { type: "object" },
	};
	await messaging.registerTopicVersion(topic);
	await messaging.registerTopicVersion(topic);
	await assert.rejects(
		messaging.registerTopicVersion({ ...topic, ownerIdentifier: "addon.intruder" }),
		(error) => error instanceof CoreError && error.code === "authorization.denied",
	);
	await assert.rejects(
		messaging.registerTopicVersion({ ...topic, definition: { type: "string" } }),
		(error) => error instanceof CoreError && error.code === "infrastructure.conflict",
	);
	await assert.rejects(
		messaging.enqueue({
			topicIdentifier: "site.validation.unknown",
			schemaVersion: "1.0.0",
			producerIdentifier: "site.validation",
			priority: "normal",
			payload: {},
		}),
		(error) => error instanceof CoreError && error.code === "messaging.topic_unknown",
	);
});

test("résout les audiences backend et borne les envois directs après résolution", async () => {
	const firstUser = "67000000-0000-4000-8000-000000000001";
	const secondUser = "67000000-0000-4000-8000-000000000002";
	const service = new MessageDeliveryService(
		new InMemoryMessageAudienceDirectory({
			"group:game-masters": [firstUser, secondUser, firstUser],
		}),
		new InMemoryMessageDeliveryRepository(),
	);
	const group = await service.previewAudience({
		kind: "group",
		identifiers: ["game-masters"],
		resolutionMode: "snapshot",
	});
	assert.equal(group.cardinality, 2);
	assert.deepEqual(group.userIds, [firstUser, secondUser]);
	await assert.rejects(
		service.previewAudience(
			{
				kind: "user-list",
				identifiers: [firstUser, secondUser],
				resolutionMode: "snapshot",
			},
			1,
		),
		(error) => error instanceof CoreError && error.code === "security.rate_limited",
	);
});

test("livre, acquitte et place les échecs terminaux en lettre morte", async () => {
	const userId = "67000000-0000-4000-8000-000000000003";
	const repository = new InMemoryMessageDeliveryRepository();
	let currentTime = new Date("2026-10-14T16:00:00.000Z");
	const service = new MessageDeliveryService(
		new InMemoryMessageAudienceDirectory({}),
		repository,
		() => currentTime,
		() => 0,
	);
	await service.materialize({
		messageId: "67000000-0000-4000-8000-000000000010",
		audience: { kind: "user", identifiers: [userId], resolutionMode: "snapshot" },
		channel: "realtime",
		requiredAcknowledgement: "read",
	});
	assert.deepEqual(await service.dispatch({ async deliver() {} }), {
		delivered: 1,
		expired: 0,
		failed: 0,
	});
	const delivery = repository.inspect().deliveries[0];
	assert.equal(
		await service.acknowledge({ deliveryId: delivery.deliveryId, userId, kind: "read" }),
		true,
	);
	assert.equal(
		await service.acknowledge({ deliveryId: delivery.deliveryId, userId, kind: "transport" }),
		false,
	);

	currentTime = new Date("2026-10-14T16:01:00.000Z");
	await service.materialize({
		messageId: "67000000-0000-4000-8000-000000000011",
		audience: { kind: "user", identifiers: [userId], resolutionMode: "snapshot" },
		channel: "inbox",
		requiredAcknowledgement: "none",
	});
	assert.deepEqual(
		await service.dispatch(
			{
				async deliver(candidate) {
					if (candidate.messageId.endsWith("11")) throw new Error("Offline");
				},
			},
			{ maximumAttempts: 1 },
		),
		{ delivered: 0, expired: 0, failed: 1 },
	);
	assert.equal(repository.inspect().deadLetters, 1);
	assert.deepEqual(await service.dispatch({ async deliver() {} }), {
		delivered: 0,
		expired: 0,
		failed: 0,
	});
});

test("reprend les livraisons par curseur sans rejouer une position acquittée", async () => {
	const userId = "67000000-0000-4000-8000-000000000004";
	const repository = new InMemoryMessageDeliveryRepository();
	const service = new MessageDeliveryService(new InMemoryMessageAudienceDirectory({}), repository);
	for (const suffix of ["20", "21"]) {
		await service.materialize({
			messageId: `67000000-0000-4000-8000-0000000000${suffix}`,
			audience: { kind: "user", identifiers: [userId], resolutionMode: "snapshot" },
			channel: "realtime",
			requiredAcknowledgement: "processed",
		});
	}
	const resumed = await service.resume("frontend.session", userId, 0);
	assert.deepEqual(
		resumed.map((delivery) => delivery.position),
		[1, 2],
	);
	await service.commitCursor("frontend.session", userId, 2);
	assert.deepEqual(await service.resume("frontend.session", userId, 0), []);
	await assert.rejects(
		service.commitCursor("frontend.session", userId, 1),
		(error) => error instanceof CoreError && error.code === "infrastructure.conflict",
	);
});

test("rend un modèle versionné avec locale de repli et variables validées", async () => {
	const repository = new InMemoryNotificationTemplateRepository();
	const service = new NotificationTemplateService(repository, {
		async hasConnector() {
			return false;
		},
	});
	const template = {
		identifier: "site.welcome",
		templateVersion: "1.0.0",
		topicIdentifier: "site.account.created",
		ownerIdentifier: "site",
		fallbackLocale: "en",
		variables: {
			displayName: {
				type: "string",
				required: true,
				classification: "internal",
				maximumLength: 80,
			},
		},
		localizations: {
			en: { title: "Welcome {{displayName}}", body: "Your account is ready, {{displayName}}." },
			fr: { title: "Bienvenue {{displayName}}", body: "Votre compte est prêt, {{displayName}}." },
		},
	};
	await service.registerTemplate(template);
	const rendered = await service.render({
		templateIdentifier: "site.welcome",
		templateVersion: "1.0.0",
		locale: "fr-CA",
		variables: { displayName: "<Admin>" },
	});
	assert.equal(rendered.locale, "fr");
	assert.equal(rendered.title, "Bienvenue &lt;Admin&gt;");
	await assert.rejects(
		service.render({
			templateIdentifier: "site.welcome",
			templateVersion: "1.0.0",
			locale: "en",
			variables: { unknown: true },
		}),
		CoreError,
	);
});

test("conserve le rendu historique et interdit la mutation d’une version", async () => {
	const repository = new InMemoryNotificationTemplateRepository();
	const service = new NotificationTemplateService(repository, {
		async hasConnector() {
			return false;
		},
	});
	const template = {
		identifier: "core.security.notice",
		templateVersion: "1.0.0",
		topicIdentifier: "core.security.notice",
		ownerIdentifier: "core",
		fallbackLocale: "en",
		variables: {},
		localizations: { en: { title: "Security notice", body: "Review your account." } },
	};
	await service.registerTemplate(template);
	const rendered = await service.render({
		templateIdentifier: template.identifier,
		templateVersion: template.templateVersion,
		locale: "en",
		variables: {},
	});
	await service.materialize({
		messageId: "68000000-0000-4000-8000-000000000001",
		purpose: "security",
		mandatory: true,
		rendered,
	});
	await assert.rejects(
		service.registerTemplate({
			...template,
			localizations: { en: { title: "Changed", body: "Changed content." } },
		}),
		(error) => error instanceof CoreError && error.code === "infrastructure.conflict",
	);
});

test("applique les préférences sans désactiver une communication obligatoire", async () => {
	const repository = new InMemoryNotificationTemplateRepository();
	const service = new NotificationTemplateService(repository, {
		async hasConnector(identifier) {
			return identifier === "site.mailer";
		},
	});
	await service.registerChannel({
		identifier: "email",
		ownerIdentifier: "site",
		kind: "connector",
		connectorIdentifier: "site.mailer",
	});
	const userId = "68000000-0000-4000-8000-000000000002";
	await service.savePreference({
		userId,
		scopeKind: "topic",
		scopeIdentifier: "site.news",
		channelIdentifier: "email",
		enabled: false,
		locale: "fr-FR",
		quietStart: "22:00",
		quietEnd: "07:00",
		timezone: "Europe/Paris",
	});
	const ordinary = await service.resolvePreference({
		userId,
		topicIdentifier: "site.news",
		purposeIdentifier: "information",
		channelIdentifier: "email",
		mandatory: false,
		at: new Date("2026-10-14T21:00:00.000Z"),
	});
	assert.deepEqual(ordinary, { enabled: false, locale: "fr-FR", quiet: true });
	const mandatory = await service.resolvePreference({
		userId,
		topicIdentifier: "site.news",
		purposeIdentifier: "security",
		channelIdentifier: "email",
		mandatory: false,
		at: new Date("2026-10-14T21:00:00.000Z"),
	});
	assert.deepEqual(mandatory, { enabled: true, locale: "fr-FR", quiet: false });
	await assert.rejects(
		service.registerChannel({
			identifier: "push",
			ownerIdentifier: "site",
			kind: "connector",
			connectorIdentifier: "site.unknown",
		}),
		CoreError,
	);
});

test("prévisualise, confirme, planifie et exécute une campagne autorisée", async () => {
	let now = new Date("2026-10-14T12:00:00.000Z");
	const operatorId = "69000000-0000-4000-8000-000000000001";
	const repository = new InMemoryMessagingCampaignRepository();
	const notifications = new NotificationTemplateService(
		new InMemoryNotificationTemplateRepository(),
		{
			async hasConnector() {
				return false;
			},
		},
	);
	await notifications.registerTemplate({
		identifier: "site.campaign.notice",
		templateVersion: "1.0.0",
		topicIdentifier: "site.campaign.notice",
		ownerIdentifier: "site.campaigns",
		fallbackLocale: "en",
		variables: {
			name: { type: "string", required: true, classification: "internal" },
		},
		localizations: {
			en: { title: "Hello {{name}}", body: "Campaign body." },
		},
	});
	const published = [];
	const service = new MessagingCampaignService(
		repository,
		{
			async hasCapability() {
				return true;
			},
		},
		{
			async isActive(identifier) {
				return identifier === "site.campaigns";
			},
		},
		{
			async preview() {
				return { recipientCount: 42, audienceFingerprint: "segment-v1" };
			},
		},
		notifications,
		{
			async sendTest({ operatorId: target }) {
				assert.equal(target, operatorId);
				return "69000000-0000-4000-8000-000000000010";
			},
			async publish(input) {
				published.push(input);
				return {
					messageId: "69000000-0000-4000-8000-000000000011",
					recipientCount: 42,
				};
			},
			async revoke() {},
			async replayDeadLetter() {
				return "69000000-0000-4000-8000-000000000012";
			},
			async deliverySummary() {
				return { delivered: 40, acknowledged: 38, read: 32, processed: 30, expired: 1, failed: 1 };
			},
		},
		() => now,
	);
	const campaign = await service.createDraft(
		{
			ownerIdentifier: "site",
			contributionIdentifier: "site.campaigns",
			topicIdentifier: "site.campaign.notice",
			schemaVersion: "1.0.0",
			templateIdentifier: "site.campaign.notice",
			templateVersion: "1.0.0",
			audience: { kind: "segment", selector: { identifier: "active-users" } },
			variables: { name: "Adventurer" },
			requestedLocale: "en",
			priority: "normal",
			createdBy: operatorId,
		},
		"campaign-create",
	);
	const preview = await service.preview(campaign.id, operatorId, "campaign-preview");
	assert.equal(preview.recipientCount, 42);
	assert.match(preview.previewDigest, /^[0-9a-f]{64}$/);
	await service.sendTest(campaign.id, operatorId, "campaign-test");
	await service.confirm(campaign.id, operatorId, preview.previewDigest, "campaign-confirm");
	await service.schedule(
		campaign.id,
		operatorId,
		new Date("2026-10-14T13:00:00.000Z"),
		"campaign-schedule",
	);
	now = new Date("2026-10-14T13:00:01.000Z");
	assert.deepEqual(await service.dispatchDue(), { completed: 1, failed: 0 });
	assert.equal(published.length, 1);
	const inspection = await service.inspect(campaign.id, operatorId);
	assert.equal(inspection.campaign.status, "completed");
	assert.equal(inspection.delivery.read, 32);
	assert.equal("recipients" in inspection, false);
	assert.equal(
		repository.events.some((event) => event.eventType === "mass-sent"),
		true,
	);
	await service.revoke(campaign.id, operatorId, "campaign-revoke");
	assert.equal((await repository.find(campaign.id)).status, "revoked");
});

test("annule, révoque et audite la relecture sans divulguer les destinataires", async () => {
	const operatorId = "69000000-0000-4000-8000-000000000002";
	const repository = new InMemoryMessagingCampaignRepository();
	const notifications = new NotificationTemplateService(
		new InMemoryNotificationTemplateRepository(),
		{
			async hasConnector() {
				return false;
			},
		},
	);
	await notifications.registerTemplate({
		identifier: "site.campaign.audit",
		templateVersion: "1.0.0",
		topicIdentifier: "site.campaign.audit",
		ownerIdentifier: "site.campaigns",
		fallbackLocale: "en",
		variables: {},
		localizations: { en: { title: "Audit", body: "Audit body." } },
	});
	const publisher = {
		async sendTest() {
			return "69000000-0000-4000-8000-000000000020";
		},
		async publish() {
			return { messageId: "69000000-0000-4000-8000-000000000021", recipientCount: 1 };
		},
		async revoke() {},
		async replayDeadLetter() {
			return "69000000-0000-4000-8000-000000000022";
		},
		async deliverySummary() {
			return { delivered: 0, acknowledged: 0, read: 0, processed: 0, expired: 0, failed: 1 };
		},
	};
	const service = new MessagingCampaignService(
		repository,
		{
			async hasCapability() {
				return true;
			},
		},
		{
			async isActive() {
				return true;
			},
		},
		{
			async preview() {
				return { recipientCount: 1, audienceFingerprint: "one" };
			},
		},
		notifications,
		publisher,
		() => new Date("2026-10-14T12:00:00.000Z"),
	);
	const draft = await service.createDraft(
		{
			ownerIdentifier: "site",
			contributionIdentifier: "site.campaigns",
			topicIdentifier: "site.campaign.audit",
			schemaVersion: "1.0.0",
			templateIdentifier: "site.campaign.audit",
			templateVersion: "1.0.0",
			audience: { kind: "user", selector: { id: operatorId } },
			variables: {},
			requestedLocale: "en",
			priority: "normal",
			createdBy: operatorId,
		},
		"campaign-audit-create",
	);
	await service.cancel(draft.id, operatorId, "campaign-cancel");
	assert.equal((await repository.find(draft.id)).status, "cancelled");
	const replayed = await service.replayDeadLetter(
		draft.id,
		"69000000-0000-4000-8000-000000000023",
		operatorId,
		"campaign-replay",
	);
	assert.equal(replayed, "69000000-0000-4000-8000-000000000022");
	assert.equal(
		repository.events.some((event) => event.eventType === "dead-letter-replayed"),
		true,
	);
});

test("bloque toute nouvelle émission d’une contribution désactivée", async () => {
	const repository = new InMemoryMessagingRepository();
	const messaging = new PersistentMessagingService(repository, () => new Date(), {
		async isActive(identifier) {
			return identifier !== "addon.disabled";
		},
	});
	await messaging.registerTopicVersion({
		topicIdentifier: "site.lifecycle.notice",
		ownerIdentifier: "site",
		schemaVersion: "1.0.0",
		definition: { type: "object" },
	});
	await assert.rejects(
		messaging.enqueue({
			topicIdentifier: "site.lifecycle.notice",
			schemaVersion: "1.0.0",
			producerIdentifier: "addon.disabled",
			priority: "normal",
			payload: {},
		}),
		(error) => error instanceof CoreError && error.code === "authorization.denied",
	);
});
