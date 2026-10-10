import assert from "node:assert/strict";
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

test("crée et inspecte une table à partir du DSL sans migration métier", async () => {
	const runtime = new InMemorySchemaRuntime();
	const manager = new DeclarativeSchemaManager(new CoreSchemaGateway(runtime));
	const result = await manager.deploy(contribution());

	assert.equal(result.plan.operations[0].kind, "create-table");
	assert.equal(result.journal.appliedState, "applied");
	assert.equal((await runtime.inspect("characters")).columns.length, 2);
	assert.match(result.plan.fingerprint, /^[a-f0-9]{64}$/);
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

test("refuse le SQL arbitraire et les changements destructeurs non approuvés", async () => {
	const planner = new SchemaPlanner();
	assert.throws(
		() => planner.plan(contribution({ schema: { name: "characters;drop", columns: [] } })),
		(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
	);
	assert.throws(
		() =>
			planner.plan(
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
			),
		(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
	);
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
	const runtime = new InMemorySchemaRuntime(1);
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
	assert.ok(statements.some((statement) => statement.text.includes("core.schema_journal")));
	assert.equal(
		statements.some((statement) => statement.text.includes(";drop")),
		false,
	);
});

test("la migration de phase 5 ne crée que le journal Core et le schéma de données", async () => {
	const migration = await readFile(
		new URL("../backend/core/migrations/005_core_schema_journal.up.sql", import.meta.url),
		"utf8",
	);
	assert.match(migration, /CREATE TABLE IF NOT EXISTS core\.schema_journal\b/);
	assert.match(migration, /CREATE SCHEMA IF NOT EXISTS cms_data/);
	assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS cms_data\./);
	assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\b/i);
});
