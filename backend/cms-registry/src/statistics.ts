export type StatisticSensitivity = "internal" | "public" | "restricted";
export type StatisticValueType = "boolean" | "duration" | "integer" | "number" | "string";

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
	readonly valueType: "boolean" | "integer" | "string";
	readonly purpose: Readonly<Record<string, string>>;
	readonly sensitivity: StatisticSensitivity;
	readonly cardinalityLimit: number;
	readonly allowedValues?: readonly (boolean | number | string)[];
	readonly pseudonymized?: boolean;
}

export interface StatisticMetricDefinition {
	readonly kind: "counter" | "distribution" | "duration" | "gauge";
	readonly eventIdentifier: string;
	readonly field?: string;
	readonly unit: string;
	readonly aggregation: "average" | "count" | "maximum" | "minimum" | "sum";
	readonly granularities: readonly ("day" | "hour" | "month" | "week")[];
	readonly timezone: "UTC";
	readonly dimensionIdentifiers?: readonly string[];
}

export interface StatisticPolicyDefinition {
	readonly purposeIdentifier: string;
	readonly consent: "not-required" | "opt-in" | "opt-out";
	readonly enabledByDefault: boolean;
	readonly sampleRate: number;
	readonly retentionDays: number;
	readonly anonymizeAfterDays?: number;
}
