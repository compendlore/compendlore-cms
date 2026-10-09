import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import { foundation } from "../backend/build/core/src/index.js";

test("expose une fondation minimale", () => {
	assert.equal(foundation.packageName, "@compendlore/core");
	assert.equal(foundation.status, "phase-3-core");
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
