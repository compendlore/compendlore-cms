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

	versionCompatibilityBlockers(key: string): readonly string[] {
		const contribution = this.require(key);
		return [...this.contributions.values()]
			.filter((candidate) => candidate.state === "active")
			.filter((candidate) =>
				(candidate.dependencies ?? []).some(
					(dependency) =>
						dependency.contributionKey === key &&
						!dependency.optional &&
						Boolean(dependency.versionRange) &&
						!satisfiesVersion(contribution.version, dependency.versionRange!),
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
		const activationBlockers = this.activationBlockers(key);
		const withdrawalBlockers = this.withdrawalBlockers(key);
		return {
			contribution,
			dependencies,
			dependents,
			activationBlockers,
			withdrawalBlockers,
			blockers: [...new Set([...activationBlockers, ...withdrawalBlockers])].sort(),
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
	const versionPrerelease = version.split("+")[0]!.includes("-");
	const minimumPrerelease = minimum!.split("+")[0]!.includes("-");
	if (versionPrerelease && !minimumPrerelease) return false;
	const comparison = compareSemver(version, minimum!);
	if (operator === ">=") return comparison >= 0;
	if (operator === ">") return comparison > 0;
	const [major, minor, patch] = versionCore(minimum!);
	const upperBound =
		operator === "~"
			? `${major}.${minor + 1}.0`
			: major > 0
				? `${major + 1}.0.0`
				: minor > 0
					? `0.${minor + 1}.0`
					: `0.0.${patch + 1}`;
	return comparison >= 0 && compareSemver(version, upperBound) < 0;
}

function versionCore(version: string): readonly [number, number, number] {
	const [major, minor, patch] = version.split("+")[0]!.split("-")[0]!.split(".").map(Number);
	return [major!, minor!, patch!];
}
