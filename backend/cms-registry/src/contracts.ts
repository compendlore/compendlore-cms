import type { CoreJsonValue } from "../../core/src/index.js";

export type ContributionType =
	| "configuration"
	| "data-seed"
	| "dimension"
	| "event"
	| "method"
	| "metric"
	| "module"
	| "permission"
	| "statistic-policy"
	| "table"
	| "translation";

export type ContributionState =
	| "active"
	| "disabled"
	| "discovered"
	| "failed"
	| "registered"
	| "repairing"
	| "updating"
	| "withdrawn";

export type OwnerKind = "addon" | "core" | "instance" | "native-module";

export interface ContributionOwner {
	readonly kind: OwnerKind;
	readonly identifier: string;
}

export interface ContributionDependency {
	readonly contributionKey: string;
	readonly optional?: boolean;
	readonly versionRange?: string;
}

export type WithdrawalPolicy = "archive" | "block-uninstall" | "delete" | "preserve-data";
export type ReplacementPolicy = "explicit" | "forbidden" | "same-owner";

export interface ConfigurationFieldDefinition {
	readonly key: string;
	readonly type: "boolean" | "integer" | "json" | "number" | "secret-reference" | "string";
	readonly defaultValue: CoreJsonValue;
	readonly allowedValues?: readonly CoreJsonValue[];
	readonly description: Readonly<Record<string, string>>;
}

export interface MethodContractDefinition {
	readonly requiredCapability?: string;
	readonly transaction: "none" | "required";
	readonly timeoutMs: number;
	readonly idempotent: boolean;
}

export interface ContributionDefinition {
	readonly identifier: string;
	readonly type: ContributionType;
	readonly owner: ContributionOwner;
	readonly version: string;
	readonly dependencies?: readonly ContributionDependency[];
	readonly requiredCapabilities?: readonly string[];
	readonly configuration?: readonly ConfigurationFieldDefinition[];
	readonly translations?: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly withdrawalPolicy: WithdrawalPolicy;
	readonly replacementPolicy?: ReplacementPolicy;
	readonly replaces?: string;
	readonly method?: MethodContractDefinition;
	readonly payload?: CoreJsonValue;
}

export interface StoredContribution extends ContributionDefinition {
	readonly key: string;
	readonly state: ContributionState;
	readonly registeredAt: Date;
	readonly updatedAt: Date;
	readonly failureReason?: string;
}

export interface ContributionInspection {
	readonly contribution: StoredContribution;
	readonly dependencies: readonly string[];
	readonly dependents: readonly string[];
	readonly blockers: readonly string[];
}

export interface RegistryCatalog {
	readonly generatedAt: Date;
	readonly contributions: readonly StoredContribution[];
	readonly byType: Readonly<Record<ContributionType, readonly StoredContribution[]>>;
}

export function contributionKey(type: ContributionType, identifier: string): string {
	return `${type}.${identifier}`;
}

export function sameOwner(first: ContributionOwner, second: ContributionOwner): boolean {
	return first.kind === second.kind && first.identifier === second.identifier;
}
