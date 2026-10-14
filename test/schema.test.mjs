import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import {
	CoreError,
	CoreSchemaGateway,
	InMemorySchemaRuntime,
} from "../backend/build/core/src/index.js";
import { PostgresSchemaRuntime } from "../backend/build/core/src/postgres-schema-runtime.js";
import {
	DeclarativeSchemaManager,
	RegistryError,
	SchemaPlanner,
} from "../backend/build/cms-registry/src/index.js";

const owner = { kind: "addon", identifier: "addon.character-sheet" };

function decision(plan, destructiveApproved = false) {
	return {
		id: randomUUID(),
		planId: plan.id,
		planIntegrity: plan.integrity,
		destructiveApproved,
		issuedAt: new Date(),
	};
}

function contribution(overrides = {}) {
	return {
		contributionKey: "table.character-sheet.characters",
		owner,
		version: "1.0.0",
		withdrawalPolicy: "archive",
		schema: {
			name: "characters",
			columns: [
				{
					name: "id",
					type: "uuid",
					primary: true,
					defaultValue: { kind: "uuid" },
				},
				{ name: "title", type: "varchar", length: 160, nullable: false },
			],
			indexes: [{ name: "characters_title_idx", columns: ["title"] }],
		},
		...overrides,
	};
}

test("valide strictement le DSL des tables et ses relations", () => {
	const planner = new SchemaPlanner();
	const valid = contribution({
		schema: {
			name: "characters",
			columns: [
				{ name: "id", type: "uuid", primary: true, defaultValue: { kind: "uuid" } },
				{ name: "owner_id", type: "uuid", nullable: true },
				{ name: "active", type: "boolean", defaultValue: { kind: "literal", value: true } },
				{ name: "level", type: "integer", defaultValue: { kind: "literal", value: 1 } },
				{ name: "score", type: "bigint" },
				{ name: "ratio", type: "decimal", precision: 8, scale: 2 },
				{ name: "published_on", type: "date", defaultValue: { kind: "now" } },
				{ name: "updated_at", type: "timestamp", defaultValue: { kind: "now" } },
				{ name: "metadata", type: "json", defaultValue: { kind: "literal", value: {} } },
				{ name: "summary", type: "text" },
				{ name: "slug", type: "varchar", length: 160, unique: true },
			],
			indexes: [{ name: "characters_slug_idx", columns: ["slug"], unique: true }],
			foreignKeys: [
				{
					name: "characters_owner_fk",
					columns: ["owner_id"],
					targetTable: "users",
					targetColumns: ["id"],
					onDelete: "set-null",
				},
			],
		},
	});
	const plan = planner.plan(valid, undefined);
	const table = plan.operations[0].table;
	assert.equal(table.columns.length, 11);
	assert.equal(table.indexes[0].unique, true);
	assert.equal(table.foreignKeys[0].onDelete, "set-null");

	const invalidDefinitions = [
		{ columns: "invalid" },
		{ columns: [{ name: "id", type: "serial", primary: true }] },
		{ columns: [{ name: "id", type: "uuid", primary: "yes" }] },
		{
			columns: [
				{ name: "id", type: "uuid", primary: true },
				{ name: "title", type: "text", length: 160 },
			],
		},
		{
			columns: [
				{ name: "id", type: "uuid", primary: true },
				{ name: "ratio", type: "decimal", precision: 8, scale: -1 },
			],
		},
		{
			columns: [
				{ name: "id", type: "uuid", primary: true },
				{ name: "enabled", type: "boolean", defaultValue: { kind: "literal", value: "yes" } },
			],
		},
		{
			columns: [
				{ name: "id", type: "uuid", primary: true },
				{ name: "title", type: "text", defaultValue: { kind: "sql", value: "now()" } },
			],
		},
		{
			columns: [
				{ name: "id", type: "uuid", primary: true },
				{ name: "slug", type: "varchar", length: 10 },
			],
			indexes: [{ name: "characters_slug_idx", columns: ["slug", "slug"] }],
		},
		{
			columns: [
				{ name: "id", type: "uuid", primary: true },
				{ name: "owner_id", type: "uuid", nullable: false },
			],
			foreignKeys: [
				{
					name: "characters_owner_fk",
					columns: ["owner_id"],
					targetTable: "users",
					targetColumns: ["id"],
					onDelete: "set-null",
				},
			],
		},
		{
			columns: [{ name: "id", type: "uuid", primary: true }],
			foreignKeys: [
				{
					name: "characters_owner_fk",
					columns: ["id"],
					targetTable: "users",
					targetColumns: ["id"],
					onDelete: "execute",
				},
			],
		},
	];
	for (const [index, schema] of invalidDefinitions.entries()) {
		assert.throws(
			() => planner.plan(contribution({ schema: { name: `invalid_${index}`, ...schema } })),
			(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
		);
	}
	assert.throws(
		() => planner.plan(contribution({ owner: { kind: "unknown", identifier: "addon.invalid" } })),
		RegistryError,
	);
	assert.throws(() => planner.plan(contribution({ withdrawalPolicy: "truncate" })), RegistryError);
});

test("crée et inspecte une table à partir du DSL sans migration métier", async () => {
	const runtime = new InMemorySchemaRuntime();
	const manager = new DeclarativeSchemaManager(new CoreSchemaGateway(runtime));
	const result = await manager.deploy(contribution());

	assert.equal(result.plan.operations[0].kind, "create-table");
	assert.equal(result.journal.appliedState, "applied");
	assert.equal((await runtime.inspect("characters")).columns.length, 2);
	assert.match(result.plan.fingerprint, /^[a-f0-9]{64}$/);
});

test("journalise durablement le propriétaire, les états, le plan et les dates", async () => {
	const runtime = new InMemorySchemaRuntime();
	const manager = new DeclarativeSchemaManager(new CoreSchemaGateway(runtime));
	const result = await manager.deploy(contribution());
	const history = await manager.history(result.plan.contributionKey);

	assert.equal(history.length, 1);
	assert.equal(history[0].ownerKind, "addon");
	assert.equal(history[0].ownerIdentifier, owner.identifier);
	assert.equal(history[0].version, "1.0.0");
	assert.equal(history[0].fingerprint, result.plan.fingerprint);
	assert.equal(history[0].desiredState, "active");
	assert.equal(history[0].appliedState, "applied");
	assert.equal(history[0].observedState, "active");
	assert.equal(history[0].plan.id, result.plan.id);
	assert.ok(history[0].requestedAt instanceof Date);
	assert.ok(history[0].appliedAt instanceof Date);

	const migration = await readFile(
		new URL("../backend/core/migrations/009_core_schema_journal_owner.up.sql", import.meta.url),
		"utf8",
	);
	assert.match(migration, /ADD COLUMN IF NOT EXISTS owner_kind TEXT/);
	assert.match(migration, /owner_kind IN \('addon', 'core', 'instance', 'native-module'\)/);
	assert.doesNotMatch(migration, /\b(?:DROP TABLE|TRUNCATE)\b/i);
});

test("prévisualise un plan physique déterministe avant toute application", async () => {
	const runtime = new InMemorySchemaRuntime();
	const gateway = new CoreSchemaGateway(runtime);
	const manager = new DeclarativeSchemaManager(gateway);
	const initial = contribution();
	await manager.deploy(initial);

	const noOpPlan = await manager.preview(initial);
	assert.deepEqual(noOpPlan.operations, []);

	const reduced = contribution({
		version: "2.0.0",
		schema: {
			name: "characters",
			columns: [{ name: "id", type: "uuid", primary: true, defaultValue: { kind: "uuid" } }],
		},
	});
	const firstPreview = await manager.preview(reduced);
	const secondPreview = await manager.preview(reduced);

	assert.equal(firstPreview.destructive, true);
	assert.deepEqual(firstPreview.operations, [
		{ kind: "drop-index", table: "characters", index: "characters_title_idx" },
		{ kind: "drop-column", table: "characters", column: "title" },
	]);
	assert.deepEqual(firstPreview.operations, secondPreview.operations);
	assert.equal(firstPreview.fingerprint, secondPreview.fingerprint);
	assert.equal(
		(await runtime.inspect("characters")).columns.some((column) => column.name === "title"),
		true,
	);
	await assert.rejects(
		gateway.apply({ plan: firstPreview, destructiveApproved: false }),
		(error) => error instanceof CoreError && error.code === "authorization.denied",
	);
	assert.equal(
		(await runtime.inspect("characters")).columns.some((column) => column.name === "title"),
		true,
	);
});

test("planifie renommage, copie, remplissage, conversion, fusion et séparation", async () => {
	const runtime = new InMemorySchemaRuntime();
	const manager = new DeclarativeSchemaManager(new CoreSchemaGateway(runtime));
	await manager.deploy(contribution());
	const updated = contribution({
		version: "1.1.0",
		schema: {
			name: "characters",
			columns: [
				{ name: "id", type: "uuid", primary: true, defaultValue: { kind: "uuid" } },
				{ name: "name", type: "varchar", length: 160, nullable: false },
				{ name: "slug", type: "text", nullable: true },
				{ name: "display_name", type: "text", nullable: true },
				{ name: "first_name", type: "text", nullable: true },
				{ name: "last_name", type: "text", nullable: true },
			],
			transformations: [
				{ kind: "rename", from: "title", to: "name" },
				{ kind: "copy", from: "name", to: "slug", batchSize: 500 },
				{ kind: "fill", column: "display_name", value: "Inconnu" },
				{ kind: "convert", column: "slug", transformer: "text.lowercase" },
				{
					kind: "merge",
					sources: ["first_name", "last_name"],
					target: "display_name",
					separator: " ",
				},
				{
					kind: "split",
					source: "display_name",
					targets: ["first_name", "last_name"],
					separator: " ",
				},
			],
		},
	});
	const result = await manager.deploy(updated);
	const kinds = result.plan.operations.map((operation) => operation.kind);
	for (const expected of [
		"rename-column",
		"copy-column",
		"fill-column",
		"transform-column",
		"merge-columns",
		"split-column",
	]) {
		assert.ok(kinds.includes(expected));
	}
	assert.equal(
		(await runtime.inspect("characters")).columns.some((column) => column.name === "name"),
		true,
	);
});

test("refuse les transformations déclaratives incomplètes ou non enregistrées", () => {
	const planner = new SchemaPlanner();
	const invalidTransformations = [
		"invalid",
		{ kind: "unknown" },
		{ kind: "copy", from: "title", to: "title" },
		{ kind: "copy", from: "title", to: "slug", batchSize: "100" },
		{ kind: "fill", column: "title", value: undefined },
		{ kind: "convert", column: "title", transformer: "sql.execute" },
		{ kind: "merge", sources: ["title", "title"], target: "slug" },
		{ kind: "merge", sources: ["title", "slug"], target: "slug" },
		{ kind: "split", source: "title", targets: ["slug", "slug"], separator: "," },
		{ kind: "split", source: "title", targets: ["slug", "other"], separator: "" },
	];

	for (const transformation of invalidTransformations) {
		assert.throws(
			() =>
				planner.plan(
					contribution({
						schema: {
							...contribution().schema,
							transformations: [transformation],
						},
					}),
					undefined,
				),
			(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
		);
	}
});

test("répète une transformation par lots jusqu’à épuisement", async () => {
	const observed = {
		name: "characters",
		columns: [
			{
				name: "id",
				type: "uuid",
				nullable: false,
				unique: false,
				primary: true,
				defaultValue: { kind: "uuid" },
			},
			{
				name: "title",
				type: "varchar",
				length: 160,
				nullable: false,
				unique: false,
				primary: false,
			},
		],
		indexes: [{ name: "characters_title_idx", columns: ["title"], unique: false }],
		foreignKeys: [],
		archived: false,
	};
	const definition = contribution({
		version: "1.1.0",
		schema: {
			...contribution().schema,
			columns: [...contribution().schema.columns, { name: "slug", type: "text", nullable: true }],
			transformations: [{ kind: "copy", from: "title", to: "slug", batchSize: 2 }],
		},
	});
	const plan = new SchemaPlanner().plan(definition, observed);
	const batchRows = [2, 2, 0];
	let batchExecutions = 0;
	const database = {
		name: "core",
		async start() {},
		async stop() {},
		async health() {
			return "healthy";
		},
		async query(statement) {
			if (statement.text.includes("information_schema.columns")) return { rows: [], rowCount: 0 };
			return { rows: [], rowCount: 0 };
		},
		async transaction(operation) {
			return operation({
				async query(statement) {
					if (statement.text.includes("WITH batch AS")) {
						const rowCount = batchRows[batchExecutions++];
						return { rows: [], rowCount };
					}
					return { rows: [], rowCount: 0 };
				},
			});
		},
	};

	await new PostgresSchemaRuntime(database).apply(plan, decision(plan, plan.destructive));
	assert.equal(batchExecutions, 3);
});

test("refuse le SQL arbitraire et les changements destructeurs non approuvés", async () => {
	const planner = new SchemaPlanner();
	assert.throws(
		() => planner.plan(contribution({ schema: { name: "characters;drop", columns: [] } })),
		(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
	);
	const destructivePlan = planner.plan(
		contribution({
			schema: {
				name: "characters",
				columns: [{ name: "id", type: "uuid", primary: true }],
			},
		}),
		{
			name: "characters",
			columns: [
				{ name: "id", type: "uuid", nullable: false, unique: false, primary: true },
				{ name: "legacy", type: "text", nullable: true, unique: false, primary: false },
			],
			indexes: [],
			foreignKeys: [],
			archived: false,
		},
	);
	assert.equal(destructivePlan.destructive, true);
	const validPlan = planner.plan(contribution(), undefined);
	const create = validPlan.operations[0];
	await assert.rejects(
		new CoreSchemaGateway(new InMemorySchemaRuntime()).apply({
			plan: {
				...validPlan,
				operations: [
					{
						...create,
						table: {
							...create.table,
							columns: [{ ...create.table.columns[0], name: "id;drop_table" }],
						},
					},
				],
			},
			destructiveApproved: false,
		}),
		CoreError,
	);
});

test("applique les politiques de retrait", async () => {
	for (const [policy, expected] of [
		["archive", "archive-table"],
		["delete", "drop-table"],
		["preserve-data", undefined],
	]) {
		const runtime = new InMemorySchemaRuntime();
		const manager = new DeclarativeSchemaManager(new CoreSchemaGateway(runtime));
		const definition = contribution({ withdrawalPolicy: policy });
		await manager.deploy(definition);
		const result = await manager.withdraw(definition, policy === "delete");
		assert.equal(result.plan.operations[0]?.kind, expected);
	}
	const runtime = new InMemorySchemaRuntime();
	const manager = new DeclarativeSchemaManager(new CoreSchemaGateway(runtime));
	const blocked = contribution({ withdrawalPolicy: "block-uninstall" });
	await manager.deploy(blocked);
	await assert.rejects(
		manager.withdraw(blocked),
		(error) => error instanceof RegistryError && error.code === "registry.withdrawal_blocked",
	);
});

test("annule atomiquement une mise à jour interrompue et journalise la reprise", async () => {
	const runtime = new InMemorySchemaRuntime(1, 1);
	const manager = new DeclarativeSchemaManager(new CoreSchemaGateway(runtime));
	const initial = contribution();
	await manager.deploy(initial);
	const update = contribution({
		version: "1.1.0",
		schema: {
			name: "characters",
			columns: [
				{ name: "id", type: "uuid", primary: true, defaultValue: { kind: "uuid" } },
				{ name: "name", type: "text", nullable: false },
				{ name: "slug", type: "text", nullable: true },
			],
			transformations: [{ kind: "rename", from: "title", to: "name" }],
		},
	});
	await assert.rejects(manager.deploy(update, { allowDestructive: true }), CoreError);
	assert.equal(
		(await runtime.inspect("characters")).columns.some((column) => column.name === "title"),
		true,
	);
	assert.equal((await manager.history(initial.contributionKey)).at(-1).appliedState, "rolled-back");

	const recovered = await manager.deploy(update, { allowDestructive: true });
	assert.equal(recovered.journal.appliedState, "applied");
	assert.equal(
		(await runtime.inspect("characters")).columns.some((column) => column.name === "name"),
		true,
	);
	assert.equal(
		(await runtime.inspect("characters")).columns.some((column) => column.name === "title"),
		false,
	);
	assert.deepEqual(
		(await manager.history(initial.contributionKey)).map((entry) => entry.appliedState),
		["applied", "rolled-back", "applied"],
	);
});

test("lie chaque exécution à une décision Core et refuse altération, rejeu et dérive", async () => {
	const runtime = new InMemorySchemaRuntime();
	const gateway = new CoreSchemaGateway(runtime);
	const manager = new DeclarativeSchemaManager(gateway);
	const plan = await manager.preview(contribution());

	await assert.rejects(
		gateway.apply({
			plan: {
				...plan,
				operations: [...plan.operations, { kind: "drop-table", table: "characters" }],
			},
			destructiveApproved: true,
		}),
		(error) => error instanceof CoreError && error.code === "configuration.invalid",
	);
	await assert.rejects(
		runtime.apply(plan, { ...decision(plan), planIntegrity: "0".repeat(64) }),
		(error) => error instanceof CoreError && error.code === "authorization.denied",
	);

	const concurrent = await Promise.allSettled([
		gateway.apply({ plan, destructiveApproved: false }),
		gateway.apply({ plan, destructiveApproved: false }),
	]);
	assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
	const journal = (await manager.history(plan.contributionKey))[0];
	assert.equal(journal.planIntegrity, plan.integrity);
	assert.match(journal.decisionId, /^[0-9a-f-]{36}$/i);
	await assert.rejects(
		gateway.apply({ plan, destructiveApproved: false }),
		(error) => error instanceof CoreError && error.code === "lifecycle.invalid_state",
	);

	const staleRuntime = new InMemorySchemaRuntime();
	const staleGateway = new CoreSchemaGateway(staleRuntime);
	const staleManager = new DeclarativeSchemaManager(staleGateway);
	const stalePlan = await staleManager.preview(contribution());
	await staleManager.deploy(contribution());
	await assert.rejects(
		staleGateway.apply({ plan: stalePlan, destructiveApproved: false }),
		(error) => error instanceof CoreError && error.code === "lifecycle.invalid_state",
	);
});

test("compile un plan validé en SQL interne sans accepter de fragment addon", async () => {
	const statements = [];
	const database = {
		name: "core",
		async start() {},
		async stop() {},
		async health() {
			return "healthy";
		},
		async query(statement) {
			statements.push(statement);
			return { rows: [], rowCount: 0 };
		},
		async transaction(operation) {
			return operation({
				async query(statement) {
					statements.push(statement);
					return { rows: [], rowCount: 0 };
				},
			});
		},
	};
	const runtime = new PostgresSchemaRuntime(database);
	const plan = new SchemaPlanner().plan(contribution(), undefined);
	await new CoreSchemaGateway(runtime).apply({ plan, destructiveApproved: false });
	assert.ok(
		statements.some((statement) => statement.text.includes('CREATE TABLE cms_data."characters"')),
	);
	assert.ok(
		statements.some((statement) => statement.text.includes("core.contribution_schema_journal")),
	);
	assert.equal(
		statements.some((statement) => statement.text.includes(";drop")),
		false,
	);
});

test("la migration du moteur de schéma ne crée que le journal Core et le schéma de données", async () => {
	const migration = await readFile(
		new URL("../backend/core/migrations/005_core_schema_journal.up.sql", import.meta.url),
		"utf8",
	);
	assert.match(migration, /CREATE TABLE IF NOT EXISTS core\.contribution_schema_journal\b/);
	assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS core\.schema_journal\b/);
	assert.match(migration, /CREATE SCHEMA IF NOT EXISTS cms_data/);
	assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS cms_data\./);
	assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\b/i);
});

test("la fondation de messagerie Core est additive et couvre les états persistants", async () => {
	const migration = await readFile(
		new URL("../backend/core/migrations/006_core_messaging.up.sql", import.meta.url),
		"utf8",
	);
	for (const table of [
		"messaging_topics",
		"messaging_topic_versions",
		"messaging_messages",
		"messaging_audiences",
		"messaging_recipients",
		"messaging_outbox",
		"messaging_deliveries",
		"messaging_delivery_attempts",
		"messaging_acknowledgements",
		"messaging_dead_letters",
		"messaging_cursors",
		"notifications",
		"notification_user_states",
		"notification_preferences",
		"messaging_subscriptions",
		"messaging_presence",
	]) {
		assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS core\\.${table}\\b`));
	}
	assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\b/i);
});
