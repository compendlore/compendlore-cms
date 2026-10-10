import type {
	ContributionDependency,
	ContributionInspection,
	StoredContribution,
} from "./contracts.js";
import { RegistryError } from "./errors.js";
import { compareSemver } from "./validation.js";

export class ContributionGraph {
	private readonly contributions: ReadonlyMap<string, StoredContribution>;

	constructor(contributions: readonly StoredContribution[]) {
		this.contributions = new Map(
			contributions.map((contribution) => [contribution.key, contribution]),
		);
	}

	assertAcyclic(): void {
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (key: string, path: readonly string[]): void => {
			if (visiting.has(key)) {
				throw new RegistryError(
					"registry.dependency_cycle",
					`Cycle de dépendances détecté : ${[...path, key].join(" -> ")}.`,
				);
			}
			if (visited.has(key)) return;
			visiting.add(key);
			const contribution = this.contributions.get(key);
			for (const dependency of contribution?.dependencies ?? []) {
				if (this.contributions.has(dependency.contributionKey)) {
					visit(dependency.contributionKey, [...path, key]);
				}
			}
			visiting.delete(key);
			visited.add(key);
		};
		for (const key of this.contributions.keys()) visit(key, []);
	}

	activationBlockers(key: string): readonly string[] {
		const contribution = this.require(key);
		return (contribution.dependencies ?? [])
			.filter((dependency) => !this.dependencyIsSatisfied(dependency))
			.filter((dependency) => !dependency.optional)
			.map((dependency) => dependency.contributionKey);
	}

	withdrawalBlockers(key: string): readonly string[] {
		return [...this.contributions.values()]
			.filter((candidate) => candidate.state === "active")
			.filter((candidate) =>
				(candidate.dependencies ?? []).some(
					(dependency) => dependency.contributionKey === key && !dependency.optional,
				),
			)
			.map((candidate) => candidate.key)
			.sort();
	}

	inspect(key: string): ContributionInspection {
		const contribution = this.require(key);
		const dependencies = (contribution.dependencies ?? [])
			.map((dependency) => dependency.contributionKey)
			.sort();
		const dependents = [...this.contributions.values()]
			.filter((candidate) =>
				(candidate.dependencies ?? []).some((dependency) => dependency.contributionKey === key),
			)
			.map((candidate) => candidate.key)
			.sort();
		return {
			contribution,
			dependencies,
			dependents,
			blockers: this.activationBlockers(key),
		};
	}

	private dependencyIsSatisfied(dependency: ContributionDependency): boolean {
		const target = this.contributions.get(dependency.contributionKey);
		return (
			target?.state === "active" &&
			(!dependency.versionRange || satisfiesVersion(target.version, dependency.versionRange))
		);
	}

	private require(key: string): StoredContribution {
		const contribution = this.contributions.get(key);
		if (!contribution) {
			throw new RegistryError(
				"registry.dependency_blocked",
				`La contribution ${key} est introuvable.`,
			);
		}
		return contribution;
	}
}

export function satisfiesVersion(version: string, range: string): boolean {
	const normalized = range.trim();
	if (
		/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
			normalized,
		)
	) {
		return compareSemver(version, normalized) === 0;
	}
	const match =
		/^(\^|~|>=|>)\s*((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(
			normalized,
		);
	if (!match) {
		throw new RegistryError(
			"registry.contract_invalid",
			`La plage de version ${range} n’est pas prise en charge.`,
		);
	}
	const [, operator, minimum] = match;
	const comparison = compareSemver(version, minimum!);
	if (operator === ">=") return comparison >= 0;
	if (operator === ">") return comparison > 0;
	const [major, minor] = minimum!.split(".").map(Number);
	const [candidateMajor, candidateMinor] = version.split(".").map(Number);
	if (operator === "^") return comparison >= 0 && candidateMajor === major;
	return comparison >= 0 && candidateMajor === major && candidateMinor === minor;
}
