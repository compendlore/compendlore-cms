export const statisticSensitivities = ["internal", "public", "restricted"] as const;
export const statisticValueTypes = ["boolean", "duration", "integer", "number", "string"] as const;
export const statisticDimensionValueTypes = ["boolean", "integer", "string"] as const;
export const statisticMetricKinds = ["counter", "distribution", "duration", "gauge"] as const;
export const statisticAggregations = ["average", "count", "maximum", "minimum", "sum"] as const;
export const statisticGranularities = ["day", "hour", "month", "week"] as const;
export const statisticConsentPolicies = ["not-required", "opt-in", "opt-out"] as const;

export type StatisticSensitivity = (typeof statisticSensitivities)[number];
export type StatisticValueType = (typeof statisticValueTypes)[number];

export interface StatisticFieldDefinition {
	readonly type: StatisticValueType;
	readonly required: boolean;
	readonly maximumLength?: number;
	readonly allowedValues?: readonly (boolean | number | string)[];
}

export interface StatisticEventDefinition {
	readonly schemaVersion: string;
	readonly purpose: Readonly<Record<string, string>>;
	readonly sensitivity: StatisticSensitivity;
	readonly retentionDays: number;
	readonly timestampSource: "core" | "producer";
	readonly fields: Readonly<Record<string, StatisticFieldDefinition>>;
	readonly dimensionIdentifiers?: readonly string[];
}

export interface StatisticDimensionDefinition {
	readonly valueType: (typeof statisticDimensionValueTypes)[number];
	readonly purpose: Readonly<Record<string, string>>;
	readonly sensitivity: StatisticSensitivity;
	readonly cardinalityLimit: number;
	readonly allowedValues?: readonly (boolean | number | string)[];
	readonly pseudonymized?: boolean;
}

export interface StatisticMetricDefinition {
	readonly kind: (typeof statisticMetricKinds)[number];
	readonly eventIdentifier: string;
	readonly field?: string;
	readonly unit: string;
	readonly aggregation: (typeof statisticAggregations)[number];
	readonly granularities: readonly (typeof statisticGranularities)[number][];
	readonly timezone: "UTC";
	readonly dimensionIdentifiers?: readonly string[];
}

export interface StatisticPolicyDefinition {
	readonly purposeIdentifier: string;
	readonly consent: (typeof statisticConsentPolicies)[number];
	readonly enabledByDefault: boolean;
	readonly sampleRate: number;
	readonly retentionDays: number;
	readonly anonymizeAfterDays?: number;
}
