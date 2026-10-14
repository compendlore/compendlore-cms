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
			throw new CoreError("authorization.denied", "Access denied.");
		}
		if (grant.definition.requiresConsent && !grant.consentGranted) {
			throw new CoreError("authorization.denied", "Access denied.");
		}
		this.grants.set(grant.definition.ownerIdentifier, grant);
	}

	withdraw(ownerIdentifier: string): void {
		this.grants.delete(ownerIdentifier);
	}

	assertAllowed(ownerIdentifier: string, url: URL, method: ConnectorHttpMethod): void {
		const grant = this.grants.get(ownerIdentifier);
		if (!grant) throw new CoreError("network.denied", "Network access denied.");
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			(url.port && url.port !== "443")
		) {
			throw new CoreError("network.denied", "Network access denied.");
		}
		if (!grant.definition.domains.includes(url.hostname.toLowerCase())) {
			throw new CoreError("network.denied", "Network access denied.");
		}
		if (!grant.definition.methods.includes(method)) {
			throw new CoreError("network.denied", "Network access denied.");
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
		throw new CoreError("configuration.invalid", "Invalid configuration.");
	}
	if (definition.domains.length === 0 || definition.methods.length === 0) {
		throw new CoreError("configuration.invalid", "Invalid configuration.");
	}
	for (const domain of definition.domains) {
		if (!isPublicDomainName(domain)) {
			throw new CoreError("network.denied", "Network access denied.");
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
