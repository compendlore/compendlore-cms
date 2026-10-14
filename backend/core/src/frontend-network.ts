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
		if (typeof grant.capabilityGranted !== "boolean" || typeof grant.consentGranted !== "boolean") {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		if (!grant.capabilityGranted) {
			throw new CoreError("authorization.denied", "Access denied.");
		}
		if (grant.definition.requiresConsent && !grant.consentGranted) {
			throw new CoreError("authorization.denied", "Access denied.");
		}
		const definition = canonicalDefinition(grant.definition);
		this.grants.set(definition.ownerIdentifier, {
			definition,
			capabilityGranted: true,
			consentGranted: grant.consentGranted,
		});
	}

	withdraw(ownerIdentifier: string): void {
		assertOwnerIdentifier(ownerIdentifier);
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
	if (!isRecord(definition)) {
		throw new CoreError("configuration.invalid", "Invalid configuration.");
	}
	const keys = Object.keys(definition).sort();
	const expectedKeys = ["domains", "methods", "ownerIdentifier", "requiresConsent"];
	if (
		keys.length !== expectedKeys.length ||
		keys.some((key, index) => key !== expectedKeys[index])
	) {
		throw new CoreError("configuration.invalid", "Invalid configuration.");
	}
	assertOwnerIdentifier(definition.ownerIdentifier);
	if (
		!Array.isArray(definition.domains) ||
		definition.domains.length === 0 ||
		definition.domains.length > 32 ||
		new Set(definition.domains).size !== definition.domains.length ||
		!Array.isArray(definition.methods) ||
		definition.methods.length === 0 ||
		new Set(definition.methods).size !== definition.methods.length ||
		typeof definition.requiresConsent !== "boolean"
	) {
		throw new CoreError("configuration.invalid", "Invalid configuration.");
	}
	for (const domain of definition.domains) {
		if (typeof domain !== "string" || !isPublicDomainName(domain)) {
			throw new CoreError("network.denied", "Network access denied.");
		}
	}
	for (const method of definition.methods) {
		if (!(["DELETE", "GET", "PATCH", "POST", "PUT"] as const).includes(method)) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
	}
}

function canonicalDefinition(definition: FrontendNetworkDefinition): FrontendNetworkDefinition {
	return Object.freeze({
		ownerIdentifier: definition.ownerIdentifier,
		domains: Object.freeze([...definition.domains]),
		methods: Object.freeze([...definition.methods]),
		requiresConsent: definition.requiresConsent,
	});
}

function assertOwnerIdentifier(value: unknown): asserts value is string {
	if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)) {
		throw new CoreError("configuration.invalid", "Invalid configuration.");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPublicDomainName(value: string): boolean {
	return (
		value === value.toLowerCase() &&
		/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) &&
		!value.endsWith(".local") &&
		value !== "localhost"
	);
}
