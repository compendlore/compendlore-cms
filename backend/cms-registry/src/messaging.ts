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
export const messageAudienceKinds = [
	"broadcast",
	"capability",
	"group",
	"permission",
	"role",
	"team",
	"user",
	"user-list",
] as const;
export const messagePresentations = ["banner", "inbox", "popup", "silent", "toast"] as const;
export const messageChannels = ["inbox", "realtime"] as const;
export const messageDurabilities = ["durable", "transient"] as const;
export const messageAcknowledgements = [
	"action",
	"none",
	"processed",
	"read",
	"transport",
] as const;
export const messagePriorities = ["critical", "high", "low", "normal"] as const;
export const messagePayloadFieldTypes = ["boolean", "integer", "number", "string"] as const;

export type MessageAudienceKind = (typeof messageAudienceKinds)[number];
export type MessagePresentation = (typeof messagePresentations)[number];
export type MessageChannel = (typeof messageChannels)[number];

export interface MessagePayloadFieldDefinition {
	readonly type: (typeof messagePayloadFieldTypes)[number];
	readonly required: boolean;
	readonly sensitive?: boolean;
	readonly maximumLength?: number;
}

export interface MessageTopicDefinition {
	readonly schemaVersion: string;
	readonly purpose: Readonly<Record<string, string>>;
	readonly sensitivity: "internal" | "public" | "restricted";
	readonly profile: MessageDeliveryProfile;
	readonly durability: (typeof messageDurabilities)[number];
	readonly acknowledgement: (typeof messageAcknowledgements)[number];
	readonly priority: (typeof messagePriorities)[number];
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
