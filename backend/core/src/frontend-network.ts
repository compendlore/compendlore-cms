import { CoreError } from "./errors.js";
import type { ConnectorHttpMethod, FrontendNetworkDefinition } from "./connector-contracts.js";

export const FRONTEND_NETWORK_CAPABILITY = "network.frontend";

export interface FrontendNetworkGrant {
	readonly definition: FrontendNetworkDefinition;
	readonly capabilityGranted: boolean;
	readonly consentGranted: boolean;
}

export class FrontendNetworkPolicy {
	private readonly grants = new Map<string, FrontendNetworkGrant>();

	register(grant: FrontendNetworkGrant): void {
		validateDefinition(grant.definition);
		if (!grant.capabilityGranted) {
			throw new CoreError(
				"authorization.denied",
				`La capacité ${FRONTEND_NETWORK_CAPABILITY} est requise.`,
			);
		}
		if (grant.definition.requiresConsent && !grant.consentGranted) {
			throw new CoreError(
				"authorization.denied",
				"Le consentement réseau est requis avant l’activation.",
			);
		}
		this.grants.set(grant.definition.ownerIdentifier, grant);
	}

	withdraw(ownerIdentifier: string): void {
		this.grants.delete(ownerIdentifier);
	}

	assertAllowed(ownerIdentifier: string, url: URL, method: ConnectorHttpMethod): void {
		const grant = this.grants.get(ownerIdentifier);
		if (!grant)
			throw new CoreError("network.denied", "Cet accès réseau frontend n’est pas déclaré.");
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			(url.port && url.port !== "443")
		) {
			throw new CoreError("network.denied", "La destination frontend n’est pas sûre.");
		}
		if (!grant.definition.domains.includes(url.hostname.toLowerCase())) {
			throw new CoreError("network.denied", "Le domaine frontend n’est pas déclaré.");
		}
		if (!grant.definition.methods.includes(method)) {
			throw new CoreError("network.denied", "La méthode frontend n’est pas déclarée.");
		}
	}

	contentSecurityPolicy(): string {
		const domains = new Set<string>();
		for (const grant of this.grants.values()) {
			for (const domain of grant.definition.domains) domains.add(`https://${domain}`);
		}
		return ["'self'", ...domains].join(" ");
	}

	publicCatalog(): readonly FrontendNetworkDefinition[] {
		return [...this.grants.values()]
			.map(({ definition }) => structuredClone(definition))
			.sort((first, second) => first.ownerIdentifier.localeCompare(second.ownerIdentifier));
	}
}

function validateDefinition(definition: FrontendNetworkDefinition): void {
	if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(definition.ownerIdentifier)) {
		throw new CoreError("configuration.invalid", "Le propriétaire réseau frontend est invalide.");
	}
	if (definition.domains.length === 0 || definition.methods.length === 0) {
		throw new CoreError(
			"configuration.invalid",
			"Les domaines et méthodes frontend sont obligatoires.",
		);
	}
	for (const domain of definition.domains) {
		if (!isPublicDomainName(domain)) {
			throw new CoreError("network.denied", "Un domaine frontend déclaré est invalide.");
		}
	}
}

function isPublicDomainName(value: string): boolean {
	return (
		value === value.toLowerCase() &&
		/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) &&
		!value.endsWith(".local") &&
		value !== "localhost"
	);
}
