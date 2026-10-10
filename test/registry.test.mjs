import assert from "node:assert/strict";
import test from "node:test";
import {
	CoreRegistryPort,
	CoreRegistryRuntime,
	InMemoryCoreStore,
} from "../backend/build/core/src/index.js";
import {
	createInMemoryCmsRegistry,
	RegistryError,
} from "../backend/build/cms-registry/src/index.js";

const nativeOwner = { kind: "native-module", identifier: "native.editorial" };

function contribution(type, identifier, overrides = {}) {
	return {
		type,
		identifier,
		owner: nativeOwner,
		version: "1.0.0",
		withdrawalPolicy: "archive",
		replacementPolicy: "same-owner",
		...overrides,
	};
}

async function createRegistry() {
	const store = new InMemoryCoreStore();
	const registry = createInMemoryCmsRegistry(new CoreRegistryPort(store));
	return { store, registry };
}

test("enregistre, active et expose les contributions déclaratives", async () => {
	const { registry } = await createRegistry();
	const moduleDefinition = contribution("module", "editorial.content", {
		configuration: [
			{
				key: "publication.enabled",
				type: "boolean",
				defaultValue: true,
				description: { "fr-FR": "Active la publication.", en: "Enables publishing." },
			},
		],
		translations: {
			"fr-FR": { "editorial.title": "Contenu éditorial" },
			en: { "editorial.title": "Editorial content" },
		},
	});
	await registry.discover(moduleDefinition, { requester: nativeOwner });
	await registry.register(moduleDefinition, { requester: nativeOwner });
	await registry.activate("module.editorial.content", { requester: nativeOwner });

	const catalog = await registry.catalog();
	assert.equal(catalog.byType.module.length, 1);
	assert.equal(catalog.byType.module[0].state, "active");
	assert.deepEqual((await registry.inspect("module.editorial.content")).blockers, []);
});

test("laisse le Core appeler une méthode métier sans importer son implémentation", async () => {
	const { store, registry } = await createRegistry();
	const actorId = "00000000-0000-4000-8000-000000000041";
	await store.createUser({
		id: actorId,
		login: "registry-actor",
		displayName: "Registry Actor",
		passwordDigest: "unused",
		founder: false,
		active: true,
		createdAt: new Date("2026-10-10T00:00:00.000Z"),
	});
	await store.grantCapability(actorId, "editorial.slug.generate");
	let calls = 0;
	const definition = contribution("method", "editorial.generate-slug", {
		method: {
			requiredCapability: "editorial.slug.generate",
			transaction: "required",
			timeoutMs: 1_000,
			idempotent: true,
		},
	});
	await registry.registerMethod(
		definition,
		{
			validateInput: (value) => typeof value === "string",
			validateOutput: (value) => typeof value === "string",
			async execute(_context, input) {
				calls += 1;
				return input.toLowerCase().replaceAll(" ", "-");
			},
		},
		{ requester: nativeOwner },
	);
	await registry.activate("method.editorial.generate-slug", { requester: nativeOwner });
	const runtime = new CoreRegistryRuntime(registry);
	const invocation = {
		methodIdentifier: "editorial.generate-slug",
		input: "Mon Univers",
		actorId,
		idempotencyKey: "publication-42",
	};
	assert.equal(await runtime.invoke(invocation), "mon-univers");
	assert.equal(await runtime.invoke(invocation), "mon-univers");
	assert.equal(calls, 1);
	await assert.rejects(
		runtime.invoke({ ...invocation, actorId: "00000000-0000-4000-8000-000000000099" }),
		(error) => error instanceof RegistryError && error.code === "registry.capability_denied",
	);
});

test("bloque les collisions, les cycles et les retraits dangereux", async () => {
	const { registry } = await createRegistry();
	await registry.register(contribution("module", "maps"), { requester: nativeOwner });
	await registry.activate("module.maps", { requester: nativeOwner });
	const extension = contribution("module", "dungeons", {
		dependencies: [{ contributionKey: "module.maps", versionRange: "^1.0.0" }],
	});
	await registry.register(extension, { requester: nativeOwner });
	await registry.activate("module.dungeons", { requester: nativeOwner });
	await assert.rejects(
		registry.disable("module.maps", { requester: nativeOwner }),
		(error) => error instanceof RegistryError && error.code === "registry.withdrawal_blocked",
	);
	await assert.rejects(
		registry.register(
			contribution("module", "maps", { owner: { kind: "addon", identifier: "other.maps" } }),
			{
				requester: { kind: "addon", identifier: "other.maps" },
			},
		),
		(error) => error instanceof RegistryError && error.code === "registry.collision",
	);

	const first = contribution("module", "cycle.first", {
		dependencies: [{ contributionKey: "module.cycle.second" }],
	});
	const second = contribution("module", "cycle.second", {
		dependencies: [{ contributionKey: "module.cycle.first" }],
	});
	await registry.register(first, { requester: nativeOwner });
	await assert.rejects(
		registry.register(second, { requester: nativeOwner }),
		(error) => error instanceof RegistryError && error.code === "registry.dependency_cycle",
	);
	assert.equal(await registry.get("module.cycle.second"), undefined);
});

test("refuse une déclaration invalide avant toute persistance", async () => {
	const { registry } = await createRegistry();
	await assert.rejects(
		registry.register(
			contribution("configuration", "invalid.number", {
				payload: { threshold: Number.NaN },
			}),
			{ requester: nativeOwner },
		),
		(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
	);
	assert.equal(await registry.get("configuration.invalid.number"), undefined);
});

test("réconcilie un redémarrage et conserve une contribution en échec réparable", async () => {
	const { registry } = await createRegistry();
	const firstVersion = contribution("module", "search");
	const initial = await registry.reconcile([firstVersion]);
	assert.deepEqual(initial.registered, ["module.search"]);
	assert.deepEqual(initial.activated, ["module.search"]);

	await registry.markFailed("module.search", "Index incomplet", { requester: nativeOwner });
	assert.equal((await registry.get("module.search")).failureReason, "Index incomplet");
	await registry.repair("module.search", { requester: nativeOwner });
	assert.equal((await registry.get("module.search")).failureReason, undefined);

	const secondVersion = contribution("module", "search", { version: "1.1.0" });
	const restarted = await registry.reconcile([secondVersion]);
	assert.deepEqual(restarted.updated, ["module.search"]);
	assert.deepEqual(restarted.activated, ["module.search"]);
	assert.equal((await registry.get("module.search")).version, "1.1.0");
});
