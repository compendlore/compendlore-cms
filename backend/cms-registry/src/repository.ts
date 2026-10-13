import type { StoredContribution } from "./contracts.js";

export interface RegistryRepository {
	transaction<Result>(operation: () => Promise<Result>): Promise<Result>;
	get(key: string): Promise<StoredContribution | undefined>;
	list(): Promise<readonly StoredContribution[]>;
	set(contribution: StoredContribution): Promise<void>;
	delete(key: string): Promise<void>;
}

export class InMemoryRegistryRepository implements RegistryRepository {
	private contributions = new Map<string, StoredContribution>();

	async transaction<Result>(operation: () => Promise<Result>): Promise<Result> {
		const snapshot = new Map(
			[...this.contributions].map(([key, contribution]) => [key, clone(contribution)]),
		);
		try {
			return await operation();
		} catch (error) {
			this.contributions = snapshot;
			throw error;
		}
	}

	async get(key: string): Promise<StoredContribution | undefined> {
		const contribution = this.contributions.get(key);
		return contribution ? clone(contribution) : undefined;
	}

	async list(): Promise<readonly StoredContribution[]> {
		return [...this.contributions.values()]
			.map(clone)
			.sort((first, second) => first.key.localeCompare(second.key));
	}

	async set(contribution: StoredContribution): Promise<void> {
		this.contributions.set(contribution.key, clone(contribution));
	}

	async delete(key: string): Promise<void> {
		this.contributions.delete(key);
	}
}

function clone(contribution: StoredContribution): StoredContribution {
	return structuredClone(contribution);
}
