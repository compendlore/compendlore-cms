import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import { foundation } from "../backend/build/core/src/index.js";

test("expose une fondation minimale", () => {
	assert.equal(foundation.packageName, "@compendlore/core");
	assert.equal(foundation.status, "operational");
});

test("la migration fondatrice couvre les tables et protections minimales du Core", async () => {
	const migration = await readFile(
		new URL("../backend/core/migrations/001_core_foundation.up.sql", import.meta.url),
		"utf8",
	);
	for (const table of [
		"instances",
		"users",
		"sessions",
		"two_factor",
		"two_factor_recovery_codes",
		"roles",
		"capabilities",
		"role_capabilities",
		"user_roles",
		"user_capabilities",
		"audit_log",
		"schema_journal",
	]) {
		assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS core\\.${table}\\b`));
	}
	for (const protection of [
		/instances_singleton_idx/,
		/users_single_founder_idx/,
		/sessions_expiration_after_creation/,
		/audit_outcome_allowed/,
		/REFERENCES core\.users \(id\) ON DELETE CASCADE/,
	]) {
		assert.match(migration, protection);
	}
	assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\b/i);
});

test("la consolidation Core reste additive et limitée au schéma Core", async () => {
	const migration = await readFile(
		new URL(
			"../backend/core/migrations/002_core_security_and_configuration.up.sql",
			import.meta.url,
		),
		"utf8",
	);
	const expectedTables = [
		"user_email_addresses",
		"security_tokens",
		"user_passkeys",
		"webauthn_challenges",
		"session_device_proofs",
		"capability_implications",
		"role_incompatibilities",
		"user_bans",
		"ip_bans",
		"security_attempts",
		"user_preferences",
		"instance_settings",
		"installation_state",
	];

	for (const table of expectedTables) {
		assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS core\\.${table}\\b`));
	}
	for (const protection of [
		/user_email_addresses_normalized_idx/,
		/security_tokens_expiration_after_creation/,
		/user_passkeys_sign_count_positive/,
		/capability_implications_not_self/,
		/role_incompatibilities_canonical_order/,
		/installation_state_lock_complete/,
	]) {
		assert.match(migration, protection);
	}
	assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\b/i);
	assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS (?!core\.)/);
});

test("le jeton d'installation possède sa propre migration Core additive", async () => {
	const migration = await readFile(
		new URL("../backend/core/migrations/003_core_installation_token.up.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /CREATE TABLE IF NOT EXISTS core\.installation_tokens\b/);
	assert.match(migration, /token_digest TEXT NOT NULL UNIQUE/);
	assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\b/i);
});

test("le flux d’événements étend le Core sans table statistique métier", async () => {
	const migration = await readFile(
		new URL("../backend/core/migrations/004_core_event_stream.up.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /ALTER TABLE core\.events\b/);
	assert.match(migration, /CREATE TABLE core\.event_consumers\b/);
	assert.match(migration, /idempotency_key TEXT/);
	assert.match(migration, /retention_until TIMESTAMPTZ/);
	assert.doesNotMatch(migration, /\b(?:statistics|analytics|metrics)\b/i);
	assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\b/i);
});

test("la preuve d’intégrité des événements reste additive", async () => {
	const migration = await readFile(
		new URL("../backend/core/migrations/007_core_event_integrity.up.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /ADD COLUMN payload_checksum TEXT/);
	assert.match(migration, /ADD COLUMN signature TEXT/);
	assert.match(migration, /events_payload_checksum_format/);
	assert.match(migration, /events_signature_format/);
	assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\b/i);
});

test("les services fondamentaux possèdent leurs ressources Encore et persistantes", async () => {
	const [foundationMigration, objectStorage, runtime, taskQueue] = await Promise.all([
		readFile(
			new URL("../backend/core/migrations/001_core_foundation.up.sql", import.meta.url),
			"utf8",
		),
		readFile(new URL("../backend/core/object-storage.ts", import.meta.url), "utf8"),
		readFile(new URL("../backend/core/encore-runtime.ts", import.meta.url), "utf8"),
		readFile(new URL("../backend/core/task-queue.ts", import.meta.url), "utf8"),
	]);

	assert.match(objectStorage, /new Bucket\("core-private-objects"/);
	assert.match(objectStorage, /public:\s*false/);
	assert.match(objectStorage, /versioned:\s*true/);
	assert.match(runtime, /new EnvironmentSecretProvider\(process\.env\)/);
	assert.match(foundationMigration, /CREATE TABLE IF NOT EXISTS core\.tasks\b/);
	assert.match(foundationMigration, /CREATE TABLE IF NOT EXISTS core\.events\b/);
	assert.match(foundationMigration, /CREATE TABLE IF NOT EXISTS core\.communications\b/);
	assert.match(taskQueue, /FOR UPDATE SKIP LOCKED/);
	assert.match(taskQueue, /WHERE status = 'pending' AND execute_at <= \$\{at\}/);
});
