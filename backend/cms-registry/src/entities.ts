import type {
	EntityCatalogMaterializationPort,
	EntityEcosystemBundle,
	EntityEcosystemMaterializationPort,
} from "../../core/src/index.js";
import { contributionKey, type ContributionDefinition } from "./contracts.js";
import { RegistryError } from "./errors.js";

export function validateEntityCatalogContribution(definition: ContributionDefinition): void {
	if (!definition.entities) return;
	if (definition.type !== "module") throw invalid();
	if (
		!definition.entities.fieldTypes?.length &&
		!definition.entities.entityTypes?.length &&
		!definition.entities.ecosystem
	) {
		throw invalid();
	}
}

export async function materializeEntityCatalogContribution(
	definition: ContributionDefinition,
	port: EntityCatalogMaterializationPort,
	ecosystemPort?: EntityEcosystemMaterializationPort,
): Promise<void> {
	validateEntityCatalogContribution(definition);
	if (!definition.entities) return;
	const sourceContributionKey = contributionKey(definition.type, definition.identifier);
	await port.materializeEntityCatalog({
		sourceContributionKey,
		fieldTypes: (definition.entities.fieldTypes ?? []).map((fieldType) => ({
			...fieldType,
			ownerContributionKey: sourceContributionKey,
		})),
		entityTypes: (definition.entities.entityTypes ?? []).map((entityType) => ({
			...entityType,
			ownerContributionKey: sourceContributionKey,
		})),
	});
	if (definition.entities.ecosystem) {
		if (!ecosystemPort) throw invalid();
		await ecosystemPort.materializeEntityEcosystem(
			withEntityEcosystemOwner(definition.entities.ecosystem, sourceContributionKey),
		);
	}
}

function withEntityEcosystemOwner(
	ecosystem: Omit<EntityEcosystemBundle, "sourceContributionKey">,
	sourceContributionKey: string,
): EntityEcosystemBundle {
	const own = <T extends { readonly ownerContributionKey: string }>(definitions: readonly T[]) =>
		definitions.map((definition) => ({
			...definition,
			ownerContributionKey: sourceContributionKey,
		}));
	return {
		sourceContributionKey,
		...(ecosystem.choices ? { choices: own(ecosystem.choices) } : {}),
		...(ecosystem.fieldExtensions ? { fieldExtensions: own(ecosystem.fieldExtensions) } : {}),
		...(ecosystem.relations ? { relations: own(ecosystem.relations) } : {}),
		...(ecosystem.projections ? { projections: own(ecosystem.projections) } : {}),
		...(ecosystem.interfaces ? { interfaces: own(ecosystem.interfaces) } : {}),
		...(ecosystem.measurements ? { measurements: own(ecosystem.measurements) } : {}),
		...(ecosystem.measurementUnits ? { measurementUnits: own(ecosystem.measurementUnits) } : {}),
		...(ecosystem.vocabularies ? { vocabularies: own(ecosystem.vocabularies) } : {}),
		...(ecosystem.terms ? { terms: own(ecosystem.terms) } : {}),
	};
}

function invalid(): RegistryError {
	return new RegistryError(
		"registry.contract_invalid",
		"The entity catalog contribution is invalid.",
	);
}
