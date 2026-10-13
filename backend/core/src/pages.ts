import { CoreError } from "./errors.js";
import type { LocalizationContext, LocalizationEngine } from "./localization.js";

export interface PageDefinition {
	readonly identifier: string;
	readonly contributionKey: string;
	readonly route: string;
	readonly surface: "account" | "administration" | "site";
	readonly titleTextIdentifier: string;
	readonly descriptionTextIdentifier?: string;
	readonly requiredCapabilities: readonly string[];
	readonly editable: boolean;
	readonly removable: boolean;
	readonly published: boolean;
}

export interface ResolvedPage {
	readonly identifier: string;
	readonly route: string;
	readonly surface: PageDefinition["surface"];
	readonly title: string;
	readonly description?: string;
	readonly contributionKey: string;
	readonly editable: boolean;
	readonly removable: boolean;
}

export class PageCatalog {
	private readonly pages = new Map<string, PageDefinition>();

	constructor(private readonly localization: LocalizationEngine) {}

	register(definition: PageDefinition): void {
		if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(definition.identifier)) {
			invalid(`L’identifiant de page ${definition.identifier} est invalide.`);
		}
		if (!definition.route.startsWith("/") || definition.route.includes("//")) {
			invalid(`La route ${definition.route} est invalide.`);
		}
		const collision = [...this.pages.values()].find(
			(page) => page.route === definition.route && page.identifier !== definition.identifier,
		);
		if (collision)
			invalid(`La route ${definition.route} appartient déjà à ${collision.identifier}.`);
		this.pages.set(definition.identifier, Object.freeze({ ...definition }));
	}

	resolve(
		route: string,
		capabilities: ReadonlySet<string>,
		context: LocalizationContext,
	): ResolvedPage | undefined {
		const page = [...this.pages.values()].find(
			(candidate) => candidate.route === route && candidate.published,
		);
		if (!page || !page.requiredCapabilities.every((capability) => capabilities.has(capability))) {
			return undefined;
		}
		return {
			identifier: page.identifier,
			route: page.route,
			surface: page.surface,
			title: this.localization.resolve(page.titleTextIdentifier, context).value,
			...(page.descriptionTextIdentifier
				? { description: this.localization.resolve(page.descriptionTextIdentifier, context).value }
				: {}),
			contributionKey: page.contributionKey,
			editable: page.editable,
			removable: page.removable,
		};
	}

	list(): readonly PageDefinition[] {
		return [...this.pages.values()].sort((left, right) => left.route.localeCompare(right.route));
	}
}

function invalid(message: string): never {
	throw new CoreError("configuration.invalid", message);
}
