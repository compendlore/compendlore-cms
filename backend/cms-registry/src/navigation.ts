import type { NavigationBundle, NavigationMaterializationPort } from "../../core/src/index.js";
import { contributionKey, type ContributionDefinition } from "./contracts.js";
import { RegistryError } from "./errors.js";

export function validateNavigationContribution(definition: ContributionDefinition): void {
	if (!definition.navigation) return;
	if (definition.type !== "module") throw invalid();
	if (
		!definition.navigation.modes?.length &&
		!definition.navigation.targetTypes?.length &&
		!definition.navigation.actions?.length &&
		!definition.navigation.targets?.length &&
		!definition.navigation.links?.length &&
		!definition.navigation.sidebars?.length &&
		!definition.navigation.sidebarItems?.length &&
		!definition.navigation.navigationItems?.length
	) {
		throw invalid();
	}
}

export async function materializeNavigationContribution(
	definition: ContributionDefinition,
	port: NavigationMaterializationPort,
): Promise<void> {
	validateNavigationContribution(definition);
	if (!definition.navigation) return;
	const sourceContributionKey = contributionKey(definition.type, definition.identifier);
	await port.materializeNavigation(
		withNavigationOwner(definition.navigation, sourceContributionKey),
	);
}

function withNavigationOwner(
	navigation: NonNullable<ContributionDefinition["navigation"]>,
	sourceContributionKey: string,
): NavigationBundle {
	const own = <T extends { readonly ownerContributionKey: string }>(definitions: readonly T[]) =>
		definitions.map((definition) => ({
			...definition,
			ownerContributionKey: sourceContributionKey,
		}));
	return {
		sourceContributionKey,
		...(navigation.modes ? { modes: own(navigation.modes) } : {}),
		...(navigation.targetTypes ? { targetTypes: own(navigation.targetTypes) } : {}),
		...(navigation.actions ? { actions: own(navigation.actions) } : {}),
		...(navigation.targets ? { targets: own(navigation.targets) } : {}),
		...(navigation.links ? { links: own(navigation.links) } : {}),
		...(navigation.sidebars ? { sidebars: own(navigation.sidebars) } : {}),
		...(navigation.sidebarItems ? { sidebarItems: own(navigation.sidebarItems) } : {}),
		...(navigation.navigationItems ? { navigationItems: own(navigation.navigationItems) } : {}),
	};
}

function invalid(): RegistryError {
	return new RegistryError("registry.contract_invalid", "The navigation contribution is invalid.");
}
