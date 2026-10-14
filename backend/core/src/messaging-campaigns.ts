import { createHash, randomUUID } from "node:crypto";
import { sql, type CoreDatabase } from "../database-contracts.js";
import { CoreError } from "./errors.js";
import type { MessagePriority } from "./messaging.js";
import type {
	NotificationTemplateService,
	RenderedNotification,
} from "./notification-templates.js";
import type { CoreJsonValue } from "./store.js";

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGE_CAPABILITY = "core.messaging.campaign.manage";
const REPLAY_CAPABILITY = "core.messaging.dead-letter.replay";

export type MessagingCampaignStatus =
	| "cancelled"
	| "completed"
	| "confirmed"
	| "draft"
	| "failed"
	| "revoked"
	| "running"
	| "scheduled";

export interface MessagingCampaignAudience {
	readonly kind: string;
	readonly selector: Readonly<Record<string, CoreJsonValue>>;
}

export interface MessagingCampaign {
	readonly id: string;
	readonly ownerIdentifier: string;
	readonly contributionIdentifier: string;
	readonly topicIdentifier: string;
	readonly schemaVersion: string;
	readonly templateIdentifier: string;
	readonly templateVersion: string;
	readonly audience: MessagingCampaignAudience;
	readonly variables: Readonly<Record<string, CoreJsonValue>>;
	readonly requestedLocale: string;
	readonly priority: MessagePriority;
	readonly status: MessagingCampaignStatus;
	readonly previewDigest?: string;
	readonly previewRecipientCount?: number;
	readonly scheduledAt?: Date;
	readonly startedAt?: Date;
	readonly completedAt?: Date;
	readonly cancelledAt?: Date;
	readonly revokedAt?: Date;
	readonly createdBy: string;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

export interface MessagingCampaignEvent {
	readonly campaignId: string;
	readonly eventType: string;
	readonly outcome: "allowed" | "denied" | "failed";
	readonly actorId?: string;
	readonly correlationId: string;
	readonly metadata: Readonly<Record<string, CoreJsonValue>>;
	readonly createdAt: Date;
}

export interface MessagingCampaignRepository {
	create(campaign: MessagingCampaign): Promise<void>;
	find(id: string): Promise<MessagingCampaign | undefined>;
	transition(
		id: string,
		expected: readonly MessagingCampaignStatus[],
		changes: Partial<MessagingCampaign>,
	): Promise<MessagingCampaign>;
	claimDue(at: Date, limit: number): Promise<readonly MessagingCampaign[]>;
	appendEvent(event: MessagingCampaignEvent): Promise<void>;
}

export interface MessagingCampaignAuthorization {
	hasCapability(actorId: string, capability: string): Promise<boolean>;
}

export interface MessagingContributionState {
	isActive(identifier: string): Promise<boolean>;
}

export interface MessagingCampaignAudiencePreview {
	preview(audience: MessagingCampaignAudience): Promise<{
		readonly recipientCount: number;
		readonly audienceFingerprint: string;
	}>;
}

export interface MessagingCampaignPublisher {
	sendTest(input: {
		readonly campaign: MessagingCampaign;
		readonly operatorId: string;
		readonly rendered: RenderedNotification;
	}): Promise<string>;
	publish(input: {
		readonly campaign: MessagingCampaign;
		readonly rendered: RenderedNotification;
	}): Promise<{ readonly messageId: string; readonly recipientCount: number }>;
	revoke(campaignId: string): Promise<void>;
	replayDeadLetter(deadLetterId: string): Promise<string>;
	deliverySummary(campaignId: string): Promise<MessagingCampaignDeliverySummary>;
}

export interface MessagingCampaignDeliverySummary {
	readonly delivered: number;
	readonly acknowledged: number;
	readonly read: number;
	readonly processed: number;
	readonly expired: number;
	readonly failed: number;
}

export class MessagingCampaignService {
	constructor(
		private readonly repository: MessagingCampaignRepository,
		private readonly authorization: MessagingCampaignAuthorization,
		private readonly contributions: MessagingContributionState,
		private readonly audiencePreview: MessagingCampaignAudiencePreview,
		private readonly notifications: NotificationTemplateService,
		private readonly publisher: MessagingCampaignPublisher,
		private readonly now: () => Date = () => new Date(),
	) {}

	async createDraft(
		input: Omit<
			MessagingCampaign,
			| "cancelledAt"
			| "completedAt"
			| "createdAt"
			| "id"
			| "previewDigest"
			| "previewRecipientCount"
			| "revokedAt"
			| "scheduledAt"
			| "startedAt"
			| "status"
			| "updatedAt"
		>,
		correlationId: string,
	): Promise<MessagingCampaign> {
		await this.authorize(input.createdBy, MANAGE_CAPABILITY);
		await this.assertContributionActive(input.contributionIdentifier);
		validateDraft(input);
		const at = this.now();
		const campaign: MessagingCampaign = {
			...structuredClone(input),
			id: randomUUID(),
			status: "draft",
			createdAt: at,
			updatedAt: at,
		};
		await this.repository.create(campaign);
		await this.audit(campaign.id, "created", "allowed", input.createdBy, correlationId, {});
		return campaign;
	}

	async preview(
		campaignId: string,
		actorId: string,
		correlationId: string,
	): Promise<{
		readonly rendered: RenderedNotification;
		readonly recipientCount: number;
		readonly previewDigest: string;
	}> {
		await this.authorize(actorId, MANAGE_CAPABILITY);
		const campaign = await this.readCampaign(campaignId);
		await this.assertContributionActive(campaign.contributionIdentifier);
		if (!["draft", "confirmed"].includes(campaign.status)) this.invalidTransition();
		const [rendered, audience] = await Promise.all([
			this.render(campaign),
			this.audiencePreview.preview(campaign.audience),
		]);
		validateRecipientCount(audience.recipientCount);
		const previewDigest = digest({
			campaign: campaignSnapshot(campaign),
			rendered,
			audienceFingerprint: audience.audienceFingerprint,
			recipientCount: audience.recipientCount,
		});
		await this.repository.transition(campaign.id, [campaign.status], {
			previewDigest,
			previewRecipientCount: audience.recipientCount,
			updatedAt: this.now(),
		});
		await this.audit(campaign.id, "previewed", "allowed", actorId, correlationId, {
			recipientCount: audience.recipientCount,
			previewDigest,
		});
		return { rendered, recipientCount: audience.recipientCount, previewDigest };
	}

	async sendTest(campaignId: string, operatorId: string, correlationId: string): Promise<string> {
		await this.authorize(operatorId, MANAGE_CAPABILITY);
		const campaign = await this.readCampaign(campaignId);
		await this.assertContributionActive(campaign.contributionIdentifier);
		if (!["draft", "confirmed", "scheduled"].includes(campaign.status)) this.invalidTransition();
		const messageId = await this.publisher.sendTest({
			campaign,
			operatorId,
			rendered: await this.render(campaign),
		});
		await this.audit(campaign.id, "test-sent", "allowed", operatorId, correlationId, {
			messageId,
		});
		return messageId;
	}

	async confirm(
		campaignId: string,
		actorId: string,
		previewDigest: string,
		correlationId: string,
	): Promise<MessagingCampaign> {
		await this.authorize(actorId, MANAGE_CAPABILITY);
		const campaign = await this.readCampaign(campaignId);
		await this.assertContributionActive(campaign.contributionIdentifier);
		if (
			campaign.status !== "draft" ||
			!campaign.previewDigest ||
			campaign.previewDigest !== previewDigest
		)
			throw new CoreError("infrastructure.conflict", "The campaign preview is stale.");
		const updated = await this.repository.transition(campaign.id, ["draft"], {
			status: "confirmed",
			updatedAt: this.now(),
		});
		await this.audit(campaign.id, "confirmed", "allowed", actorId, correlationId, {
			previewDigest,
		});
		return updated;
	}

	async schedule(
		campaignId: string,
		actorId: string,
		scheduledAt: Date,
		correlationId: string,
	): Promise<MessagingCampaign> {
		await this.authorize(actorId, MANAGE_CAPABILITY);
		if (Number.isNaN(scheduledAt.getTime()) || scheduledAt <= this.now())
			throw new CoreError("configuration.invalid", "Invalid campaign schedule.");
		const campaign = await this.readCampaign(campaignId);
		await this.assertContributionActive(campaign.contributionIdentifier);
		const updated = await this.repository.transition(campaign.id, ["confirmed"], {
			status: "scheduled",
			scheduledAt,
			updatedAt: this.now(),
		});
		await this.audit(campaign.id, "scheduled", "allowed", actorId, correlationId, {
			scheduledAt: scheduledAt.toISOString(),
		});
		return updated;
	}

	async cancel(campaignId: string, actorId: string, correlationId: string): Promise<void> {
		await this.authorize(actorId, MANAGE_CAPABILITY);
		const at = this.now();
		await this.repository.transition(campaignId, ["draft", "confirmed", "scheduled"], {
			status: "cancelled",
			cancelledAt: at,
			updatedAt: at,
		});
		await this.audit(campaignId, "cancelled", "allowed", actorId, correlationId, {});
	}

	async revoke(campaignId: string, actorId: string, correlationId: string): Promise<void> {
		await this.authorize(actorId, MANAGE_CAPABILITY);
		const at = this.now();
		await this.repository.transition(campaignId, ["running", "completed"], {
			status: "revoked",
			revokedAt: at,
			updatedAt: at,
		});
		await this.publisher.revoke(campaignId);
		await this.audit(campaignId, "revoked", "allowed", actorId, correlationId, {});
	}

	async dispatchDue(limit = 25): Promise<{ readonly completed: number; readonly failed: number }> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new CoreError("configuration.invalid", "Invalid campaign dispatch limit.");
		}
		const campaigns = await this.repository.claimDue(this.now(), limit);
		let completed = 0;
		let failed = 0;
		for (const campaign of campaigns) {
			try {
				await this.assertContributionActive(campaign.contributionIdentifier);
				const result = await this.publisher.publish({
					campaign,
					rendered: await this.render(campaign),
				});
				await this.repository.transition(campaign.id, ["running"], {
					status: "completed",
					completedAt: this.now(),
					updatedAt: this.now(),
				});
				await this.audit(campaign.id, "mass-sent", "allowed", undefined, randomUUID(), {
					messageId: result.messageId,
					recipientCount: result.recipientCount,
				});
				completed += 1;
			} catch (error) {
				await this.repository.transition(campaign.id, ["running"], {
					status: "failed",
					updatedAt: this.now(),
				});
				await this.audit(campaign.id, "mass-sent", "failed", undefined, randomUUID(), {
					errorCode: error instanceof CoreError ? error.code : "internal.failure",
				});
				failed += 1;
			}
		}
		return { completed, failed };
	}

	async replayDeadLetter(
		campaignId: string,
		deadLetterId: string,
		actorId: string,
		correlationId: string,
	): Promise<string> {
		await this.authorize(actorId, REPLAY_CAPABILITY);
		validateUuid(deadLetterId, "dead-letter");
		await this.readCampaign(campaignId);
		const messageId = await this.publisher.replayDeadLetter(deadLetterId);
		await this.audit(campaignId, "dead-letter-replayed", "allowed", actorId, correlationId, {
			deadLetterId,
			messageId,
		});
		return messageId;
	}

	async inspect(
		campaignId: string,
		actorId: string,
	): Promise<{
		readonly campaign: MessagingCampaign;
		readonly delivery: MessagingCampaignDeliverySummary;
	}> {
		await this.authorize(actorId, MANAGE_CAPABILITY);
		const campaign = await this.readCampaign(campaignId);
		const delivery = await this.publisher.deliverySummary(campaignId);
		for (const value of Object.values(delivery)) validateRecipientCount(value);
		return { campaign, delivery };
	}

	private async authorize(actorId: string, capability: string): Promise<void> {
		validateUuid(actorId, "actor");
		if (!(await this.authorization.hasCapability(actorId, capability)))
			throw new CoreError("authorization.denied", "Campaign operation denied.");
	}

	private async assertContributionActive(identifier: string): Promise<void> {
		if (!(await this.contributions.isActive(identifier)))
			throw new CoreError("authorization.denied", "The messaging contribution is disabled.");
	}

	private async readCampaign(id: string): Promise<MessagingCampaign> {
		validateUuid(id, "campaign");
		const campaign = await this.repository.find(id);
		if (!campaign) throw new CoreError("messaging.topic_unknown", "The campaign does not exist.");
		return campaign;
	}

	private render(campaign: MessagingCampaign): Promise<RenderedNotification> {
		return this.notifications.render({
			templateIdentifier: campaign.templateIdentifier,
			templateVersion: campaign.templateVersion,
			locale: campaign.requestedLocale,
			variables: campaign.variables,
		});
	}

	private audit(
		campaignId: string,
		eventType: string,
		outcome: MessagingCampaignEvent["outcome"],
		actorId: string | undefined,
		correlationId: string,
		metadata: Readonly<Record<string, CoreJsonValue>>,
	): Promise<void> {
		if (!correlationId.trim() || correlationId.length > 160)
			throw new CoreError("configuration.invalid", "Invalid campaign correlation identifier.");
		return this.repository.appendEvent({
			campaignId,
			eventType,
			outcome,
			...(actorId ? { actorId } : {}),
			correlationId,
			metadata,
			createdAt: this.now(),
		});
	}

	private invalidTransition(): never {
		throw new CoreError("infrastructure.conflict", "Invalid campaign lifecycle transition.");
	}
}

export class InMemoryMessagingCampaignRepository implements MessagingCampaignRepository {
	private readonly campaigns = new Map<string, MessagingCampaign>();
	readonly events: MessagingCampaignEvent[] = [];

	async create(campaign: MessagingCampaign): Promise<void> {
		if (this.campaigns.has(campaign.id))
			throw new CoreError("infrastructure.conflict", "The campaign already exists.");
		this.campaigns.set(campaign.id, structuredClone(campaign));
	}

	async find(id: string): Promise<MessagingCampaign | undefined> {
		const campaign = this.campaigns.get(id);
		return campaign ? structuredClone(campaign) : undefined;
	}

	async transition(
		id: string,
		expected: readonly MessagingCampaignStatus[],
		changes: Partial<MessagingCampaign>,
	): Promise<MessagingCampaign> {
		const current = this.campaigns.get(id);
		if (!current || !expected.includes(current.status))
			throw new CoreError("infrastructure.conflict", "Invalid campaign lifecycle transition.");
		const updated = { ...current, ...structuredClone(changes) };
		this.campaigns.set(id, updated);
		return structuredClone(updated);
	}

	async claimDue(at: Date, limit: number): Promise<readonly MessagingCampaign[]> {
		const due = [...this.campaigns.values()]
			.filter(
				(campaign) =>
					campaign.status === "scheduled" &&
					campaign.scheduledAt !== undefined &&
					campaign.scheduledAt <= at,
			)
			.sort((left, right) => left.scheduledAt!.getTime() - right.scheduledAt!.getTime())
			.slice(0, limit);
		for (const campaign of due) {
			const running = { ...campaign, status: "running" as const, startedAt: at, updatedAt: at };
			this.campaigns.set(campaign.id, running);
		}
		return due.map((campaign) => ({
			...structuredClone(campaign),
			status: "running" as const,
			startedAt: at,
			updatedAt: at,
		}));
	}

	async appendEvent(event: MessagingCampaignEvent): Promise<void> {
		this.events.push(structuredClone(event));
	}
}

interface CampaignRow {
	readonly [key: string]: unknown;
	readonly id: string;
	readonly owner_identifier: string;
	readonly contribution_identifier: string;
	readonly topic_identifier: string;
	readonly schema_version: string;
	readonly template_identifier: string;
	readonly template_version: string;
	readonly audience: MessagingCampaignAudience;
	readonly variables: Readonly<Record<string, CoreJsonValue>>;
	readonly requested_locale: string;
	readonly priority: MessagePriority;
	readonly status: MessagingCampaignStatus;
	readonly preview_digest: string | null;
	readonly preview_recipient_count: number | null;
	readonly scheduled_at: Date | null;
	readonly started_at: Date | null;
	readonly completed_at: Date | null;
	readonly cancelled_at: Date | null;
	readonly revoked_at: Date | null;
	readonly created_by: string;
	readonly created_at: Date;
	readonly updated_at: Date;
}

export class PostgresMessagingCampaignRepository implements MessagingCampaignRepository {
	constructor(private readonly database: CoreDatabase) {}

	async create(campaign: MessagingCampaign): Promise<void> {
		await this.database.query(/* pgsql */ sql`
			INSERT INTO core.messaging_campaigns (
				id, owner_identifier, contribution_identifier, topic_identifier, schema_version,
				template_identifier, template_version, audience, variables, requested_locale,
				priority, status, created_by, created_at, updated_at
			)
			VALUES (
				${campaign.id}, ${campaign.ownerIdentifier}, ${campaign.contributionIdentifier},
				${campaign.topicIdentifier}, ${campaign.schemaVersion}, ${campaign.templateIdentifier},
				${campaign.templateVersion}, ${JSON.stringify(campaign.audience)}::jsonb,
				${JSON.stringify(campaign.variables)}::jsonb, ${campaign.requestedLocale},
				${campaign.priority}, ${campaign.status}, ${campaign.createdBy}, ${campaign.createdAt},
				${campaign.updatedAt}
			)
		`);
	}

	async find(id: string): Promise<MessagingCampaign | undefined> {
		const result = await this.database.query<CampaignRow>(/* pgsql */ sql`
			SELECT *
			FROM core.messaging_campaigns
			WHERE id = ${id}
		`);
		return result.rows[0] ? mapCampaign(result.rows[0]) : undefined;
	}

	async transition(
		id: string,
		expected: readonly MessagingCampaignStatus[],
		changes: Partial<MessagingCampaign>,
	): Promise<MessagingCampaign> {
		const current = await this.find(id);
		if (!current || !expected.includes(current.status))
			throw new CoreError("infrastructure.conflict", "Invalid campaign lifecycle transition.");
		const next = { ...current, ...changes };
		const result = await this.database.query<CampaignRow>(/* pgsql */ sql`
			UPDATE core.messaging_campaigns
			SET status = ${next.status}, preview_digest = ${next.previewDigest ?? null},
				preview_recipient_count = ${next.previewRecipientCount ?? null},
				scheduled_at = ${next.scheduledAt ?? null}, started_at = ${next.startedAt ?? null},
				completed_at = ${next.completedAt ?? null}, cancelled_at = ${next.cancelledAt ?? null},
				revoked_at = ${next.revokedAt ?? null}, updated_at = ${next.updatedAt}
			WHERE id = ${id} AND status = ${current.status}
			RETURNING *
		`);
		if (!result.rows[0])
			throw new CoreError("infrastructure.conflict", "Invalid campaign lifecycle transition.");
		return mapCampaign(result.rows[0]);
	}

	async claimDue(at: Date, limit: number): Promise<readonly MessagingCampaign[]> {
		return this.database.transaction(async (transaction) => {
			const result = await transaction.query<CampaignRow>(/* pgsql */ sql`
				WITH due AS (
					SELECT id
					FROM core.messaging_campaigns
					WHERE status = 'scheduled' AND scheduled_at <= ${at}
					ORDER BY scheduled_at, created_at
					LIMIT ${limit}
					FOR UPDATE SKIP LOCKED
				)
				UPDATE core.messaging_campaigns AS campaigns
				SET status = 'running', started_at = ${at}, updated_at = ${at}
				FROM due
				WHERE campaigns.id = due.id
				RETURNING campaigns.*
			`);
			return result.rows.map(mapCampaign);
		});
	}

	async appendEvent(event: MessagingCampaignEvent): Promise<void> {
		await this.database.query(/* pgsql */ sql`
			INSERT INTO core.messaging_campaign_events (
				campaign_id, event_type, outcome, actor_id, correlation_id, metadata, created_at
			)
			VALUES (
				${event.campaignId}, ${event.eventType}, ${event.outcome}, ${event.actorId ?? null},
				${event.correlationId}, ${JSON.stringify(event.metadata)}::jsonb, ${event.createdAt}
			)
		`);
	}
}

function validateDraft(input: {
	readonly ownerIdentifier: string;
	readonly contributionIdentifier: string;
	readonly topicIdentifier: string;
	readonly schemaVersion: string;
	readonly templateIdentifier: string;
	readonly templateVersion: string;
	readonly audience: MessagingCampaignAudience;
	readonly variables: Readonly<Record<string, CoreJsonValue>>;
	readonly requestedLocale: string;
	readonly priority: MessagePriority;
	readonly createdBy: string;
}): void {
	for (const identifier of [
		input.ownerIdentifier,
		input.contributionIdentifier,
		input.topicIdentifier,
		input.templateIdentifier,
		input.audience.kind,
	])
		if (!IDENTIFIER_PATTERN.test(identifier) || identifier.length > 160)
			throw new CoreError("configuration.invalid", "Invalid campaign identifier.");
	if (
		!/^\d+\.\d+\.\d+$/.test(input.schemaVersion) ||
		!/^\d+\.\d+\.\d+$/.test(input.templateVersion) ||
		!LOCALE_PATTERN.test(input.requestedLocale) ||
		!["critical", "high", "low", "normal"].includes(input.priority) ||
		!UUID_PATTERN.test(input.createdBy) ||
		Buffer.byteLength(JSON.stringify(input.variables), "utf8") > 1_048_576 ||
		Buffer.byteLength(JSON.stringify(input.audience.selector), "utf8") > 65_536
	)
		throw new CoreError("configuration.invalid", "Invalid campaign definition.");
}

function validateRecipientCount(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000)
		throw new CoreError("configuration.invalid", "Invalid campaign recipient count.");
}

function validateUuid(value: string, label: string): void {
	if (!UUID_PATTERN.test(value))
		throw new CoreError("configuration.invalid", `Invalid ${label} identifier.`);
}

function campaignSnapshot(campaign: MessagingCampaign): Readonly<Record<string, unknown>> {
	return {
		id: campaign.id,
		ownerIdentifier: campaign.ownerIdentifier,
		contributionIdentifier: campaign.contributionIdentifier,
		topicIdentifier: campaign.topicIdentifier,
		schemaVersion: campaign.schemaVersion,
		templateIdentifier: campaign.templateIdentifier,
		templateVersion: campaign.templateVersion,
		audience: campaign.audience,
		variables: campaign.variables,
		requestedLocale: campaign.requestedLocale,
		priority: campaign.priority,
	};
}

function digest(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

function mapCampaign(row: CampaignRow): MessagingCampaign {
	return {
		id: row.id,
		ownerIdentifier: row.owner_identifier,
		contributionIdentifier: row.contribution_identifier,
		topicIdentifier: row.topic_identifier,
		schemaVersion: row.schema_version,
		templateIdentifier: row.template_identifier,
		templateVersion: row.template_version,
		audience: row.audience,
		variables: row.variables,
		requestedLocale: row.requested_locale,
		priority: row.priority,
		status: row.status,
		...(row.preview_digest ? { previewDigest: row.preview_digest } : {}),
		...(row.preview_recipient_count !== null
			? { previewRecipientCount: row.preview_recipient_count }
			: {}),
		...(row.scheduled_at ? { scheduledAt: row.scheduled_at } : {}),
		...(row.started_at ? { startedAt: row.started_at } : {}),
		...(row.completed_at ? { completedAt: row.completed_at } : {}),
		...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
		...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
