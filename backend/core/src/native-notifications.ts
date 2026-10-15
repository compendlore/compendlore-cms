import { CoreError } from "./errors.js";
import { sql, type CoreDatabase } from "../database-contracts.js";
import {
	localizationResourceIdentifier,
	type LocalizationMaterializationPort,
	type LocalizationResolutionContext,
	type LocalizationResolutionPort,
} from "./localization.js";
import type { RenderedNotification } from "./notification-templates.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const nativeNotificationTopics = [
	"core.account",
	"core.maintenance",
	"core.restart",
	"core.security",
] as const;
export type NativeNotificationTopic = (typeof nativeNotificationTopics)[number];
export type NativeNotificationState = "archived" | "hidden" | "processed" | "read" | "unread";

export interface NativeNotificationRecord {
	readonly id: string;
	readonly userId: string;
	readonly messageId: string;
	readonly topicIdentifier: NativeNotificationTopic;
	readonly locale: string;
	readonly title: string;
	readonly body: string;
	readonly state: NativeNotificationState;
	readonly occurredAt: string;
	readonly updatedAt: string;
	readonly revision: number;
}

export interface NativeNotificationRepository {
	assign(
		input: Omit<NativeNotificationRecord, "revision" | "state" | "updatedAt">,
	): Promise<NativeNotificationRecord>;
	list(userId: string): Promise<readonly NativeNotificationRecord[]>;
	transition(input: {
		readonly notificationId: string;
		readonly userId: string;
		readonly state: Exclude<NativeNotificationState, "unread">;
		readonly expectedRevision: number;
	}): Promise<NativeNotificationRecord>;
}

export interface NativeNotificationMaterializer {
	materialize(input: {
		readonly messageId: string;
		readonly purpose: string;
		readonly mandatory: boolean;
		readonly rendered: RenderedNotification;
	}): Promise<string>;
}

export interface NativeNotificationActionAuthorizer {
	authorize(input: {
		readonly userId: string;
		readonly notificationId: string;
		readonly actionIdentifier: string;
	}): Promise<boolean>;
}

export interface NativeTopicRegistrar {
	registerTopicVersion(input: {
		readonly topicIdentifier: string;
		readonly ownerIdentifier: string;
		readonly schemaVersion: string;
		readonly definition: Readonly<Record<string, string | boolean>>;
	}): Promise<void>;
}

export class NativeNotificationService {
	constructor(
		private readonly repository: NativeNotificationRepository,
		private readonly localization: LocalizationResolutionPort,
		private readonly materializer: NativeNotificationMaterializer,
		private readonly actions: NativeNotificationActionAuthorizer,
		private readonly now: () => Date = () => new Date(),
	) {}

	async deliver(input: {
		readonly userId: string;
		readonly messageId: string;
		readonly topicIdentifier: NativeNotificationTopic;
		readonly localization: LocalizationResolutionContext;
	}): Promise<NativeNotificationRecord> {
		validateUuid(input.userId);
		validateUuid(input.messageId);
		if (!nativeNotificationTopics.includes(input.topicIdentifier)) throw invalid();
		const resolved = await this.localization.resolveLocalizedTexts(
			[resource(input.topicIdentifier, "title"), resource(input.topicIdentifier, "body")],
			input.localization,
		);
		const title = resolved[0];
		const body = resolved[1];
		if (!title || !body) throw invalid();
		const locale = title.locale;
		if (body.locale !== locale || title.missing || body.missing) throw invalid();
		const rendered: RenderedNotification = {
			templateIdentifier: `${input.topicIdentifier}.native`,
			templateVersion: "1.0.0",
			locale,
			title: title.value,
			body: body.value,
			actions: [],
		};
		const notificationId = await this.materializer.materialize({
			messageId: input.messageId,
			purpose: input.topicIdentifier.split(".")[1]!,
			mandatory: true,
			rendered,
		});
		validateUuid(notificationId);
		const occurredAt = this.now().toISOString();
		return this.repository.assign({
			id: notificationId,
			userId: input.userId,
			messageId: input.messageId,
			topicIdentifier: input.topicIdentifier,
			locale,
			title: title.value,
			body: body.value,
			occurredAt,
		});
	}

	async page(input: {
		readonly userId: string;
		readonly limit?: number;
		readonly beforeRevision?: number;
	}): Promise<{
		readonly items: readonly NativeNotificationRecord[];
		readonly nextCursor?: number;
	}> {
		validateUuid(input.userId);
		const limit = input.limit ?? 20;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid();
		const records = (await this.repository.list(input.userId))
			.filter((item) => input.beforeRevision === undefined || item.revision < input.beforeRevision)
			.sort((left, right) => right.revision - left.revision);
		const items = records.slice(0, limit);
		return {
			items,
			...(records.length > limit ? { nextCursor: items.at(-1)!.revision } : {}),
		};
	}

	async changes(
		userId: string,
		afterRevision: number,
	): Promise<readonly NativeNotificationRecord[]> {
		validateUuid(userId);
		if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) throw invalid();
		return (await this.repository.list(userId))
			.filter((item) => item.revision > afterRevision)
			.sort((left, right) => left.revision - right.revision);
	}

	setState(input: {
		readonly userId: string;
		readonly notificationId: string;
		readonly state: "archived" | "hidden" | "read";
		readonly expectedRevision: number;
	}): Promise<NativeNotificationRecord> {
		validateUuid(input.userId);
		validateUuid(input.notificationId);
		return this.repository.transition(input);
	}

	async executeAction(input: {
		readonly userId: string;
		readonly notificationId: string;
		readonly actionIdentifier: string;
		readonly expectedRevision: number;
	}): Promise<NativeNotificationRecord> {
		validateUuid(input.userId);
		validateUuid(input.notificationId);
		if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(input.actionIdentifier)) throw invalid();
		if (!(await this.actions.authorize(input))) {
			throw new CoreError("authorization.denied", "Notification action denied.");
		}
		return this.repository.transition({ ...input, state: "processed" });
	}
}

export class InMemoryNativeNotificationRepository implements NativeNotificationRepository {
	private readonly records = new Map<string, NativeNotificationRecord>();
	private revision = 0;

	async assign(
		input: Omit<NativeNotificationRecord, "revision" | "state" | "updatedAt">,
	): Promise<NativeNotificationRecord> {
		const existing = [...this.records.values()].find(
			(item) => item.userId === input.userId && item.messageId === input.messageId,
		);
		if (existing) return structuredClone(existing);
		const record: NativeNotificationRecord = {
			...input,
			id: input.id,
			state: "unread",
			updatedAt: input.occurredAt,
			revision: ++this.revision,
		};
		this.records.set(record.id, record);
		return structuredClone(record);
	}

	async list(userId: string): Promise<readonly NativeNotificationRecord[]> {
		return [...this.records.values()]
			.filter((item) => item.userId === userId)
			.map((item) => structuredClone(item));
	}

	async transition(input: {
		readonly notificationId: string;
		readonly userId: string;
		readonly state: Exclude<NativeNotificationState, "unread">;
		readonly expectedRevision: number;
	}): Promise<NativeNotificationRecord> {
		const current = this.records.get(input.notificationId);
		if (!current || current.userId !== input.userId) throw denied();
		if (current.revision !== input.expectedRevision)
			throw new CoreError("infrastructure.conflict", "Notification state changed concurrently.");
		const updated = {
			...current,
			state: input.state,
			updatedAt: new Date().toISOString(),
			revision: ++this.revision,
		};
		this.records.set(updated.id, updated);
		return structuredClone(updated);
	}
}

interface NativeNotificationRow {
	readonly [key: string]: unknown;
	readonly id: string;
	readonly user_id: string;
	readonly message_id: string;
	readonly template_identifier: string;
	readonly rendered_locale: string;
	readonly rendered_content: RenderedNotification;
	readonly state: NativeNotificationState;
	readonly created_at: Date;
	readonly updated_at: Date;
	readonly revision: number;
}

export class PostgresNativeNotificationRepository implements NativeNotificationRepository {
	constructor(private readonly database: CoreDatabase) {}

	async assign(
		input: Omit<NativeNotificationRecord, "revision" | "state" | "updatedAt">,
	): Promise<NativeNotificationRecord> {
		const result = await this.database.query<{
			readonly [key: string]: unknown;
			readonly revision: number;
			readonly updated_at: Date;
		}>(/* pgsql */ sql`
			INSERT INTO core.notification_user_states (
				notification_id,
				user_id,
				state
			)
			VALUES (${input.id}, ${input.userId}, 'unread')
			ON CONFLICT (notification_id, user_id) DO UPDATE
			SET notification_id = core.notification_user_states.notification_id
			RETURNING revision, updated_at
		`);
		const state = result.rows[0];
		if (!state) throw new CoreError("infrastructure.conflict", "Notification assignment failed.");
		return {
			...input,
			state: "unread",
			updatedAt: state.updated_at.toISOString(),
			revision: Number(state.revision),
		};
	}

	async list(userId: string): Promise<readonly NativeNotificationRecord[]> {
		const result = await this.database.query<NativeNotificationRow>(/* pgsql */ sql`
			SELECT
				n.id,
				s.user_id,
				n.message_id,
				n.template_identifier,
				n.rendered_locale,
				n.rendered_content,
				s.state,
				n.created_at,
				s.updated_at,
				s.revision
			FROM core.notification_user_states AS s
			INNER JOIN core.notifications AS n ON n.id = s.notification_id
			WHERE s.user_id = ${userId}
			ORDER BY s.revision DESC
		`);
		return result.rows.map(rowToNotification);
	}

	async transition(input: {
		readonly notificationId: string;
		readonly userId: string;
		readonly state: Exclude<NativeNotificationState, "unread">;
		readonly expectedRevision: number;
	}): Promise<NativeNotificationRecord> {
		const result = await this.database.query(/* pgsql */ sql`
			UPDATE core.notification_user_states
			SET
				state = ${input.state},
				read_at = CASE
					WHEN ${input.state} IN ('read', 'processed') THEN COALESCE(read_at, now())
					ELSE read_at
				END,
				processed_at = CASE
					WHEN ${input.state} = 'processed' THEN COALESCE(processed_at, now())
					ELSE processed_at
				END,
				updated_at = now(),
				revision = nextval('core.notification_state_revision_sequence')
			WHERE notification_id = ${input.notificationId}
				AND user_id = ${input.userId}
				AND revision = ${input.expectedRevision}
			RETURNING notification_id
		`);
		if (result.rowCount !== 1) {
			const owned = (await this.list(input.userId)).some(
				(item) => item.id === input.notificationId,
			);
			if (!owned) throw denied();
			throw new CoreError("infrastructure.conflict", "Notification state changed concurrently.");
		}
		const updated = (await this.list(input.userId)).find(
			(item) => item.id === input.notificationId,
		);
		if (!updated) throw denied();
		return updated;
	}
}

export async function materializeNativeNotificationFoundation(
	messaging: NativeTopicRegistrar,
	localization: LocalizationMaterializationPort,
): Promise<void> {
	for (const topicIdentifier of nativeNotificationTopics) {
		await messaging.registerTopicVersion({
			topicIdentifier,
			ownerIdentifier: "core",
			schemaVersion: "1.0.0",
			definition: { purpose: topicIdentifier.split(".")[1]!, mandatory: true },
		});
	}
	const values = {
		"core.account": ["Account notification", "An important account event occurred."],
		"core.maintenance": ["Maintenance notification", "A maintenance operation requires attention."],
		"core.restart": ["Restart notification", "The service restart state changed."],
		"core.security": ["Security notification", "A security event requires attention."],
	} as const;
	const sourceContributionKey = "core.notifications";
	await localization.materializeLocalization({
		sourceContributionKey,
		resources: nativeNotificationTopics.flatMap((topic) =>
			(["title", "body"] as const).map((part) => ({
				identifier: resource(topic, part),
				ownerContributionKey: sourceContributionKey,
				namespace: topic,
				key: part,
				format: part === "body" ? ("multiline" as const) : ("plain" as const),
				allowInstanceOverride: false,
				required: true,
			})),
		),
		values: nativeNotificationTopics.flatMap((topic) =>
			(["title", "body"] as const).map((part, index) => ({
				resourceIdentifier: resource(topic, part),
				locale: "en",
				sourceLayer: "owner" as const,
				sourceContributionKey,
				value: values[topic][index]!,
			})),
		),
	});
}

function resource(topic: NativeNotificationTopic, part: "body" | "title"): string {
	return localizationResourceIdentifier("core.notifications", topic, part);
}

function rowToNotification(row: NativeNotificationRow): NativeNotificationRecord {
	const topicIdentifier = row.template_identifier.replace(/\.native$/, "");
	if (!nativeNotificationTopics.includes(topicIdentifier as NativeNotificationTopic))
		throw invalid();
	return {
		id: row.id,
		userId: row.user_id,
		messageId: row.message_id,
		topicIdentifier: topicIdentifier as NativeNotificationTopic,
		locale: row.rendered_locale,
		title: row.rendered_content.title,
		body: row.rendered_content.body,
		state: row.state,
		occurredAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
		revision: Number(row.revision),
	};
}

function validateUuid(value: string): void {
	if (!UUID.test(value)) throw invalid();
}

function invalid(): CoreError {
	return new CoreError("configuration.invalid", "Invalid native notification request.");
}

function denied(): CoreError {
	return new CoreError("authorization.denied", "Notification access denied.");
}
