import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import {
	bootstrapCore,
	AesGcmSecretCipher,
	CommunicationService,
	CoreError,
	CoreRuntime,
	CsrfProtection,
	InMemoryCoreStore,
	InMemoryObjectStorage,
	loadCoreConfig,
	MemoryLogger,
	OutboundGateway,
	RateLimiter,
	securityDigest,
} from "../backend/build/core/src/index.js";

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
	await assert.rejects(
		application.authentication.requireAdministration(authenticated.token),
		(error) => error instanceof CoreError && error.code === "authentication.two_factor_required",
	);
	await store.setTwoFactor(founder.id, {
		secret: "JBSWY3DPEHPK3PXP",
		recoveryCodeDigests: new Set([securityDigest("recovery-code")]),
	});
	await application.twoFactor.verify(authenticated.session, "recovery-code");
	assert.equal(
		(await application.authentication.requireAdministration(authenticated.token)).user.id,
		founder.id,
	);
	await application.authentication.revoke(authenticated.token, "test-revoke");
	await assert.rejects(application.authentication.authenticate(authenticated.token), CoreError);
	await assert.rejects(store.setUserActive(founder.id, false), CoreError);
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

test("applique les règles de stockage et de communication directe", async () => {
	const storage = new InMemoryObjectStorage();
	await storage.put("core/audit/item.json", new Uint8Array([1, 2, 3]), "application/json");
	assert.deepEqual(await storage.get("core/audit/item.json"), new Uint8Array([1, 2, 3]));
	await assert.rejects(storage.put("../secret", new Uint8Array(), "text/plain"), CoreError);

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
});
