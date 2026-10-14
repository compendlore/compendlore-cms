import type {
	ConnectorDefinition,
	CoreJsonValue,
	FrontendNetworkDefinition,
} from "../../core/src/index.js";
import type {
	MessageActionDefinition,
	MessageSegmentDefinition,
	MessageSubscriptionDefinition,
	MessageTemplateDefinition,
	MessageTopicDefinition,
} from "./messaging.js";
import type {
	StatisticDimensionDefinition,
	StatisticEventDefinition,
	StatisticMetricDefinition,
	StatisticPolicyDefinition,
} from "./statistics.js";

export type ContributionType =
	| "api-endpoint"
	| "configuration"
	| "connector"
	| "data-seed"
	| "dimension"
	| "event"
	| "frontend-network"
	| "entitlement"
	| "method"
	| "message-template"
	| "message-topic"
	| "message-action"
	| "message-segment"
	| "message-subscription"
	| "metric"
	| "module"
	| "page"
	| "permission"
	| "popup"
	| "product"
	| "route"
	| "statistic-policy"
	| "table"
	| "theme"
	| "translation";

export const contributionTypes = [
	"api-endpoint",
	"configuration",
	"connector",
	"data-seed",
	"dimension",
	"event",
	"frontend-network",
	"entitlement",
	"message-template",
	"message-topic",
	"message-action",
	"message-segment",
	"message-subscription",
	"method",
	"metric",
	"module",
	"page",
	"permission",
	"popup",
	"product",
	"route",
	"statistic-policy",
	"table",
	"theme",
	"translation",
] as const satisfies readonly ContributionType[];

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

export type ApiAudience = "internal" | "public" | "site";
export type ApiHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export type ApiValueSchema =
	| {
			readonly type: "array";
			readonly items: ApiValueSchema;
			readonly maximumItems?: number;
	  }
	| {
			readonly type: "boolean" | "null" | "number" | "string";
			readonly maximumLength?: number;
	  }
	| {
			readonly type: "object";
			readonly properties: Readonly<Record<string, ApiValueSchema>>;
			readonly required?: readonly string[];
			readonly additionalProperties?: boolean;
	  };

export interface ApiPublicErrorDefinition {
	readonly code: string;
	readonly httpStatus: number;
	readonly message: Readonly<Record<string, string>>;
}

export interface ApiSecurityContractDefinition {
	readonly policyVersion: string;
	readonly allowedOrigins?: readonly string[];
	readonly csrfRequired?: boolean;
	readonly replayProtection?: boolean;
	readonly multiFactorMaximumAgeSeconds?: number;
	readonly maximumDepth?: number;
	readonly maximumStringLength?: number;
	readonly output?: {
		readonly omittedFields?: readonly string[];
		readonly maskedFields?: readonly string[];
	};
}

export interface ApiEndpointContractDefinition {
	readonly audience: ApiAudience;
	readonly method: ApiHttpMethod;
	readonly route: string;
	readonly contractVersion: string;
	readonly businessMethodIdentifier: string;
	readonly requiredCapability?: string;
	readonly input: ApiValueSchema;
	readonly output: ApiValueSchema;
	readonly publicErrors?: readonly ApiPublicErrorDefinition[];
	readonly security?: ApiSecurityContractDefinition;
	readonly quota?: {
		readonly limit: number;
		readonly windowSeconds: number;
	};
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
	readonly endpoint?: ApiEndpointContractDefinition;
	readonly connector?: ConnectorDefinition;
	readonly frontendNetwork?: FrontendNetworkDefinition;
	readonly statisticEvent?: StatisticEventDefinition;
	readonly statisticDimension?: StatisticDimensionDefinition;
	readonly statisticMetric?: StatisticMetricDefinition;
	readonly statisticPolicy?: StatisticPolicyDefinition;
	readonly messageTopic?: MessageTopicDefinition;
	readonly messageTemplate?: MessageTemplateDefinition;
	readonly messageAction?: MessageActionDefinition;
	readonly messageSegment?: MessageSegmentDefinition;
	readonly messageSubscription?: MessageSubscriptionDefinition;
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
	readonly activationBlockers: readonly string[];
	readonly withdrawalBlockers: readonly string[];
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
