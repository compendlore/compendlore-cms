import type { PageBundle, PageMaterializationPort } from "../../core/src/index.js";
import { contributionKey, type ContributionDefinition } from "./contracts.js";
import { RegistryError } from "./errors.js";

export function validatePageContribution(definition: ContributionDefinition): void {
	if (!definition.pages) return;
	if (definition.type !== "module" || definition.pages.pages.length === 0) throw invalid();
}

export async function materializePageContribution(
	definition: ContributionDefinition,
	port: PageMaterializationPort,
): Promise<void> {
	validatePageContribution(definition);
	if (!definition.pages) return;
	const sourceContributionKey = contributionKey(definition.type, definition.identifier);
	const pages: PageBundle = {
		sourceContributionKey,
		pages: definition.pages.pages.map((page) => ({
			...page,
			ownerContributionKey: sourceContributionKey,
		})),
	};
	await port.materializePages(pages);
}

function invalid(): RegistryError {
	return new RegistryError("registry.contract_invalid", "The page contribution is invalid.");
}
