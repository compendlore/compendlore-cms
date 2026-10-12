export const messageDeliveryProfiles = [
	"simple",
	"direct-acknowledged",
	"durable-notification",
	"transactional",
	"progress",
	"system-maintenance",
	"catalog-invalidation",
] as const;

export type MessageDeliveryProfile = (typeof messageDeliveryProfiles)[number];
export type MessageAudienceKind =
	"broadcast" | "capability" | "group" | "permission" | "role" | "team" | "user" | "user-list";
export type MessagePresentation = "banner" | "inbox" | "popup" | "silent" | "toast";
export type MessageChannel = "inbox" | "realtime";

export interface MessagePayloadFieldDefinition {
	readonly type: "boolean" | "integer" | "number" | "string";
	readonly required: boolean;
	readonly sensitive?: boolean;
	readonly maximumLength?: number;
}

export interface MessageTopicDefinition {
	readonly schemaVersion: string;
	readonly purpose: Readonly<Record<string, string>>;
	readonly sensitivity: "internal" | "public" | "restricted";
	readonly profile: MessageDeliveryProfile;
	readonly durability: "durable" | "transient";
	readonly acknowledgement: "action" | "none" | "processed" | "read" | "transport";
	readonly priority: "critical" | "high" | "low" | "normal";
	readonly audiences: readonly MessageAudienceKind[];
	readonly presentations: readonly MessagePresentation[];
	readonly channels: readonly MessageChannel[];
	readonly payload: Readonly<Record<string, MessagePayloadFieldDefinition>>;
	readonly idempotent: boolean;
	readonly maximumRecipients?: number;
	readonly expiresAfterSeconds?: number;
	readonly retentionDays: number;
}

export interface MessageTemplateDefinition {
	readonly topicIdentifier: string;
	readonly templateVersion: string;
	readonly title: Readonly<Record<string, string>>;
	readonly summary?: Readonly<Record<string, string>>;
	readonly body: Readonly<Record<string, string>>;
	readonly actionLabels?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
