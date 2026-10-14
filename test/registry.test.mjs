import assert from "node:assert/strict";
import test from "node:test";
import {
	CoreRegistryPort,
	CoreRegistryRuntime,
	InMemoryCoreStore,
} from "../backend/build/core/src/index.js";
import {
	contributionTypes,
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

function connectorDefinition(overrides = {}) {
	return {
		identifier: "official.library",
		baseUrl: "https://api.example.com/v1/",
		allowedDomains: ["api.example.com", "auth.example.com"],
		endpoints: [
			{
				identifier: "connection.health",
				path: "/health",
				method: "GET",
				successStatuses: [200, 204],
				response: { format: "json", requiredJsonPaths: ["status"] },
				maximumResponseBytes: 16_384,
				timeoutMs: 2_000,
				retries: 1,
			},
			{
				identifier: "catalog.read",
				path: "/catalog/:id",
				method: "GET",
				parameters: [
					{ name: "id", location: "path", required: true },
					{ name: "locale", location: "query" },
				],
				successStatuses: [200],
				response: { format: "json", requiredJsonPaths: ["id", "name"] },
				cacheTtlSeconds: 60,
			},
		],
		authentication: {
			kind: "oauth2",
			flow: "client-credentials",
			clientIdSecretReference: "env:CLIENT_ID",
			clientSecretReference: "env:CLIENT_SECRET",
			tokenEndpoint: "https://auth.example.com/oauth/token",
		},
		connectionTestEndpoint: "connection.health",
		quota: { limit: 100, windowSeconds: 60 },
		cacheTtlSeconds: 30,
		retries: 1,
		timeoutMs: 5_000,
		...overrides,
	};
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
	const inspection = await registry.inspect("module.editorial.content");
	assert.deepEqual(inspection.activationBlockers, []);
	assert.deepEqual(inspection.withdrawalBlockers, []);
	assert.deepEqual(inspection.blockers, []);
});

test("valide et expose un contrat de connecteur complet", async () => {
	const { registry } = await createRegistry();
	const definition = contribution("connector", "official.library", {
		connector: connectorDefinition(),
	});
	await registry.register(definition, { requester: nativeOwner });
	await registry.activate("connector.official.library", { requester: nativeOwner });
	const stored = await registry.get("connector.official.library");
	assert.equal(stored.connector.baseUrl, "https://api.example.com/v1/");
	assert.equal(stored.connector.endpoints.length, 2);
	assert.equal(stored.connector.connectionTestEndpoint, "connection.health");
	assert.deepEqual(stored.connector.quota, { limit: 100, windowSeconds: 60 });
});

test("valide le réseau frontend et interdit les secrets serveur", async () => {
	const { registry } = await createRegistry();
	const definition = contribution("frontend-network", "editorial.frontend-network", {
		requiredCapabilities: ["network.frontend"],
		frontendNetwork: {
			ownerIdentifier: nativeOwner.identifier,
			domains: ["assets.example.com"],
			methods: ["GET"],
			requiresConsent: true,
		},
	});
	await registry.register(definition, { requester: nativeOwner });
	const stored = await registry.get("frontend-network.editorial.frontend-network");
	assert.deepEqual(stored.frontendNetwork, definition.frontendNetwork);

	const invalidNetworks = [
		{ ...definition.frontendNetwork, secretReference: "env:SERVER_SECRET" },
		{ ...definition.frontendNetwork, ownerIdentifier: "addon.other" },
		{ ...definition.frontendNetwork, methods: ["TRACE"] },
		{ ...definition.frontendNetwork, requiresConsent: "yes" },
	];
	for (const [index, frontendNetwork] of invalidNetworks.entries()) {
		await assert.rejects(
			registry.register(
				contribution("frontend-network", `invalid.network-${index}`, {
					requiredCapabilities: ["network.frontend"],
					frontendNetwork,
				}),
				{ requester: nativeOwner },
			),
			{ code: "registry.contract_invalid" },
		);
	}
	await assert.rejects(
		registry.register(
			contribution("frontend-network", "missing.capability", {
				frontendNetwork: definition.frontendNetwork,
			}),
			{ requester: nativeOwner },
		),
		{ code: "registry.contract_invalid" },
	);
});

test("refuse les contrats de connecteur incomplets ou ambigus", async () => {
	const invalidConnectors = [
		connectorDefinition({ allowedDomains: ["api.example.com", "api.example.com"] }),
		connectorDefinition({ endpoints: [] }),
		connectorDefinition({
			endpoints: [
				{
					...connectorDefinition().endpoints[0],
					method: "TRACE",
				},
			],
		}),
		connectorDefinition({
			endpoints: [
				{
					...connectorDefinition().endpoints[0],
					response: { format: "xml" },
				},
			],
		}),
		connectorDefinition({
			endpoints: [
				{
					...connectorDefinition().endpoints[0],
					parameters: [{ name: "session", location: "cookie" }],
				},
			],
		}),
		connectorDefinition({
			endpoints: [
				{
					...connectorDefinition().endpoints[0],
					retrySafe: "yes",
				},
			],
		}),
		connectorDefinition({
			endpoints: [
				{
					...connectorDefinition().endpoints[0],
					parameters: [{ name: "tenant", location: "query", required: true }],
				},
			],
		}),
	];
	for (const [index, connector] of invalidConnectors.entries()) {
		const { registry } = await createRegistry();
		await assert.rejects(
			registry.register(contribution("connector", `invalid.connector-${index}`, { connector }), {
				requester: nativeOwner,
			}),
			(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
		);
	}
});

test("refuse les authentifications de connecteur invalides", async () => {
	const invalidAuthentications = [
		{ kind: "digest", secretReference: "env:SECRET" },
		{
			kind: "api-key",
			secretReference: "invalid reference",
			header: "X-API-Key",
		},
		{
			kind: "oauth2",
			flow: "implicit",
			clientIdSecretReference: "env:CLIENT_ID",
			tokenEndpoint: "https://auth.example.com/oauth/token",
		},
		{
			kind: "oauth2",
			flow: "client-credentials",
			clientIdSecretReference: "env:CLIENT_ID",
			tokenEndpoint: "https://auth.example.com/oauth/token",
		},
		{
			kind: "oauth2",
			flow: "client-credentials",
			clientIdSecretReference: "env:CLIENT_ID",
			clientSecretReference: "env:CLIENT_SECRET",
			tokenEndpoint: "https://outside.example.net/oauth/token",
		},
		{
			kind: "oauth2",
			flow: "client-credentials",
			clientIdSecretReference: "env:CLIENT_ID",
			clientSecretReference: "env:CLIENT_SECRET",
			tokenEndpoint: "https://auth.example.com/oauth/token",
			scopes: ["catalog.read", "catalog.read"],
		},
		{
			kind: "oauth2",
			flow: "device-code",
			clientIdSecretReference: "env:CLIENT_ID",
			tokenEndpoint: "https://auth.example.com/oauth/token",
			deviceAuthorizationEndpoint: "https://auth.example.com/oauth/device",
			scopes: ["invalid scope"],
		},
	];

	for (const [index, authentication] of invalidAuthentications.entries()) {
		const { registry } = await createRegistry();
		await assert.rejects(
			registry.register(
				contribution("connector", `invalid.authentication-${index}`, {
					connector: connectorDefinition({ authentication }),
				}),
				{ requester: nativeOwner },
			),
			(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
		);
	}
});

test("enregistre segments, actions et abonnements de messagerie", async () => {
	const { registry } = await createRegistry();
	const definitions = [
		contribution("message-segment", "editorial.active-readers", {
			messageSegment: {
				resolverMethodIdentifier: "editorial.segment.active-readers",
				maximumRecipients: 10_000,
				purpose: { en: "Targets active readers.", "fr-FR": "Cible les lecteurs actifs." },
			},
		}),
		contribution("message-action", "editorial.open-article", {
			messageAction: {
				methodIdentifier: "editorial.article.open",
				requiredCapability: "editorial.article.read",
				confirmationRequired: false,
			},
		}),
		contribution("message-subscription", "editorial.publications", {
			messageSubscription: {
				topicIdentifier: "editorial.article.published",
				defaultEnabled: true,
				userControllable: true,
			},
		}),
	];
	for (const definition of definitions) {
		await registry.discover(definition, { requester: nativeOwner });
		await registry.register(definition, { requester: nativeOwner });
		await registry.activate(`${definition.type}.${definition.identifier}`, {
			requester: nativeOwner,
		});
	}
	const catalog = await registry.catalog();
	assert.equal(catalog.byType["message-segment"].length, 1);
	assert.equal(catalog.byType["message-action"].length, 1);
	assert.equal(catalog.byType["message-subscription"].length, 1);
});

test("valide le modèle complet et les politiques d’une contribution", async () => {
	const { registry } = await createRegistry();
	const definition = contribution("module", "complete.contract", {
		dependencies: [
			{ contributionKey: "module.optional-source", optional: true, versionRange: "^2.1.0" },
		],
		requiredCapabilities: ["content.read", "content.write"],
		configuration: [
			{
				key: "display.mode",
				type: "string",
				defaultValue: "compact",
				allowedValues: ["compact", "comfortable"],
				description: { eo: "Vidiga reĝimo", "fr-FR": "Mode d’affichage" },
			},
		],
		translations: { eo: { "complete.title": "Kompleta modulo" } },
		withdrawalPolicy: "preserve-data",
		replacementPolicy: "forbidden",
	});

	const stored = await registry.register(definition, { requester: nativeOwner });
	assert.equal(stored.key, "module.complete.contract");
	assert.equal(stored.configuration[0].defaultValue, "compact");
	assert.equal(stored.translations.eo["complete.title"], "Kompleta modulo");

	for (const invalidDefinition of [
		contribution("unknown", "invalid.type"),
		contribution("module", "invalid.owner", {
			owner: { kind: "unknown", identifier: "native.editorial" },
		}),
		contribution("module", "invalid.withdrawal", { withdrawalPolicy: "unknown" }),
		contribution("module", "invalid.replacement", { replacementPolicy: "unknown" }),
		contribution("module", "invalid.dependencies", { dependencies: {} }),
		contribution("module", "invalid.capabilities", {
			requiredCapabilities: ["content.read", "content.read"],
		}),
		contribution("module", "invalid.configuration", {
			configuration: [
				{
					key: "display.enabled",
					type: "boolean",
					defaultValue: "yes",
					description: { en: "Display state" },
				},
			],
		}),
		contribution("translation", "invalid.translations", { translations: {} }),
	]) {
		await assert.rejects(
			registry.register(invalidDefinition, { requester: invalidDefinition.owner }),
			(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
		);
	}

	await registry.register(
		contribution("module", "replaceable", { replacementPolicy: "explicit" }),
		{ requester: nativeOwner },
	);
	const replacementOwner = { kind: "addon", identifier: "addon.replacement" };
	const replacement = await registry.register(
		contribution("module", "replaceable", {
			owner: replacementOwner,
			replacementPolicy: "explicit",
			replaces: "module.replaceable",
		}),
		{ requester: replacementOwner },
	);
	assert.deepEqual(replacement.owner, replacementOwner);
});

test("isole les propriétaires et protège leur autorité de mutation", async () => {
	const { registry } = await createRegistry();
	const mutableOwner = { kind: "addon", identifier: "addon.mutable" };
	const definition = contribution("module", "owned.resource", { owner: mutableOwner });
	const returned = await registry.register(definition, { requester: mutableOwner });

	mutableOwner.identifier = "addon.hijacked-input";
	returned.owner.identifier = "addon.hijacked-result";
	const firstRead = await registry.get("module.owned.resource");
	assert.deepEqual(firstRead.owner, { kind: "addon", identifier: "addon.mutable" });
	firstRead.owner.identifier = "addon.hijacked-read";
	assert.deepEqual((await registry.get("module.owned.resource")).owner, {
		kind: "addon",
		identifier: "addon.mutable",
	});

	await assert.rejects(
		registry.update(contribution("module", "owned.resource", { version: "1.1.0" }), {
			requester: nativeOwner,
		}),
		(error) => error instanceof RegistryError && error.code === "registry.owner_denied",
	);

	for (const [kind, identifier] of [
		["core", "core"],
		["instance", "instance.validation"],
		["native-module", "native.validation"],
	]) {
		const owner = { kind, identifier };
		await registry.register(contribution("module", `owner.${kind}`, { owner }), {
			requester: owner,
		});
	}
	await registry.activate("module.owner.core", { requester: { kind: "core", identifier: "core" } });
	await assert.rejects(
		registry.disable("module.owner.core", {
			requester: { kind: "core", identifier: "core" },
		}),
		(error) => error instanceof RegistryError && error.code === "registry.owner_denied",
	);
	await assert.rejects(
		registry.withdraw("module.owner.core", {
			requester: { kind: "core", identifier: "core" },
		}),
		(error) => error instanceof RegistryError && error.code === "registry.owner_denied",
	);
});

test("expose chaque registre initial sans mélanger les types de contribution", async () => {
	const { registry } = await createRegistry();
	const initialDefinitions = [
		contribution("module", "catalog.module"),
		contribution("method", "catalog.method", {
			method: { transaction: "none", timeoutMs: 1_000, idempotent: false },
		}),
		contribution("table", "catalog.table", { payload: { table: "catalog_items" } }),
		contribution("data-seed", "catalog.seed", { payload: { records: [] } }),
		contribution("permission", "catalog.permission", {
			payload: { capability: "catalog.read" },
		}),
		contribution("translation", "catalog.translation", {
			translations: { eo: { "catalog.title": "Katalogo" } },
		}),
		contribution("configuration", "catalog.configuration", {
			configuration: [
				{
					key: "catalog.enabled",
					type: "boolean",
					defaultValue: true,
					description: { en: "Enables the catalog." },
				},
			],
		}),
		contribution("event", "catalog.viewed", {
			statisticEvent: {
				schemaVersion: "1.0.0",
				purpose: { en: "Measure catalog usage." },
				sensitivity: "internal",
				retentionDays: 30,
				timestampSource: "core",
				fields: { duration: { type: "duration", required: true } },
				dimensionIdentifiers: ["catalog.section"],
			},
		}),
		contribution("dimension", "catalog.section", {
			statisticDimension: {
				valueType: "string",
				purpose: { en: "Catalog section." },
				sensitivity: "internal",
				cardinalityLimit: 100,
			},
		}),
		contribution("metric", "catalog.views", {
			statisticMetric: {
				kind: "counter",
				eventIdentifier: "catalog.viewed",
				unit: "view",
				aggregation: "count",
				granularities: ["day"],
				timezone: "UTC",
				dimensionIdentifiers: ["catalog.section"],
			},
		}),
		contribution("statistic-policy", "catalog.statistics", {
			statisticPolicy: {
				purposeIdentifier: "catalog.usage",
				consent: "not-required",
				enabledByDefault: true,
				sampleRate: 1,
				retentionDays: 30,
			},
		}),
	];

	for (const definition of initialDefinitions) {
		await registry.register(definition, { requester: nativeOwner });
	}
	const catalog = await registry.catalog();
	assert.deepEqual(Object.keys(catalog.byType).sort(), [...contributionTypes].sort());
	for (const definition of initialDefinitions) {
		assert.deepEqual(
			catalog.byType[definition.type].map((item) => item.identifier),
			[definition.identifier],
		);
	}
	assert.equal(catalog.contributions.length, initialDefinitions.length);
});

test("laisse le Core appeler une méthode métier sans importer son implémentation", async () => {
	const store = new InMemoryCoreStore();
	const core = new CoreRegistryPort(store);
	let transactions = 0;
	const registry = createInMemoryCmsRegistry({
		transaction(operation) {
			transactions += 1;
			return core.transaction(operation);
		},
		validateMutation: core.validateMutation.bind(core),
		authorizeMethodInvocation: core.authorizeMethodInvocation.bind(core),
		recordMutation: core.recordMutation.bind(core),
	});
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
	const transactionsBeforeInvocation = transactions;
	const invocation = {
		methodIdentifier: "editorial.generate-slug",
		input: "Mon Univers",
		actorId,
		idempotencyKey: "publication-42",
	};
	assert.equal(await runtime.invoke(invocation), "mon-univers");
	assert.equal(await runtime.invoke(invocation), "mon-univers");
	assert.equal(calls, 1);
	assert.equal(transactions - transactionsBeforeInvocation, 1);
	await assert.rejects(
		runtime.invoke({ ...invocation, input: "Un autre univers" }),
		(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
	);
	await assert.rejects(
		runtime.invoke({ ...invocation, actorId: "00000000-0000-4000-8000-000000000099" }),
		(error) => error instanceof RegistryError && error.code === "registry.capability_denied",
	);
});

test("sécurise les contrats, erreurs et délais du dispatcher de méthodes", async () => {
	const { registry } = await createRegistry();
	const registerMethod = async (identifier, contract, handler, activate = true) => {
		await registry.registerMethod(
			contribution("method", identifier, { method: contract }),
			handler,
			{ requester: nativeOwner },
		);
		if (activate) {
			await registry.activate(`method.${identifier}`, { requester: nativeOwner });
		}
	};
	const contract = { transaction: "none", timeoutMs: 1_000, idempotent: false };

	await assert.rejects(
		registry.registerMethod(
			contribution("method", "dispatcher.invalid-handler", { method: contract }),
			{ validateInput: () => true, validateOutput: () => true },
			{ requester: nativeOwner },
		),
		(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
	);
	assert.equal(await registry.get("method.dispatcher.invalid-handler"), undefined);

	await registerMethod(
		"dispatcher.inactive",
		contract,
		{
			validateInput: () => true,
			validateOutput: () => true,
			async execute() {
				return "inactive";
			},
		},
		false,
	);
	await assert.rejects(
		registry.invokeRegisteredMethod({ methodIdentifier: "dispatcher.inactive", input: null }),
		(error) => error instanceof RegistryError && error.code === "registry.method_not_found",
	);

	await registerMethod("dispatcher.invalid-input", contract, {
		validateInput() {
			throw new Error("validator detail");
		},
		validateOutput: () => true,
		async execute() {
			return "unreachable";
		},
	});
	await assert.rejects(
		registry.invokeRegisteredMethod({
			methodIdentifier: "dispatcher.invalid-input",
			input: "value",
		}),
		(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
	);

	await registerMethod("dispatcher.invalid-output", contract, {
		validateInput: () => true,
		validateOutput() {
			throw new Error("validator detail");
		},
		async execute() {
			return "value";
		},
	});
	await assert.rejects(
		registry.invokeRegisteredMethod({
			methodIdentifier: "dispatcher.invalid-output",
			input: "value",
		}),
		(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
	);

	await registerMethod("dispatcher.failed", contract, {
		validateInput: () => true,
		validateOutput: () => true,
		async execute() {
			throw new Error("private failure detail");
		},
	});
	await assert.rejects(
		registry.invokeRegisteredMethod({ methodIdentifier: "dispatcher.failed", input: null }),
		(error) =>
			error instanceof RegistryError &&
			error.code === "registry.method_failed" &&
			!error.message.includes("private failure detail"),
	);

	await registerMethod("dispatcher.non-idempotent", contract, {
		validateInput: () => true,
		validateOutput: () => true,
		async execute() {
			return "value";
		},
	});
	await assert.rejects(
		registry.invokeRegisteredMethod({
			methodIdentifier: "dispatcher.non-idempotent",
			input: null,
			idempotencyKey: "not-allowed",
		}),
		(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
	);

	let timeoutSignal;
	await registerMethod(
		"dispatcher.timeout",
		{ transaction: "none", timeoutMs: 5, idempotent: false },
		{
			validateInput: () => true,
			validateOutput: () => true,
			async execute(context) {
				timeoutSignal = context.signal;
				await new Promise((resolve) => setTimeout(resolve, 20));
				return "late";
			},
		},
	);
	await assert.rejects(
		registry.invokeRegisteredMethod({ methodIdentifier: "dispatcher.timeout", input: null }),
		(error) => error instanceof RegistryError && error.code === "registry.method_timeout",
	);
	assert.equal(timeoutSignal.aborted, true);
});

test("impose la validation et l’autorisation du Core sans accès privé", async () => {
	const store = new InMemoryCoreStore();
	const core = new CoreRegistryPort(store, 256);
	const registry = createInMemoryCmsRegistry(core);
	const oversized = contribution("module", "boundary.oversized", {
		payload: { content: "x".repeat(512) },
	});
	await assert.rejects(registry.register(oversized, { requester: nativeOwner }));
	assert.equal(await registry.get("module.boundary.oversized"), undefined);

	let authorizationCalls = 0;
	const guardCore = new CoreRegistryPort(store);
	const guardedRegistry = createInMemoryCmsRegistry({
		transaction: guardCore.transaction.bind(guardCore),
		validateMutation: guardCore.validateMutation.bind(guardCore),
		async authorizeMethodInvocation(request) {
			authorizationCalls += 1;
			assert.equal(request.contributionKey, "method.boundary.guarded");
			return false;
		},
		recordMutation: guardCore.recordMutation.bind(guardCore),
	});
	await guardedRegistry.registerMethod(
		contribution("method", "boundary.guarded", {
			method: { transaction: "none", timeoutMs: 1_000, idempotent: false },
		}),
		{
			validateInput: () => true,
			validateOutput: () => true,
			async execute() {
				return "must not execute";
			},
		},
		{ requester: nativeOwner },
	);
	await guardedRegistry.activate("method.boundary.guarded", { requester: nativeOwner });
	await assert.rejects(
		guardedRegistry.invokeRegisteredMethod({
			methodIdentifier: "boundary.guarded",
			input: null,
		}),
		(error) => error instanceof RegistryError && error.code === "registry.capability_denied",
	);
	assert.equal(authorizationCalls, 1);
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

test("inspecte le graphe et protège les dépendants actifs pendant les mises à jour", async () => {
	const { registry } = await createRegistry();
	await registry.register(contribution("module", "graph.provider", { version: "0.2.3" }), {
		requester: nativeOwner,
	});
	await registry.activate("module.graph.provider", { requester: nativeOwner });
	await registry.register(
		contribution("module", "graph.consumer", {
			dependencies: [
				{ contributionKey: "module.graph.provider", versionRange: "^0.2.0" },
				{ contributionKey: "module.graph.optional", optional: true },
			],
		}),
		{ requester: nativeOwner },
	);
	await registry.activate("module.graph.consumer", { requester: nativeOwner });

	const providerInspection = await registry.inspect("module.graph.provider");
	assert.deepEqual(providerInspection.dependencies, []);
	assert.deepEqual(providerInspection.dependents, ["module.graph.consumer"]);
	assert.deepEqual(providerInspection.activationBlockers, []);
	assert.deepEqual(providerInspection.withdrawalBlockers, ["module.graph.consumer"]);
	assert.deepEqual(providerInspection.blockers, ["module.graph.consumer"]);

	const consumerInspection = await registry.inspect("module.graph.consumer");
	assert.deepEqual(consumerInspection.dependencies, [
		"module.graph.optional",
		"module.graph.provider",
	]);
	assert.deepEqual(consumerInspection.activationBlockers, []);
	assert.deepEqual(consumerInspection.withdrawalBlockers, []);

	await assert.rejects(
		registry.update(contribution("module", "graph.provider", { version: "0.3.0" }), {
			requester: nativeOwner,
		}),
		(error) => error instanceof RegistryError && error.code === "registry.dependency_blocked",
	);
	assert.equal((await registry.get("module.graph.provider")).version, "0.2.3");

	await assert.rejects(
		registry.update(
			contribution("module", "graph.consumer", {
				version: "1.1.0",
				dependencies: [{ contributionKey: "module.graph.missing" }],
			}),
			{ requester: nativeOwner },
		),
		(error) => error instanceof RegistryError && error.code === "registry.dependency_blocked",
	);
	assert.equal((await registry.get("module.graph.consumer")).version, "1.0.0");

	await registry.register(
		contribution("module", "graph.incompatible", {
			dependencies: [{ contributionKey: "module.graph.provider", versionRange: "^0.3.0" }],
		}),
		{ requester: nativeOwner },
	);
	const incompatibleInspection = await registry.inspect("module.graph.incompatible");
	assert.deepEqual(incompatibleInspection.activationBlockers, ["module.graph.provider"]);
	await assert.rejects(
		registry.activate("module.graph.incompatible", { requester: nativeOwner }),
		(error) => error instanceof RegistryError && error.code === "registry.dependency_blocked",
	);
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

test("applique le cycle de vie complet et permet une réinstallation explicite", async () => {
	const { registry } = await createRegistry();
	const definition = contribution("module", "lifecycle.reinstall");

	assert.equal(
		(await registry.discover(definition, { requester: nativeOwner })).state,
		"discovered",
	);
	assert.equal(
		(await registry.register(definition, { requester: nativeOwner })).state,
		"registered",
	);
	assert.equal(
		(await registry.activate("module.lifecycle.reinstall", { requester: nativeOwner })).state,
		"active",
	);
	assert.equal(
		(await registry.disable("module.lifecycle.reinstall", { requester: nativeOwner })).state,
		"disabled",
	);
	assert.equal(
		(await registry.activate("module.lifecycle.reinstall", { requester: nativeOwner })).state,
		"active",
	);
	const failed = await registry.markFailed("module.lifecycle.reinstall", "Échec contrôlé", {
		requester: nativeOwner,
	});
	assert.equal(failed.state, "failed");
	assert.equal(failed.failureReason, "Échec contrôlé");
	const repaired = await registry.repair("module.lifecycle.reinstall", {
		requester: nativeOwner,
	});
	assert.equal(repaired.state, "registered");
	assert.equal(repaired.failureReason, undefined);
	await registry.activate("module.lifecycle.reinstall", { requester: nativeOwner });
	assert.equal(
		(await registry.withdraw("module.lifecycle.reinstall", { requester: nativeOwner })).state,
		"withdrawn",
	);
	await assert.rejects(
		registry.markFailed("module.lifecycle.reinstall", "Interdit", { requester: nativeOwner }),
		(error) => error instanceof RegistryError && error.code === "registry.invalid_state",
	);

	const reinstalled = await registry.reconcile([definition]);
	assert.deepEqual(reinstalled.registered, ["module.lifecycle.reinstall"]);
	assert.deepEqual(reinstalled.activated, ["module.lifecycle.reinstall"]);
	assert.deepEqual(reinstalled.failed, {});
	assert.equal((await registry.get("module.lifecycle.reinstall")).state, "active");
});

test("refuse les dérives de version et réconcilie les dépendances dans leur ordre", async () => {
	const { registry } = await createRegistry();
	const provider = contribution("module", "reconcile.provider");
	const consumer = contribution("module", "reconcile.consumer", {
		dependencies: [{ contributionKey: "module.reconcile.provider", versionRange: "^1.0.0" }],
	});
	const initial = await registry.reconcile([consumer, provider]);
	assert.deepEqual(initial.registered, ["module.reconcile.consumer", "module.reconcile.provider"]);
	assert.deepEqual(initial.activated, ["module.reconcile.provider", "module.reconcile.consumer"]);
	assert.deepEqual(initial.failed, {});

	const unchanged = await registry.reconcile([consumer, provider]);
	assert.deepEqual(unchanged, {
		registered: [],
		updated: [],
		activated: [],
		disabled: [],
		failed: {},
	});

	const drifted = await registry.reconcile([
		contribution("module", "reconcile.provider", {
			payload: { changedWithoutVersion: true },
		}),
		consumer,
	]);
	assert.match(drifted.failed["module.reconcile.provider"], /new version/i);
	assert.equal((await registry.get("module.reconcile.provider")).payload, undefined);

	const upgraded = await registry.reconcile([
		consumer,
		contribution("module", "reconcile.provider", { version: "1.1.0" }),
	]);
	assert.deepEqual(upgraded.updated, ["module.reconcile.provider"]);
	assert.deepEqual(upgraded.failed, {});
	const downgrade = await registry.reconcile([consumer, provider]);
	assert.match(downgrade.failed["module.reconcile.provider"], /cannot replace/i);
	assert.equal((await registry.get("module.reconcile.provider")).version, "1.1.0");

	const duplicate = await registry.reconcile([consumer, consumer]);
	assert.match(duplicate.failed["module.reconcile.consumer"], /more than once/i);

	const stopped = await registry.reconcile([]);
	assert.deepEqual(stopped.disabled, ["module.reconcile.consumer", "module.reconcile.provider"]);
	assert.deepEqual(stopped.failed, {});
	assert.equal((await registry.get("module.reconcile.consumer")).state, "disabled");
	assert.equal((await registry.get("module.reconcile.provider")).state, "disabled");
});

test("enregistre des contrats statistiques déclaratifs et refuse les données sensibles", async () => {
	const { registry } = await createRegistry();
	const event = contribution("event", "editorial.page-viewed", {
		statisticEvent: {
			schemaVersion: "1.0.0",
			purpose: { en: "Measure editorial page usage.", "fr-FR": "Mesurer l’usage des pages." },
			sensitivity: "internal",
			retentionDays: 90,
			timestampSource: "core",
			fields: {
				duration: { type: "duration", required: true },
			},
			dimensionIdentifiers: ["editorial.content-type"],
		},
	});
	await registry.register(event, { requester: nativeOwner });
	assert.equal(
		(await registry.get("event.editorial.page-viewed")).statisticEvent.retentionDays,
		90,
	);

	await assert.rejects(
		registry.register(
			contribution("event", "editorial.invalid-event", {
				statisticEvent: {
					schemaVersion: "1.0.0",
					purpose: { en: "Invalid event." },
					sensitivity: "restricted",
					retentionDays: 30,
					timestampSource: "core",
					fields: { email: { type: "string", required: true } },
				},
			}),
			{ requester: nativeOwner },
		),
		(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
	);
});

test("valide intégralement les contrats statistiques partagés", async () => {
	const { registry } = await createRegistry();
	const validEvent = {
		schemaVersion: "1.0.0",
		purpose: { en: "Measure page usage." },
		sensitivity: "internal",
		retentionDays: 30,
		timestampSource: "core",
		fields: { duration: { type: "duration", required: true } },
	};
	const invalidEvents = [
		{ ...validEvent, purpose: {} },
		{ ...validEvent, sensitivity: "secret" },
		{ ...validEvent, timestampSource: "browser" },
		{ ...validEvent, fields: { duration: { type: "decimal", required: true } } },
		{ ...validEvent, fields: { duration: { type: "duration", required: "yes" } } },
	];

	for (const [index, statisticEvent] of invalidEvents.entries()) {
		await assert.rejects(
			registry.register(
				contribution("event", `statistics.invalid-event-${index}`, { statisticEvent }),
				{ requester: nativeOwner },
			),
			(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
		);
	}

	for (const [index, [type, contract]] of [
		[
			"dimension",
			{
				statisticDimension: {
					valueType: "uuid",
					purpose: { en: "Invalid dimension." },
					sensitivity: "internal",
					cardinalityLimit: 10,
				},
			},
		],
		[
			"dimension",
			{
				statisticDimension: {
					valueType: "string",
					purpose: { en: "Invalid dimension." },
					sensitivity: "secret",
					cardinalityLimit: 10,
				},
			},
		],
		[
			"dimension",
			{
				statisticDimension: {
					valueType: "string",
					purpose: { en: "Invalid dimension." },
					sensitivity: "internal",
					cardinalityLimit: 10,
					pseudonymized: "yes",
				},
			},
		],
		[
			"metric",
			{
				statisticMetric: {
					kind: "total",
					eventIdentifier: "statistics.event",
					unit: "view",
					aggregation: "count",
					granularities: ["day"],
					timezone: "UTC",
				},
			},
		],
		...[
			{ unit: "not a unit" },
			{ aggregation: "median" },
			{ granularities: ["minute"] },
			{ timezone: "Europe/Paris" },
		].map((override) => [
			"metric",
			{
				statisticMetric: {
					kind: "counter",
					eventIdentifier: "statistics.event",
					unit: "view",
					aggregation: "count",
					granularities: ["day"],
					timezone: "UTC",
					...override,
				},
			},
		]),
		[
			"statistic-policy",
			{
				statisticPolicy: {
					purposeIdentifier: "statistics.usage",
					consent: "implicit",
					enabledByDefault: "yes",
					sampleRate: 1,
					retentionDays: 30,
				},
			},
		],
		[
			"statistic-policy",
			{
				statisticPolicy: {
					purposeIdentifier: "statistics.usage",
					consent: "opt-in",
					enabledByDefault: "yes",
					sampleRate: 1,
					retentionDays: 30,
				},
			},
		],
	].entries()) {
		await assert.rejects(
			registry.register(contribution(type, `statistics.invalid-contract-${index}`, contract), {
				requester: nativeOwner,
			}),
			(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
		);
	}
});

test("enregistre les sujets de message et borne les envois directs avec accusé", async () => {
	const { registry } = await createRegistry();
	const topic = contribution("message-topic", "editorial.save-confirmation", {
		messageTopic: {
			schemaVersion: "1.0.0",
			purpose: { en: "Confirm an editorial save.", "fr-FR": "Confirmer une sauvegarde." },
			sensitivity: "internal",
			profile: "direct-acknowledged",
			durability: "durable",
			acknowledgement: "processed",
			priority: "normal",
			audiences: ["user", "user-list"],
			presentations: ["toast", "inbox"],
			channels: ["realtime", "inbox"],
			payload: {
				resource: { type: "string", required: true, maximumLength: 160 },
			},
			idempotent: true,
			maximumRecipients: 25,
			expiresAfterSeconds: 300,
			retentionDays: 30,
		},
	});
	await registry.register(topic, { requester: nativeOwner });
	assert.equal(
		(await registry.get("message-topic.editorial.save-confirmation")).messageTopic.profile,
		"direct-acknowledged",
	);

	await assert.rejects(
		registry.register(
			contribution("message-topic", "editorial.invalid-broadcast", {
				messageTopic: {
					...topic.messageTopic,
					audiences: ["broadcast"],
					maximumRecipients: 1_000,
				},
			}),
			{ requester: nativeOwner },
		),
		(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
	);
});

test("valide intégralement les contrats de communication partagés", async () => {
	const { registry } = await createRegistry();
	const validTopic = {
		schemaVersion: "1.0.0",
		purpose: { en: "Notify one or more editors." },
		sensitivity: "internal",
		profile: "direct-acknowledged",
		durability: "durable",
		acknowledgement: "processed",
		priority: "normal",
		audiences: ["group", "user", "user-list"],
		presentations: ["toast"],
		channels: ["realtime"],
		payload: { resource: { type: "string", required: true, maximumLength: 160 } },
		idempotent: true,
		maximumRecipients: 100,
		retentionDays: 30,
	};
	await registry.register(
		contribution("message-topic", "communication.valid-group-direct", {
			messageTopic: validTopic,
		}),
		{ requester: nativeOwner },
	);

	const invalidTopics = [
		{ ...validTopic, sensitivity: "secret" },
		{ ...validTopic, durability: "forever" },
		{ ...validTopic, acknowledgement: "unknown" },
		{ ...validTopic, priority: "urgent" },
		{ ...validTopic, audiences: ["everyone"] },
		{ ...validTopic, presentations: ["dialog"] },
		{ ...validTopic, channels: ["email"] },
		{ ...validTopic, payload: { resource: { type: "uuid", required: true } } },
		{ ...validTopic, profile: "simple", acknowledgement: "read" },
		{ ...validTopic, acknowledgement: "none" },
	];
	for (const [index, messageTopic] of invalidTopics.entries()) {
		await assert.rejects(
			registry.register(
				contribution("message-topic", `communication.invalid-topic-${index}`, { messageTopic }),
				{ requester: nativeOwner },
			),
			(error) => error instanceof RegistryError && error.code === "registry.contract_invalid",
		);
	}
});

test("prépare les contributions transversales sans exposer leur implémentation privée", async () => {
	const { registry } = await createRegistry();
	const preparedTypes = ["entitlement", "page", "popup", "product", "route", "theme"];
	for (const type of preparedTypes) {
		await registry.register(
			contribution(type, `prepared.${type}`, {
				requiredCapabilities: [`${type}.read`],
				dependencies: [{ contributionKey: "module.prepared-owner", optional: true }],
				withdrawalPolicy: "preserve-data",
			}),
			{ requester: nativeOwner },
		);
	}

	const catalog = await registry.catalog();
	for (const type of preparedTypes) {
		assert.deepEqual(
			catalog.byType[type].map((item) => item.identifier),
			[`prepared.${type}`],
		);
		assert.equal(catalog.byType[type][0].payload, undefined);
	}
});
