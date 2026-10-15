import type { PageMaterializationPort } from "../../core/src/index.js";
import type { ContributionDefinition, ContributionOwner } from "./contracts.js";
import type { RegisteredMethodHandler } from "./dispatcher.js";
import type { CmsRegistry } from "./registry.js";
import { DeclarativeSchemaManager, type TableSchemaContribution } from "./schema.js";
import { materializePageContribution } from "./pages.js";

export const proofAddonOwner = Object.freeze({
	kind: "addon",
	identifier: "proof.notes",
} satisfies ContributionOwner);

export interface ProofAddonDefinitionSet {
	readonly module: ContributionDefinition;
	readonly table: ContributionDefinition;
	readonly method: ContributionDefinition;
	readonly tableSchema: TableSchemaContribution;
}

export class ProofAddonLifecycle {
	constructor(
		private readonly registry: CmsRegistry,
		private readonly schema: DeclarativeSchemaManager,
		private readonly pages: PageMaterializationPort,
	) {}

	async install(version = "1.0.0"): Promise<void> {
		const definitions = proofAddonDefinitions(version);
		const context = { requester: proofAddonOwner };
		const module = await this.registry.register(definitions.module, context);
		await this.registry.register(definitions.table, context);
		await this.registry.registerMethod(definitions.method, proofMethodHandler, context);
		await this.schema.deploy(definitions.tableSchema);
		await materializePageContribution(module, this.pages);
		await this.registry.activate(module.key, context);
		await this.registry.activate("table.proof.notes", context);
		await this.registry.activate("method.proof.notes.echo", context);
	}

	async update(version: string): Promise<void> {
		const definitions = proofAddonDefinitions(version);
		const context = { requester: proofAddonOwner };
		const module = await this.registry.update(definitions.module, context);
		await this.registry.update(definitions.table, context);
		await this.registry.update(definitions.method, context);
		await this.schema.deploy(definitions.tableSchema);
		await materializePageContribution(module, this.pages);
	}

	async disable(): Promise<void> {
		const context = { requester: proofAddonOwner };
		await this.registry.disable("method.proof.notes.echo", context);
		await this.registry.disable("table.proof.notes", context);
		await this.registry.disable("module.proof.notes", context);
	}

	async withdraw(): Promise<void> {
		const definitions = proofAddonDefinitions(
			(await this.registry.get("table.proof.notes"))?.version ?? "1.0.0",
		);
		const context = { requester: proofAddonOwner };
		await this.schema.withdraw(definitions.tableSchema);
		await this.registry.withdraw("method.proof.notes.echo", context);
		await this.registry.withdraw("table.proof.notes", context);
		await this.registry.withdraw("module.proof.notes", context);
	}
}

export function proofAddonDefinitions(version: string): ProofAddonDefinitionSet {
	const dependency = Object.freeze({ contributionKey: "module.proof.notes" });
	const module: ContributionDefinition = {
		type: "module",
		identifier: "proof.notes",
		owner: proofAddonOwner,
		version,
		withdrawalPolicy: "archive",
		replacementPolicy: "same-owner",
		pages: {
			pages: [
				{
					identifier: "proof.notes",
					ownerContributionKey: "module.proof.notes",
					version,
					surface: "site",
					path: "/proof-notes",
					component: "proof.notes",
					titleResource: "proof.notes.title",
					content: [
						{
							kind: "card",
							titleResource: "proof.notes.card.title",
							descriptionResource: "proof.notes.card.description",
						},
					],
					requiredCapabilities: [],
					lifecycle: { canDisable: true, canArchive: true, canDelete: false },
					exportPolicy: "exportable",
					enabledByDefault: true,
				},
			],
		},
	};
	const table: ContributionDefinition = {
		type: "table",
		identifier: "proof.notes",
		owner: proofAddonOwner,
		version,
		dependencies: [dependency],
		withdrawalPolicy: "archive",
		replacementPolicy: "same-owner",
		payload: { resource: "proof_notes" },
	};
	const method: ContributionDefinition = {
		type: "method",
		identifier: "proof.notes.echo",
		owner: proofAddonOwner,
		version,
		dependencies: [dependency],
		withdrawalPolicy: "archive",
		replacementPolicy: "same-owner",
		method: {
			transaction: "none",
			timeoutMs: 1_000,
			idempotent: true,
		},
	};
	const tableSchema: TableSchemaContribution = {
		contributionKey: "table.proof.notes",
		owner: proofAddonOwner,
		version,
		withdrawalPolicy: "archive",
		schema: {
			name: "proof_notes",
			columns: [
				{ name: "id", type: "uuid", primary: true, defaultValue: { kind: "uuid" } },
				{ name: "title", type: "varchar", length: 160, nullable: false },
				...(version === "1.0.0"
					? []
					: [{ name: "summary", type: "text" as const, nullable: true }]),
			],
			indexes: [{ name: "proof_notes_title_idx", columns: ["title"] }],
		},
	};
	return { module, table, method, tableSchema };
}

const proofMethodHandler: RegisteredMethodHandler = {
	validateInput(value) {
		return Boolean(value && typeof value === "object" && !Array.isArray(value));
	},
	validateOutput(value) {
		return Boolean(value && typeof value === "object" && !Array.isArray(value));
	},
	async execute(context, input) {
		return { input, version: context.contribution.version };
	},
};
