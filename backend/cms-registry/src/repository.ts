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
		const snapshot = new Map(this.contributions);
		try {
			return await operation();
		} catch (error) {
			this.contributions = snapshot;
			throw error;
		}
	}

	async get(key: string): Promise<StoredContribution | undefined> {
		return this.contributions.get(key);
	}

	async list(): Promise<readonly StoredContribution[]> {
		return [...this.contributions.values()].sort((first, second) =>
			first.key.localeCompare(second.key),
		);
	}

	async set(contribution: StoredContribution): Promise<void> {
		this.contributions.set(contribution.key, contribution);
	}

	async delete(key: string): Promise<void> {
		this.contributions.delete(key);
	}
}
