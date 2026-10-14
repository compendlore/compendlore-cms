import { randomUUID } from "node:crypto";
import { sql, type CoreDatabase } from "../database-contracts.js";
import { CoreError } from "./errors.js";
import type { CoreJsonValue } from "./store.js";

const USER_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACKNOWLEDGEMENT_ORDER = ["transport", "processed", "read", "action"] as const;

export type MessageAudienceKind =
	| "broadcast"
	| "capability"
	| "group"
	| "permission"
	| "role"
	| "segment"
	| "team"
	| "user"
	| "user-list";
export type MessageAcknowledgementKind = (typeof ACKNOWLEDGEMENT_ORDER)[number];
export type MessageDeliveryChannel = "inbox" | "realtime";
export type MessageDeliveryStatus =
	"acknowledged" | "cancelled" | "delivered" | "expired" | "failed" | "pending" | "processing";

export interface MessageAudienceExpression {
	readonly kind: MessageAudienceKind;
	readonly identifiers: readonly string[];
	readonly resolutionMode: "dynamic" | "snapshot";
}

export interface ResolvedMessageAudience {
	readonly expression: MessageAudienceExpression;
	readonly userIds: readonly string[];
	readonly cardinality: number;
}

export interface MessageAudienceDirectory {
	resolve(expression: MessageAudienceExpression): Promise<readonly string[]>;
}

export interface DeliveryMaterializationInput {
	readonly messageId: string;
	readonly audience: MessageAudienceExpression;
	readonly userIds: readonly string[];
	readonly channel: MessageDeliveryChannel;
	readonly requiredAcknowledgement: "none" | MessageAcknowledgementKind;
}

export interface ClaimedMessageDelivery {
	readonly deliveryId: string;
	readonly messageId: string;
	readonly userId: string;
	readonly channel: MessageDeliveryChannel;
	readonly attemptNumber: number;
	readonly requiredAcknowledgement: "none" | MessageAcknowledgementKind;
	readonly position: number;
	readonly expiresAt?: Date;
}

export interface ResumableMessageDelivery {
	readonly deliveryId: string;
	readonly messageId: string;
	readonly userId: string;
	readonly channel: MessageDeliveryChannel;
	readonly position: number;
}

export interface MessageDeliveryRepository {
	materialize(input: DeliveryMaterializationInput, at: Date): Promise<number>;
	claimDue(at: Date, limit: number): Promise<readonly ClaimedMessageDelivery[]>;
	recordSuccess(deliveryId: string, at: Date): Promise<void>;
	recordFailure(
		deliveryId: string,
		errorCode: string,
		nextAttemptAt: Date,
		terminal: boolean,
		at: Date,
	): Promise<void>;
	recordExpiration(deliveryId: string, at: Date): Promise<void>;
	acknowledge(
		deliveryId: string,
		userId: string,
		kind: MessageAcknowledgementKind,
		metadata: Readonly<Record<string, CoreJsonValue>>,
		at: Date,
	): Promise<boolean>;
	readAfterCursor(
		consumerIdentifier: string,
		partitionIdentifier: string,
		position: number,
		limit: number,
	): Promise<readonly ResumableMessageDelivery[]>;
	commitCursor(
		consumerIdentifier: string,
		partitionIdentifier: string,
		position: number,
		at: Date,
	): Promise<void>;
}

export interface MessageDeliveryTransport {
	deliver(delivery: ClaimedMessageDelivery): Promise<void>;
}

export class MessageDeliveryService {
	constructor(
		private readonly directory: MessageAudienceDirectory,
		private readonly repository: MessageDeliveryRepository,
		private readonly now: () => Date = () => new Date(),
		private readonly random: () => number = Math.random,
	) {}

	async previewAudience(
		expression: MessageAudienceExpression,
		maximumDirectRecipients = 100,
	): Promise<ResolvedMessageAudience> {
		validateAudience(expression);
		if (
			!Number.isSafeInteger(maximumDirectRecipients) ||
			maximumDirectRecipients < 1 ||
			maximumDirectRecipients > 10_000
		) {
			throw new CoreError("configuration.invalid", "Invalid direct audience limit.");
		}
		const userIds = [...new Set(await this.directory.resolve(expression))].sort();
		if (userIds.some((userId) => !USER_ID_PATTERN.test(userId))) {
			throw new CoreError(
				"configuration.invalid",
				"The audience resolver returned an invalid user identifier.",
			);
		}
		if (
			["user", "user-list"].includes(expression.kind) &&
			userIds.length > maximumDirectRecipients
		) {
			throw new CoreError(
				"security.rate_limited",
				"The resolved direct audience exceeds its limit.",
			);
		}
		return { expression, userIds, cardinality: userIds.length };
	}

	async materialize(
		input: Omit<DeliveryMaterializationInput, "userIds"> & {
			readonly maximumDirectRecipients?: number;
		},
	): Promise<ResolvedMessageAudience> {
		validateUuid(input.messageId, "message");
		const audience = await this.previewAudience(input.audience, input.maximumDirectRecipients);
		await this.repository.materialize({ ...input, userIds: audience.userIds }, this.now());
		return audience;
	}

	async dispatch(
		transport: MessageDeliveryTransport,
		options: {
			readonly limit?: number;
			readonly maximumAttempts?: number;
			readonly retryDelayMs?: number;
		} = {},
	): Promise<{ readonly delivered: number; readonly expired: number; readonly failed: number }> {
		const limit = options.limit ?? 100;
		const maximumAttempts = options.maximumAttempts ?? 5;
		const retryDelayMs = options.retryDelayMs ?? 1_000;
		validateDispatchOptions(limit, maximumAttempts, retryDelayMs);
		const candidates = await this.repository.claimDue(this.now(), limit);
		let delivered = 0;
		let expired = 0;
		let failed = 0;
		for (const candidate of candidates) {
			const at = this.now();
			if (candidate.expiresAt && candidate.expiresAt <= at) {
				await this.repository.recordExpiration(candidate.deliveryId, at);
				expired += 1;
				continue;
			}
			try {
				await transport.deliver(candidate);
				await this.repository.recordSuccess(candidate.deliveryId, this.now());
				delivered += 1;
			} catch (error) {
				const failureAt = this.now();
				const terminal = candidate.attemptNumber >= maximumAttempts;
				const exponentialDelay = Math.min(
					retryDelayMs * 2 ** Math.max(0, candidate.attemptNumber - 1),
					86_400_000,
				);
				const jitter = Math.floor(exponentialDelay * 0.2 * clampRandom(this.random()));
				await this.repository.recordFailure(
					candidate.deliveryId,
					readDeliveryErrorCode(error),
					new Date(failureAt.getTime() + exponentialDelay + jitter),
					terminal,
					failureAt,
				);
				failed += 1;
			}
		}
		return { delivered, expired, failed };
	}

	acknowledge(input: {
		readonly deliveryId: string;
		readonly userId: string;
		readonly kind: MessageAcknowledgementKind;
		readonly metadata?: Readonly<Record<string, CoreJsonValue>>;
	}): Promise<boolean> {
		validateUuid(input.deliveryId, "delivery");
		validateUuid(input.userId, "user");
		if (!ACKNOWLEDGEMENT_ORDER.includes(input.kind)) {
			throw new CoreError("configuration.invalid", "Invalid message acknowledgement kind.");
		}
		return this.repository.acknowledge(
			input.deliveryId,
			input.userId,
			input.kind,
			input.metadata ?? {},
			this.now(),
		);
	}

	resume(
		consumerIdentifier: string,
		partitionIdentifier: string,
		position: number,
		limit = 100,
	): Promise<readonly ResumableMessageDelivery[]> {
		validateCursor(consumerIdentifier, partitionIdentifier, position, limit);
		return this.repository.readAfterCursor(
			consumerIdentifier,
			partitionIdentifier,
			position,
			limit,
		);
	}

	commitCursor(
		consumerIdentifier: string,
		partitionIdentifier: string,
		position: number,
	): Promise<void> {
		validateCursor(consumerIdentifier, partitionIdentifier, position, 1);
		return this.repository.commitCursor(
			consumerIdentifier,
			partitionIdentifier,
			position,
			this.now(),
		);
	}
}

export class InMemoryMessageAudienceDirectory implements MessageAudienceDirectory {
	constructor(private readonly resolutions: Readonly<Record<string, readonly string[]>>) {}

	async resolve(expression: MessageAudienceExpression): Promise<readonly string[]> {
		return expression.kind === "user" || expression.kind === "user-list"
			? expression.identifiers
			: (this.resolutions[`${expression.kind}:${expression.identifiers.join(",")}`] ?? []);
	}
}

interface MemoryDelivery extends Omit<ClaimedMessageDelivery, "attemptNumber"> {
	attemptNumber: number;
	status: MessageDeliveryStatus;
	nextAttemptAt: Date;
	lockedAt?: Date;
	acknowledgements: MessageAcknowledgementKind[];
}

export class InMemoryMessageDeliveryRepository implements MessageDeliveryRepository {
	private readonly deliveries = new Map<string, MemoryDelivery>();
	private readonly cursors = new Map<string, number>();
	private readonly deadLetters = new Set<string>();
	private nextPosition = 1;

	async materialize(input: DeliveryMaterializationInput, at: Date): Promise<number> {
		let created = 0;
		for (const userId of input.userIds) {
			const duplicate = [...this.deliveries.values()].some(
				(item) =>
					item.messageId === input.messageId &&
					item.userId === userId &&
					item.channel === input.channel,
			);
			if (duplicate) continue;
			const deliveryId = randomUUID();
			this.deliveries.set(deliveryId, {
				deliveryId,
				messageId: input.messageId,
				userId,
				channel: input.channel,
				attemptNumber: 0,
				requiredAcknowledgement: input.requiredAcknowledgement,
				position: this.nextPosition++,
				status: "pending",
				nextAttemptAt: at,
				acknowledgements: [],
			});
			created += 1;
		}
		return created;
	}

	async claimDue(at: Date, limit: number): Promise<readonly ClaimedMessageDelivery[]> {
		const claimed: ClaimedMessageDelivery[] = [];
		for (const delivery of [...this.deliveries.values()].sort((a, b) => a.position - b.position)) {
			if (
				claimed.length >= limit ||
				!["pending", "failed"].includes(delivery.status) ||
				this.deadLetters.has(delivery.deliveryId) ||
				delivery.nextAttemptAt > at
			)
				continue;
			delivery.status = "processing";
			delivery.attemptNumber += 1;
			delivery.lockedAt = at;
			claimed.push(cloneCandidate(delivery));
		}
		return claimed;
	}

	async recordSuccess(deliveryId: string): Promise<void> {
		const delivery = this.requireProcessing(deliveryId);
		delivery.status = delivery.requiredAcknowledgement === "none" ? "acknowledged" : "delivered";
		delete delivery.lockedAt;
	}

	async recordFailure(
		deliveryId: string,
		_errorCode: string,
		nextAttemptAt: Date,
		terminal: boolean,
	): Promise<void> {
		const delivery = this.requireProcessing(deliveryId);
		delivery.status = "failed";
		delivery.nextAttemptAt = nextAttemptAt;
		delete delivery.lockedAt;
		if (terminal) this.deadLetters.add(deliveryId);
	}

	async recordExpiration(deliveryId: string): Promise<void> {
		const delivery = this.requireProcessing(deliveryId);
		delivery.status = "expired";
		delete delivery.lockedAt;
	}

	async acknowledge(
		deliveryId: string,
		userId: string,
		kind: MessageAcknowledgementKind,
	): Promise<boolean> {
		const delivery = this.deliveries.get(deliveryId);
		if (
			!delivery ||
			delivery.userId !== userId ||
			!["delivered", "acknowledged"].includes(delivery.status)
		) {
			return false;
		}
		if (delivery.acknowledgements.includes(kind)) return false;
		const previous = delivery.acknowledgements.at(-1);
		if (previous && ACKNOWLEDGEMENT_ORDER.indexOf(kind) < ACKNOWLEDGEMENT_ORDER.indexOf(previous))
			return false;
		delivery.acknowledgements.push(kind);
		if (
			delivery.requiredAcknowledgement !== "none" &&
			ACKNOWLEDGEMENT_ORDER.indexOf(kind) >=
				ACKNOWLEDGEMENT_ORDER.indexOf(delivery.requiredAcknowledgement)
		) {
			delivery.status = "acknowledged";
		}
		return true;
	}

	async readAfterCursor(
		consumerIdentifier: string,
		partitionIdentifier: string,
		position: number,
		limit: number,
	): Promise<readonly ResumableMessageDelivery[]> {
		const effectivePosition = Math.max(
			position,
			this.cursors.get(`${consumerIdentifier}:${partitionIdentifier}`) ?? 0,
		);
		return [...this.deliveries.values()]
			.filter(
				(delivery) =>
					delivery.userId === partitionIdentifier && delivery.position > effectivePosition,
			)
			.sort((first, second) => first.position - second.position)
			.slice(0, limit)
			.map(({ deliveryId, messageId, userId, channel, position: deliveryPosition }) => ({
				deliveryId,
				messageId,
				userId,
				channel,
				position: deliveryPosition,
			}));
	}

	async commitCursor(
		consumerIdentifier: string,
		partitionIdentifier: string,
		position: number,
	): Promise<void> {
		const key = `${consumerIdentifier}:${partitionIdentifier}`;
		const current = this.cursors.get(key) ?? 0;
		if (position < current)
			throw new CoreError("infrastructure.conflict", "A message cursor cannot move backwards.");
		this.cursors.set(key, position);
	}

	inspect(): { readonly deadLetters: number; readonly deliveries: readonly MemoryDelivery[] } {
		return {
			deadLetters: this.deadLetters.size,
			deliveries: [...this.deliveries.values()].map((delivery) => structuredClone(delivery)),
		};
	}

	private requireProcessing(deliveryId: string): MemoryDelivery {
		const delivery = this.deliveries.get(deliveryId);
		if (!delivery || delivery.status !== "processing") {
			throw new CoreError("infrastructure.conflict", "The message delivery state changed.");
		}
		return delivery;
	}
}

interface DeliveryRow {
	readonly [key: string]: unknown;
	readonly delivery_id: string;
	readonly message_id: string;
	readonly user_id: string;
	readonly channel: MessageDeliveryChannel;
	readonly attempt_count: number;
	readonly required_acknowledgement: "none" | MessageAcknowledgementKind;
	readonly sequence: string | number;
	readonly expires_at: Date | null;
}

export class PostgresMessageAudienceDirectory implements MessageAudienceDirectory {
	constructor(
		private readonly database: CoreDatabase,
		private readonly businessResolver?: MessageAudienceDirectory,
	) {}

	async resolve(expression: MessageAudienceExpression): Promise<readonly string[]> {
		if (["group", "permission", "segment", "team"].includes(expression.kind)) {
			if (!this.businessResolver) {
				throw new CoreError(
					"infrastructure.unavailable",
					"The business audience resolver is unavailable.",
				);
			}
			return this.businessResolver.resolve(expression);
		}
		const selectors = JSON.stringify(expression.identifiers);
		if (expression.kind === "broadcast") {
			const result = await this.database.query<{ readonly id: string }>(/* pgsql */ sql`
				SELECT id
				FROM core.users
				WHERE is_active = true
				ORDER BY id
			`);
			return result.rows.map((row) => row.id);
		}
		if (expression.kind === "user" || expression.kind === "user-list") {
			const result = await this.database.query<{ readonly id: string }>(/* pgsql */ sql`
				SELECT user_account.id
				FROM core.users AS user_account
				WHERE
					user_account.is_active = true
					AND user_account.id::text IN (
						SELECT jsonb_array_elements_text(${selectors}::jsonb)
					)
				ORDER BY user_account.id
			`);
			return result.rows.map((row) => row.id);
		}
		if (expression.kind === "role") {
			const result = await this.database.query<{ readonly id: string }>(/* pgsql */ sql`
				SELECT DISTINCT user_account.id
				FROM core.users AS user_account
				INNER JOIN core.user_roles ON user_roles.user_id = user_account.id
				INNER JOIN core.roles ON roles.id = user_roles.role_id
				WHERE
					user_account.is_active = true
					AND roles.identifier IN (
						SELECT jsonb_array_elements_text(${selectors}::jsonb)
					)
				ORDER BY user_account.id
			`);
			return result.rows.map((row) => row.id);
		}
		const result = await this.database.query<{ readonly id: string }>(/* pgsql */ sql`
			SELECT DISTINCT user_account.id
			FROM core.users AS user_account
			LEFT JOIN core.user_capabilities ON user_capabilities.user_id = user_account.id
			LEFT JOIN core.user_roles ON user_roles.user_id = user_account.id
			LEFT JOIN core.role_capabilities ON role_capabilities.role_id = user_roles.role_id
			WHERE
				user_account.is_active = true
				AND (
					user_capabilities.capability_identifier IN (
						SELECT jsonb_array_elements_text(${selectors}::jsonb)
					)
					OR role_capabilities.capability_identifier IN (
						SELECT jsonb_array_elements_text(${selectors}::jsonb)
					)
				)
			ORDER BY user_account.id
		`);
		return result.rows.map((row) => row.id);
	}
}

export class PostgresMessageDeliveryRepository implements MessageDeliveryRepository {
	constructor(private readonly database: CoreDatabase) {}

	async materialize(input: DeliveryMaterializationInput, at: Date): Promise<number> {
		return this.database.transaction(async (transaction) => {
			const audienceId = randomUUID();
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.messaging_audiences (
					id, message_id, kind, selector, resolution_mode, resolved_at, created_at
				)
				VALUES (
					${audienceId},
					${input.messageId},
					${input.audience.kind},
					${JSON.stringify(input.audience.identifiers)}::jsonb,
					${input.audience.resolutionMode},
					${input.audience.resolutionMode === "snapshot" ? at : null},
					${at}
				)
			`);
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.messaging_recipients (message_id, user_id, audience_id, resolved_at)
				SELECT
					${input.messageId},
					resolved.user_id::uuid,
					${audienceId},
					${at}
				FROM jsonb_array_elements_text(${JSON.stringify(input.userIds)}::jsonb) AS resolved(user_id)
				ON CONFLICT (message_id, user_id) DO NOTHING
			`);
			const deliveries = await transaction.query(/* pgsql */ sql`
				INSERT INTO core.messaging_deliveries (
					id,
					message_id,
					user_id,
					channel,
					required_acknowledgement,
					next_attempt_at,
					created_at,
					updated_at
				)
				SELECT
					gen_random_uuid(),
					recipient.message_id,
					recipient.user_id,
					${input.channel},
					${input.requiredAcknowledgement},
					${at},
					${at},
					${at}
				FROM core.messaging_recipients AS recipient
				WHERE
					recipient.message_id = ${input.messageId}
					AND recipient.audience_id = ${audienceId}
				ON CONFLICT (message_id, user_id, channel, device_identifier) DO NOTHING
				RETURNING id
			`);
			return deliveries.rowCount;
		});
	}

	async claimDue(at: Date, limit: number): Promise<readonly ClaimedMessageDelivery[]> {
		return this.database.transaction(async (transaction) => {
			const result = await transaction.query<DeliveryRow>(/* pgsql */ sql`
				WITH due AS (
					SELECT delivery.id
					FROM core.messaging_deliveries AS delivery
					INNER JOIN core.messaging_messages AS message ON message.id = delivery.message_id
					WHERE
						(
							delivery.status = 'pending'
							OR (delivery.status = 'failed' AND delivery.next_attempt_at IS NOT NULL)
						)
						AND coalesce(delivery.next_attempt_at, delivery.created_at) <= ${at}
					ORDER BY message.sequence, delivery.created_at
					FOR UPDATE OF delivery SKIP LOCKED
					LIMIT ${limit}
				), claimed AS (
					UPDATE core.messaging_deliveries AS delivery
					SET
						status = 'processing',
						attempt_count = delivery.attempt_count + 1,
						locked_at = ${at},
						updated_at = ${at}
					FROM due
					WHERE delivery.id = due.id
					RETURNING delivery.*
				)
				SELECT
					claimed.id AS delivery_id,
					claimed.message_id,
					claimed.user_id,
					claimed.channel,
					claimed.attempt_count,
					claimed.required_acknowledgement,
					message.sequence,
					message.expires_at
				FROM claimed
				INNER JOIN core.messaging_messages AS message ON message.id = claimed.message_id
				ORDER BY message.sequence, claimed.created_at
			`);
			return result.rows.map(mapDeliveryRow);
		});
	}

	async recordSuccess(deliveryId: string, at: Date): Promise<void> {
		await this.recordResult(deliveryId, "delivered", null, null, false, at);
	}

	async recordFailure(
		deliveryId: string,
		errorCode: string,
		nextAttemptAt: Date,
		terminal: boolean,
		at: Date,
	): Promise<void> {
		await this.recordResult(
			deliveryId,
			"failed",
			errorCode,
			terminal ? null : nextAttemptAt,
			terminal,
			at,
		);
	}

	async recordExpiration(deliveryId: string, at: Date): Promise<void> {
		const result = await this.database.query(/* pgsql */ sql`
			UPDATE core.messaging_deliveries
			SET status = 'expired', expired_at = ${at}, locked_at = NULL, updated_at = ${at}
			WHERE id = ${deliveryId} AND status = 'processing'
			RETURNING id
		`);
		if (result.rowCount !== 1)
			throw new CoreError("infrastructure.conflict", "The message delivery state changed.");
	}

	async acknowledge(
		deliveryId: string,
		userId: string,
		kind: MessageAcknowledgementKind,
		metadata: Readonly<Record<string, CoreJsonValue>>,
		at: Date,
	): Promise<boolean> {
		return this.database.transaction(async (transaction) => {
			const rank = ACKNOWLEDGEMENT_ORDER.indexOf(kind);
			const inserted = await transaction.query(/* pgsql */ sql`
				INSERT INTO core.messaging_acknowledgements (delivery_id, kind, received_at, metadata)
				SELECT ${deliveryId}, ${kind}, ${at}, ${JSON.stringify(metadata)}::jsonb
				FROM core.messaging_deliveries AS delivery
				WHERE
					delivery.id = ${deliveryId}
					AND delivery.user_id = ${userId}
					AND delivery.status IN ('delivered', 'acknowledged')
					AND NOT EXISTS (
						SELECT 1
						FROM core.messaging_acknowledgements AS acknowledgement
						WHERE acknowledgement.delivery_id = delivery.id
							AND array_position(ARRAY['transport','processed','read','action'], acknowledgement.kind) > ${rank + 1}
					)
				ON CONFLICT (delivery_id, kind) DO NOTHING
				RETURNING delivery_id
			`);
			if (inserted.rowCount !== 1) return false;
			await transaction.query(/* pgsql */ sql`
				UPDATE core.messaging_deliveries
				SET status = 'acknowledged', updated_at = ${at}
				WHERE
					id = ${deliveryId}
					AND required_acknowledgement <> 'none'
					AND array_position(ARRAY['transport','processed','read','action'], required_acknowledgement)
						<= ${rank + 1}
			`);
			return true;
		});
	}

	async readAfterCursor(
		consumerIdentifier: string,
		partitionIdentifier: string,
		position: number,
		limit: number,
	): Promise<readonly ResumableMessageDelivery[]> {
		const result = await this.database.query<DeliveryRow>(/* pgsql */ sql`
			SELECT
				delivery.id AS delivery_id,
				delivery.message_id,
				delivery.user_id,
				delivery.channel,
				delivery.attempt_count,
				delivery.required_acknowledgement,
				message.sequence,
				message.expires_at
			FROM core.messaging_deliveries AS delivery
			INNER JOIN core.messaging_messages AS message ON message.id = delivery.message_id
			LEFT JOIN core.messaging_cursors AS cursor
				ON cursor.consumer_identifier = ${consumerIdentifier}
				AND cursor.partition_identifier = ${partitionIdentifier}
			WHERE
				delivery.user_id::text = ${partitionIdentifier}
				AND message.sequence > greatest(${position}, coalesce(cursor.position, 0))
			ORDER BY message.sequence
			LIMIT ${limit}
		`);
		return result.rows.map((row) => ({
			deliveryId: row.delivery_id,
			messageId: row.message_id,
			userId: row.user_id,
			channel: row.channel,
			position: Number(row.sequence),
		}));
	}

	async commitCursor(
		consumerIdentifier: string,
		partitionIdentifier: string,
		position: number,
		at: Date,
	): Promise<void> {
		const result = await this.database.query(/* pgsql */ sql`
			INSERT INTO core.messaging_cursors (
				consumer_identifier, partition_identifier, position, updated_at
			)
			VALUES (${consumerIdentifier}, ${partitionIdentifier}, ${position}, ${at})
			ON CONFLICT (consumer_identifier, partition_identifier) DO UPDATE
			SET position = excluded.position, updated_at = excluded.updated_at
			WHERE core.messaging_cursors.position <= excluded.position
			RETURNING position
		`);
		if (result.rowCount !== 1)
			throw new CoreError("infrastructure.conflict", "A message cursor cannot move backwards.");
	}

	private async recordResult(
		deliveryId: string,
		resultKind: "delivered" | "failed",
		errorCode: string | null,
		nextAttemptAt: Date | null,
		terminal: boolean,
		at: Date,
	): Promise<void> {
		await this.database.transaction(async (transaction) => {
			const delivery = await transaction.query<{ readonly attempt_count: number }>(/* pgsql */ sql`
				UPDATE core.messaging_deliveries
				SET
					status = CASE
						WHEN ${resultKind} = 'delivered' AND required_acknowledgement = 'none'
							THEN 'acknowledged'
						ELSE ${resultKind}
					END,
					next_attempt_at = ${nextAttemptAt},
					delivered_at = ${resultKind === "delivered" ? at : null},
					locked_at = NULL,
					updated_at = ${at}
				WHERE id = ${deliveryId} AND status = 'processing'
				RETURNING attempt_count
			`);
			const attempt = delivery.rows[0];
			if (!attempt)
				throw new CoreError("infrastructure.conflict", "The message delivery state changed.");
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.messaging_delivery_attempts (
					delivery_id, attempt_number, result, error_code, occurred_at
				)
				VALUES (
					${deliveryId}, ${attempt.attempt_count}, ${resultKind}, ${errorCode}, ${at}
				)
			`);
			if (terminal) {
				await transaction.query(/* pgsql */ sql`
					INSERT INTO core.messaging_dead_letters (id, delivery_id, reason_code, created_at)
					VALUES (${randomUUID()}, ${deliveryId}, ${errorCode ?? "messaging.delivery_failed"}, ${at})
					ON CONFLICT (delivery_id) DO NOTHING
				`);
			}
		});
	}
}

function validateAudience(expression: MessageAudienceExpression): void {
	const kinds: readonly MessageAudienceKind[] = [
		"broadcast",
		"capability",
		"group",
		"permission",
		"role",
		"segment",
		"team",
		"user",
		"user-list",
	];
	if (
		!kinds.includes(expression.kind) ||
		!["dynamic", "snapshot"].includes(expression.resolutionMode)
	) {
		throw new CoreError("configuration.invalid", "Invalid message audience.");
	}
	if (
		expression.kind === "broadcast"
			? expression.identifiers.length !== 0
			: expression.identifiers.length === 0
	) {
		throw new CoreError("configuration.invalid", "Invalid message audience selectors.");
	}
	if (
		expression.identifiers.length > 10_000 ||
		expression.identifiers.some((value) => !value || value.length > 160)
	) {
		throw new CoreError("configuration.invalid", "Invalid message audience selectors.");
	}
}

function mapDeliveryRow(row: DeliveryRow): ClaimedMessageDelivery {
	return {
		deliveryId: row.delivery_id,
		messageId: row.message_id,
		userId: row.user_id,
		channel: row.channel,
		attemptNumber: row.attempt_count,
		requiredAcknowledgement: row.required_acknowledgement,
		position: Number(row.sequence),
		...(row.expires_at ? { expiresAt: new Date(row.expires_at) } : {}),
	};
}

function validateDispatchOptions(
	limit: number,
	maximumAttempts: number,
	retryDelayMs: number,
): void {
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 500 ||
		!Number.isSafeInteger(maximumAttempts) ||
		maximumAttempts < 1 ||
		maximumAttempts > 20 ||
		!Number.isSafeInteger(retryDelayMs) ||
		retryDelayMs < 100 ||
		retryDelayMs > 86_400_000
	) {
		throw new CoreError("configuration.invalid", "Invalid message delivery configuration.");
	}
}

function validateCursor(
	consumer: string,
	partition: string,
	position: number,
	limit: number,
): void {
	if (
		!consumer ||
		consumer.length > 160 ||
		!partition ||
		partition.length > 160 ||
		!Number.isSafeInteger(position) ||
		position < 0 ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 500
	) {
		throw new CoreError("configuration.invalid", "Invalid message cursor.");
	}
}

function validateUuid(value: string, label: string): void {
	if (!USER_ID_PATTERN.test(value))
		throw new CoreError("configuration.invalid", `Invalid ${label} identifier.`);
}

function cloneCandidate(delivery: MemoryDelivery): ClaimedMessageDelivery {
	return {
		deliveryId: delivery.deliveryId,
		messageId: delivery.messageId,
		userId: delivery.userId,
		channel: delivery.channel,
		attemptNumber: delivery.attemptNumber,
		requiredAcknowledgement: delivery.requiredAcknowledgement,
		position: delivery.position,
		...(delivery.expiresAt ? { expiresAt: delivery.expiresAt } : {}),
	};
}

function clampRandom(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function readDeliveryErrorCode(error: unknown): string {
	if (
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string" &&
		/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(error.code)
	)
		return error.code;
	return "messaging.delivery_failed";
}
