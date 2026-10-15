import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

test("la synchronisation des notifications reste additive et sans sujet natif en migration", async () => {
	const migration = await readFile(
		new URL("../backend/core/migrations/020_core_native_notification_sync.up.sql", import.meta.url),
		"utf8",
	);
	assert.match(migration, /ADD COLUMN IF NOT EXISTS revision BIGINT/);
	assert.match(migration, /notification_state_revision_sequence/);
	assert.match(migration, /notification_user_states_revision_idx/);
	assert.doesNotMatch(migration, /INSERT\s+INTO\s+core\.messaging_topics/i);
});
import { foundation as apiFoundation } from "../backend/build/api/src/index.js";
import { foundation } from "../backend/build/core/src/index.js";
import { foundation as registryFoundation } from "../backend/build/cms-registry/src/index.js";

test("expose une fondation minimale", () => {
	assert.equal(foundation.packageName, "@compendlore/core");
	assert.equal(foundation.status, "operational");
});

test("le socle technique du Registry respecte les frontières Encore et Core", async () => {
	const registrySourceDirectory = new URL("../backend/cms-registry/src/", import.meta.url);
	const sourceFiles = (await readdir(registrySourceDirectory)).filter((name) =>
		name.endsWith(".ts"),
	);
	const [service, backendTsconfig, layers, ...sources] = await Promise.all([
		readFile(new URL("../backend/cms-registry/encore.service.ts", import.meta.url), "utf8"),
		readFile(new URL("../backend/tsconfig.json", import.meta.url), "utf8"),
		readFile(new URL("../architecture.layers.json", import.meta.url), "utf8"),
		...sourceFiles.map((name) => readFile(new URL(name, registrySourceDirectory), "utf8")),
	]);
	const registrySource = sources.join("\n");

	assert.equal(registryFoundation.packageName, "@compendlore/cms-registry");
	assert.equal(registryFoundation.status, "operational");
	assert.match(service, /new Service\("cms-registry"\)/);
	assert.match(backendTsconfig, /"include": \["\*\*\/\*\.ts"\]/);
	assert.match(layers, /"name": "registry"[\s\S]*?"mayImport": \["core"\]/);
	assert.match(
		layers,
		/"name": "core"[\s\S]*?"publicEntrypoints": \["backend\/core\/src\/index"\]/,
	);
	assert.match(
		layers,
		/"name": "registry"[\s\S]*?"publicEntrypoints": \["backend\/cms-registry\/src\/index"\]/,
	);
	assert.match(registrySource, /RegistryCorePort/);
	assert.doesNotMatch(
		registrySource,
		/encore\.dev\/storage\/sqldb|new SQLDatabase|core\/(?:database|src\/postgres-store)/,
	);
});

test("le socle technique de l’API relie Encore aux contrats Core et Registry", async () => {
	const [service, endpoints, health, backendTsconfig, backendPackage, layers] = await Promise.all([
		readFile(new URL("../backend/api/encore.service.ts", import.meta.url), "utf8"),
		readFile(new URL("../backend/api/src/endpoints.ts", import.meta.url), "utf8"),
		readFile(new URL("../backend/core/health.ts", import.meta.url), "utf8"),
		readFile(new URL("../backend/tsconfig.json", import.meta.url), "utf8"),
		readFile(new URL("../backend/package.json", import.meta.url), "utf8"),
		readFile(new URL("../architecture.layers.json", import.meta.url), "utf8"),
	]);

	assert.equal(apiFoundation.packageName, "@compendlore/api");
	assert.equal(apiFoundation.status, "operational");
	assert.match(service, /new Service\("api"\)/);
	assert.match(health, /expose:\s*true[\s\S]*?method:\s*"GET"[\s\S]*?path:\s*"\/health"/);
	assert.match(endpoints, /ApiAudience/);
	assert.match(endpoints, /ApiGateway/);
	assert.match(backendTsconfig, /"include": \["\*\*\/\*\.ts"\]/);
	assert.match(backendPackage, /"\.\/api": "\.\/build\/api\/src\/index\.js"/);
	assert.match(layers, /"name": "api"[\s\S]*?"mayImport": \["core", "registry"\]/);
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

test("l’identité d’instance ne persiste que sa partie publique dans le Core", async () => {
	const migration = await readFile(
		new URL("../backend/core/migrations/008_core_instance_identity.up.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /CREATE TABLE core\.instance_identities\b/);
	assert.match(migration, /public_key BYTEA NOT NULL/);
	assert.match(migration, /algorithm = 'Ed25519'/);
	assert.match(migration, /assurance_level IN \('hardware', 'protected-file', 'system'\)/);
	assert.doesNotMatch(migration, /private_key|private_key_pem/i);
	assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\b/i);
});

test("la fondation des entités reste additive et limitée aux catalogues Core", async () => {
	const [foundation, ecosystem] = await Promise.all([
		readFile(
			new URL("../backend/core/migrations/016_core_entities.up.sql", import.meta.url),
			"utf8",
		),
		readFile(
			new URL("../backend/core/migrations/017_core_entity_ecosystem.up.sql", import.meta.url),
			"utf8",
		),
	]);
	const migrations = `${foundation}\n${ecosystem}`;

	for (const table of [
		"entity_types",
		"entity_field_types",
		"entity_field_definitions",
		"entity_relation_definitions",
		"entity_interfaces",
		"entity_record_ownership",
		"entity_record_relations",
		"measurement_definitions",
		"measurement_units",
		"taxonomy_vocabularies",
		"taxonomy_terms",
		"entity_search_documents",
		"entity_import_jobs",
		"entity_schema_evolution_plans",
	]) {
		assert.match(migrations, new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? core\\.${table}\\b`));
	}

	assert.match(ecosystem, /DROP CONSTRAINT IF EXISTS entity_field_types_storage_check/);
	assert.match(ecosystem, /ON DELETE RESTRICT/);
	for (const [, table] of migrations.matchAll(
		/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_][\w.]*)/gi,
	)) {
		assert.match(table, /^core\./);
	}
	assert.doesNotMatch(migrations, /\bcms_data\b/i);
	assert.doesNotMatch(migrations, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
});

test("la fondation de navigation reste structurelle et sans donnée native en migration", async () => {
	const migration = await readFile(
		new URL("../backend/core/migrations/018_core_navigation.up.sql", import.meta.url),
		"utf8",
	);

	for (const table of [
		"navigation_modes",
		"navigation_target_types",
		"navigation_actions",
		"navigation_targets",
		"navigation_links",
		"sidebars",
		"sidebar_items",
		"navigation_items",
		"navigation_brand_assignments",
	]) {
		assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS core\\.${table}\\b`));
	}

	for (const [, table] of migration.matchAll(
		/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_][\w.]*)/gi,
	)) {
		assert.match(table, /^core\./);
	}
	assert.match(migration, /ON DELETE RESTRICT/);
	assert.doesNotMatch(migration, /\bINSERT\s+INTO\s+core\.(?:navigation|sidebar)/i);
	assert.doesNotMatch(migration, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
});

test("la fondation des pages reste structurelle et sans page en migration", async () => {
	const migration = await readFile(
		new URL("../backend/core/migrations/019_core_pages.up.sql", import.meta.url),
		"utf8",
	);
	for (const table of [
		"pages",
		"page_versions",
		"page_routes",
		"page_publications",
		"page_imports",
	]) {
		assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS core\\.${table}\\b`));
	}
	assert.match(migration, /ON DELETE RESTRICT/);
	assert.doesNotMatch(migration, /\bINSERT\s+INTO\b/i);
	assert.doesNotMatch(migration, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
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
