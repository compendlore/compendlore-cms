import { randomUUID } from "node:crypto";
import { sql, type CoreDatabase, type TransactionContext } from "../database-contracts.js";
import { CoreError } from "./errors.js";
import type { CoreJsonValue } from "./store.js";

const MAXIMUM_PAYLOAD_BYTES = 1_048_576;
const DEFAULT_OUTBOX_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export type MessagePriority = "critical" | "high" | "low" | "normal";
export type OutboxStatus = "cancelled" | "failed" | "pending" | "processing" | "published";

export interface MessageTopicVersionInput {
	readonly topicIdentifier: string;
	readonly ownerIdentifier: string;
	readonly schemaVersion: string;
	readonly definition: Readonly<Record<string, CoreJsonValue>>;
}

export interface EnqueueMessageInput {
	readonly topicIdentifier: string;
	readonly schemaVersion: string;
	readonly producerIdentifier: string;
	readonly priority: MessagePriority;
	readonly payload: Readonly<Record<string, CoreJsonValue>>;
	readonly correlationId?: string;
	readonly idempotencyKey?: string;
	readonly availableAt?: Date;
	readonly expiresAt?: Date;
}

export interface PersistentMessage {
	readonly id: string;
	readonly topicIdentifier: string;
	readonly schemaVersion: string;
	readonly producerIdentifier: string;
	readonly priority: MessagePriority;
	readonly payload: Readonly<Record<string, CoreJsonValue>>;
	readonly correlationId?: string;
	readonly idempotencyKey?: string;
	readonly availableAt: Date;
	readonly expiresAt?: Date;
	readonly createdAt: Date;
}

export interface OutboxEntry {
	readonly id: string;
	readonly messageId: string;
	readonly status: OutboxStatus;
	readonly attemptCount: number;
	readonly availableAt: Date;
	readonly lockedAt?: Date;
	readonly lastErrorCode?: string;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

export interface ClaimedOutboxMessage {
	readonly entry: OutboxEntry;
	readonly message: PersistentMessage;
}

export interface EnqueueMessageResult extends ClaimedOutboxMessage {
	readonly created: boolean;
}

export interface MessagingRepository {
	registerTopicVersion(input: MessageTopicVersionInput): Promise<void>;
	enqueue(input: EnqueueMessageInput): Promise<EnqueueMessageResult>;
	claimDueOutbox(at: Date, limit: number): Promise<readonly ClaimedOutboxMessage[]>;
	markOutboxPublished(entryId: string, at: Date): Promise<void>;
	cancelOutbox(messageId: string, at: Date): Promise<boolean>;
	markOutboxFailed(
		entryId: string,
		errorCode: string,
		nextAttemptAt: Date,
		terminal: boolean,
		at: Date,
	): Promise<void>;
}

export interface MessageOutboxTransport {
	publish(message: PersistentMessage): Promise<void>;
}

export interface MessagingProducerState {
	isActive(identifier: string): Promise<boolean>;
}

export class PersistentMessagingService {
	constructor(
		private readonly repository: MessagingRepository,
		private readonly now: () => Date = () => new Date(),
		private readonly producers: MessagingProducerState = {
			async isActive() {
				return true;
			},
		},
	) {}

	registerTopicVersion(input: MessageTopicVersionInput): Promise<void> {
		validateTopicVersion(input);
		return this.repository.registerTopicVersion(input);
	}

	async enqueue(input: EnqueueMessageInput): Promise<EnqueueMessageResult> {
		validateMessage(input, this.now());
		if (!(await this.producers.isActive(input.producerIdentifier)))
			throw new CoreError("authorization.denied", "The messaging producer is disabled.");
		return this.repository.enqueue(input);
	}

	cancel(messageId: string): Promise<boolean> {
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)
		) {
			throw new CoreError("configuration.invalid", "Invalid message identifier.");
		}
		return this.repository.cancelOutbox(messageId, this.now());
	}

	async dispatchOutbox(
		transport: MessageOutboxTransport,
		options: {
			readonly limit?: number;
			readonly maximumAttempts?: number;
			readonly retryDelayMs?: number;
		} = {},
	): Promise<{ readonly published: number; readonly failed: number }> {
		const limit = options.limit ?? 100;
		const maximumAttempts = options.maximumAttempts ?? DEFAULT_OUTBOX_ATTEMPTS;
		const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
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
			throw new CoreError("configuration.invalid", "Invalid messaging dispatcher configuration.");
		}
		const claimed = await this.repository.claimDueOutbox(this.now(), limit);
		let published = 0;
		let failed = 0;
		for (const candidate of claimed) {
			try {
				await transport.publish(candidate.message);
				await this.repository.markOutboxPublished(candidate.entry.id, this.now());
				published += 1;
			} catch (error) {
				const at = this.now();
				const terminal = candidate.entry.attemptCount >= maximumAttempts;
				const delay = Math.min(
					retryDelayMs * 2 ** Math.max(0, candidate.entry.attemptCount - 1),
					86_400_000,
				);
				await this.repository.markOutboxFailed(
					candidate.entry.id,
					readSafeErrorCode(error),
					new Date(at.getTime() + delay),
					terminal,
					at,
				);
				failed += 1;
			}
		}
		return { published, failed };
	}
}

interface MessageRow {
	readonly [key: string]: unknown;
	readonly id: string;
	readonly topic_identifier: string;
	readonly schema_version: string;
	readonly producer_identifier: string;
	readonly correlation_id: string | null;
	readonly idempotency_key: string | null;
	readonly priority: MessagePriority;
	readonly payload: Readonly<Record<string, CoreJsonValue>>;
	readonly available_at: Date;
	readonly expires_at: Date | null;
	readonly created_at: Date;
}

interface OutboxRow extends MessageRow {
	readonly outbox_id: string;
	readonly outbox_status: OutboxStatus;
	readonly attempt_count: number;
	readonly outbox_available_at: Date;
	readonly locked_at: Date | null;
	readonly last_error_code: string | null;
	readonly outbox_created_at: Date;
	readonly outbox_updated_at: Date;
}

export class PostgresMessagingRepository implements MessagingRepository {
	constructor(private readonly database: CoreDatabase) {}

	async registerTopicVersion(input: MessageTopicVersionInput): Promise<void> {
		await this.database.transaction(async (transaction) => {
			const topic = await transaction.query<{ readonly owner_identifier: string }>(/* pgsql */ sql`
				INSERT INTO core.messaging_topics (identifier, owner_identifier)
				VALUES (${input.topicIdentifier}, ${input.ownerIdentifier})
				ON CONFLICT (identifier) DO UPDATE
				SET
					owner_identifier = excluded.owner_identifier,
					active = true,
					updated_at = now()
				WHERE core.messaging_topics.owner_identifier = excluded.owner_identifier
				RETURNING owner_identifier
			`);
			if (topic.rowCount !== 1) {
				throw new CoreError(
					"authorization.denied",
					"The messaging topic belongs to another owner.",
				);
			}
			const version = await transaction.query(/* pgsql */ sql`
				INSERT INTO core.messaging_topic_versions (
					topic_identifier,
					schema_version,
					definition
				)
				VALUES (
					${input.topicIdentifier},
					${input.schemaVersion},
					${JSON.stringify(input.definition)} ::jsonb
				)
				ON CONFLICT (topic_identifier, schema_version) DO UPDATE
				SET definition = core.messaging_topic_versions.definition
				WHERE core.messaging_topic_versions.definition = excluded.definition
				RETURNING topic_identifier
			`);
			if (version.rowCount !== 1) {
				throw new CoreError(
					"infrastructure.conflict",
					"The messaging topic version already has a different definition.",
				);
			}
		});
	}

	async enqueue(input: EnqueueMessageInput): Promise<EnqueueMessageResult> {
		return this.database.transaction(async (transaction) => {
			const now = new Date();
			const messageId = randomUUID();
			const outboxId = randomUUID();
			const availableAt = input.availableAt ?? now;
			const inserted = await transaction.query<MessageRow>(/* pgsql */ sql`
				INSERT INTO core.messaging_messages (
					id,
					topic_identifier,
					schema_version,
					producer_identifier,
					correlation_id,
					idempotency_key,
					priority,
					payload,
					available_at,
					expires_at,
					created_at
				)
				VALUES (
					${messageId},
					${input.topicIdentifier},
					${input.schemaVersion},
					${input.producerIdentifier},
					${input.correlationId ?? null},
					${input.idempotencyKey ?? null},
					${input.priority},
					${JSON.stringify(input.payload)} ::jsonb,
					${availableAt},
					${input.expiresAt ?? null},
					${now}
				)
				ON CONFLICT (producer_identifier, topic_identifier, idempotency_key) DO NOTHING
				RETURNING
					id,
					topic_identifier,
					schema_version,
					producer_identifier,
					correlation_id,
					idempotency_key,
					priority,
					payload,
					available_at,
					expires_at,
					created_at
			`);
			const created = inserted.rowCount === 1;
			const message = inserted.rows[0] ?? (await this.findIdempotent(transaction, input));
			if (!message) {
				throw new CoreError("infrastructure.conflict", "The message could not be persisted.");
			}
			if (!created && !matchesIdempotentInput(message, input)) {
				throw new CoreError(
					"infrastructure.conflict",
					"The message idempotency key is already bound to different content.",
				);
			}
			await transaction.query(/* pgsql */ sql`
				INSERT INTO core.messaging_outbox (
					id,
					message_id,
					status,
					available_at,
					created_at,
					updated_at
				)
				VALUES (${outboxId}, ${message.id}, 'pending', ${message.available_at}, ${now}, ${now})
				ON CONFLICT (message_id) DO NOTHING
			`);
			const stored = await this.findByMessageId(transaction, message.id);
			if (!stored) {
				throw new CoreError("infrastructure.unavailable", "The message outbox is unavailable.", {
					retryable: true,
				});
			}
			return { ...stored, created };
		});
	}

	async claimDueOutbox(at: Date, limit: number): Promise<readonly ClaimedOutboxMessage[]> {
		return this.database.transaction(async (transaction) => {
			const result = await transaction.query<OutboxRow>(/* pgsql */ sql`
				WITH due AS (
					SELECT outbox.id
					FROM core.messaging_outbox AS outbox
					INNER JOIN core.messaging_messages AS message ON message.id = outbox.message_id
					WHERE
						outbox.status = 'pending'
						AND outbox.available_at <= ${at}
						AND message.available_at <= ${at}
						AND (message.expires_at IS NULL OR message.expires_at > ${at})
						AND (
							message.correlation_id IS NULL
							OR NOT EXISTS (
								SELECT 1
								FROM core.messaging_outbox AS earlier_outbox
								INNER JOIN core.messaging_messages AS earlier_message
									ON earlier_message.id = earlier_outbox.message_id
								WHERE
									earlier_message.correlation_id = message.correlation_id
									AND earlier_outbox.status IN ('pending', 'processing')
									AND (
										earlier_message.created_at < message.created_at
										OR (
											earlier_message.created_at = message.created_at
											AND earlier_message.id < message.id
										)
									)
							)
						)
					ORDER BY outbox.available_at, outbox.created_at
					FOR UPDATE OF outbox SKIP LOCKED
					LIMIT ${limit}
				), claimed AS (
					UPDATE core.messaging_outbox AS outbox
					SET
						status = 'processing',
						attempt_count = outbox.attempt_count + 1,
						locked_at = ${at},
						updated_at = ${at}
					FROM due
					WHERE outbox.id = due.id
					RETURNING outbox.*
				)
				SELECT
					message.*,
					claimed.id AS outbox_id,
					claimed.status AS outbox_status,
					claimed.attempt_count,
					claimed.available_at AS outbox_available_at,
					claimed.locked_at,
					claimed.last_error_code,
					claimed.created_at AS outbox_created_at,
					claimed.updated_at AS outbox_updated_at
				FROM claimed
				INNER JOIN core.messaging_messages AS message ON message.id = claimed.message_id
				ORDER BY claimed.available_at, claimed.created_at
			`);
			return result.rows.map(mapClaimed);
		});
	}

	async markOutboxPublished(entryId: string, at: Date): Promise<void> {
		await this.updateOutbox(entryId, "published", null, at, at);
	}

	async cancelOutbox(messageId: string, at: Date): Promise<boolean> {
		const result = await this.database.query(/* pgsql */ sql`
			UPDATE core.messaging_outbox
			SET
				status = 'cancelled',
				locked_at = NULL,
				updated_at = ${at}
			WHERE
				message_id = ${messageId}
				AND status = 'pending'
			RETURNING id
		`);
		return result.rowCount === 1;
	}

	async markOutboxFailed(
		entryId: string,
		errorCode: string,
		nextAttemptAt: Date,
		terminal: boolean,
		at: Date,
	): Promise<void> {
		await this.updateOutbox(entryId, terminal ? "failed" : "pending", errorCode, nextAttemptAt, at);
	}

	private async updateOutbox(
		entryId: string,
		status: OutboxStatus,
		errorCode: string | null,
		availableAt: Date,
		at: Date,
	): Promise<void> {
		const result = await this.database.query(/* pgsql */ sql`
			UPDATE core.messaging_outbox
			SET
				status = ${status},
				available_at = ${availableAt},
				locked_at = NULL,
				last_error_code = ${errorCode},
				updated_at = ${at}
			WHERE
				id = ${entryId}
				AND status = 'processing'
			RETURNING id
		`);
		if (result.rowCount !== 1) {
			throw new CoreError("infrastructure.conflict", "The message outbox state changed.");
		}
	}

	private async findIdempotent(
		transaction: TransactionContext,
		input: EnqueueMessageInput,
	): Promise<MessageRow | undefined> {
		if (!input.idempotencyKey) return undefined;
		const result = await transaction.query<MessageRow>(/* pgsql */ sql`
			SELECT
				id,
				topic_identifier,
				schema_version,
				producer_identifier,
				correlation_id,
				idempotency_key,
				priority,
				payload,
				available_at,
				expires_at,
				created_at
			FROM core.messaging_messages
			WHERE
				producer_identifier = ${input.producerIdentifier}
				AND topic_identifier = ${input.topicIdentifier}
				AND idempotency_key = ${input.idempotencyKey}
		`);
		return result.rows[0];
	}

	private async findByMessageId(
		transaction: TransactionContext,
		messageId: string,
	): Promise<ClaimedOutboxMessage | undefined> {
		const result = await transaction.query<OutboxRow>(/* pgsql */ sql`
			SELECT
				message.*,
				outbox.id AS outbox_id,
				outbox.status AS outbox_status,
				outbox.attempt_count,
				outbox.available_at AS outbox_available_at,
				outbox.locked_at,
				outbox.last_error_code,
				outbox.created_at AS outbox_created_at,
				outbox.updated_at AS outbox_updated_at
			FROM core.messaging_messages AS message
			INNER JOIN core.messaging_outbox AS outbox ON outbox.message_id = message.id
			WHERE message.id = ${messageId}
		`);
		return result.rows[0] ? mapClaimed(result.rows[0]) : undefined;
	}
}

export class InMemoryMessagingRepository implements MessagingRepository {
	private readonly topics = new Map<
		string,
		{ readonly ownerIdentifier: string; readonly definition: string }
	>();
	private readonly messages = new Map<string, PersistentMessage>();
	private readonly outbox = new Map<string, OutboxEntry>();

	async registerTopicVersion(input: MessageTopicVersionInput): Promise<void> {
		const prefix = `${input.topicIdentifier}@`;
		const owner = [...this.topics.entries()].find(([key]) => key.startsWith(prefix))?.[1]
			.ownerIdentifier;
		if (owner && owner !== input.ownerIdentifier) {
			throw new CoreError("authorization.denied", "The messaging topic belongs to another owner.");
		}
		const key = `${input.topicIdentifier}@${input.schemaVersion}`;
		const definition = canonicalJson(input.definition);
		const current = this.topics.get(key);
		if (current && current.definition !== definition) {
			throw new CoreError(
				"infrastructure.conflict",
				"The messaging topic version already has a different definition.",
			);
		}
		this.topics.set(key, { ownerIdentifier: input.ownerIdentifier, definition });
	}

	async enqueue(input: EnqueueMessageInput): Promise<EnqueueMessageResult> {
		const topicKey = `${input.topicIdentifier}@${input.schemaVersion}`;
		if (!this.topics.has(topicKey)) {
			throw new CoreError("messaging.topic_unknown", "The messaging topic is not registered.");
		}
		const existing = [...this.messages.values()].find(
			(candidate) =>
				Boolean(input.idempotencyKey) &&
				candidate.producerIdentifier === input.producerIdentifier &&
				candidate.topicIdentifier === input.topicIdentifier &&
				candidate.idempotencyKey === input.idempotencyKey,
		);
		if (existing) {
			if (!matchesIdempotentInput(existing, input)) {
				throw new CoreError(
					"infrastructure.conflict",
					"The message idempotency key is already bound to different content.",
				);
			}
			const entry = [...this.outbox.values()].find(
				(candidate) => candidate.messageId === existing.id,
			)!;
			return { message: structuredClone(existing), entry: structuredClone(entry), created: false };
		}
		const now = new Date();
		const message: PersistentMessage = {
			id: randomUUID(),
			topicIdentifier: input.topicIdentifier,
			schemaVersion: input.schemaVersion,
			producerIdentifier: input.producerIdentifier,
			priority: input.priority,
			payload: structuredClone(input.payload),
			...(input.correlationId ? { correlationId: input.correlationId } : {}),
			...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
			availableAt: input.availableAt ?? now,
			...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
			createdAt: now,
		};
		const entry: OutboxEntry = {
			id: randomUUID(),
			messageId: message.id,
			status: "pending",
			attemptCount: 0,
			availableAt: message.availableAt,
			createdAt: now,
			updatedAt: now,
		};
		this.messages.set(message.id, message);
		this.outbox.set(entry.id, entry);
		return { message: structuredClone(message), entry: structuredClone(entry), created: true };
	}

	async claimDueOutbox(at: Date, limit: number): Promise<readonly ClaimedOutboxMessage[]> {
		const claimed: ClaimedOutboxMessage[] = [];
		for (const entry of [...this.outbox.values()].sort(byOutboxDate)) {
			if (claimed.length >= limit || entry.status !== "pending" || entry.availableAt > at) continue;
			const message = this.messages.get(entry.messageId)!;
			if (message.availableAt > at || (message.expiresAt && message.expiresAt <= at)) continue;
			if (
				message.correlationId &&
				[...this.outbox.values()].some((earlierEntry) => {
					if (!["pending", "processing"].includes(earlierEntry.status)) return false;
					const earlierMessage = this.messages.get(earlierEntry.messageId)!;
					return (
						earlierMessage.correlationId === message.correlationId &&
						(earlierMessage.createdAt < message.createdAt ||
							(earlierMessage.createdAt.getTime() === message.createdAt.getTime() &&
								earlierMessage.id < message.id))
					);
				})
			) {
				continue;
			}
			const processing: OutboxEntry = {
				...entry,
				status: "processing",
				attemptCount: entry.attemptCount + 1,
				lockedAt: at,
				updatedAt: at,
			};
			this.outbox.set(entry.id, processing);
			claimed.push({ message: structuredClone(message), entry: structuredClone(processing) });
		}
		return claimed;
	}

	async markOutboxPublished(entryId: string, at: Date): Promise<void> {
		this.replaceProcessing(entryId, { status: "published", updatedAt: at });
	}

	async cancelOutbox(messageId: string, at: Date): Promise<boolean> {
		const current = [...this.outbox.values()].find((entry) => entry.messageId === messageId);
		if (!current || current.status !== "pending") return false;
		this.outbox.set(current.id, { ...current, status: "cancelled", updatedAt: at });
		return true;
	}

	async markOutboxFailed(
		entryId: string,
		errorCode: string,
		nextAttemptAt: Date,
		terminal: boolean,
		at: Date,
	): Promise<void> {
		this.replaceProcessing(entryId, {
			status: terminal ? "failed" : "pending",
			availableAt: nextAttemptAt,
			lastErrorCode: errorCode,
			updatedAt: at,
		});
	}

	inspectOutbox(): readonly OutboxEntry[] {
		return [...this.outbox.values()].map((entry) => structuredClone(entry));
	}

	private replaceProcessing(entryId: string, change: Partial<OutboxEntry>): void {
		const current = this.outbox.get(entryId);
		if (!current || current.status !== "processing") {
			throw new CoreError("infrastructure.conflict", "The message outbox state changed.");
		}
		const replacement: { lockedAt?: Date } & OutboxEntry = { ...current, ...change };
		delete replacement.lockedAt;
		this.outbox.set(entryId, replacement);
	}
}

function mapClaimed(row: OutboxRow): ClaimedOutboxMessage {
	return {
		message: {
			id: row.id,
			topicIdentifier: row.topic_identifier,
			schemaVersion: row.schema_version,
			producerIdentifier: row.producer_identifier,
			priority: row.priority,
			payload: row.payload,
			...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
			...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
			availableAt: new Date(row.available_at),
			...(row.expires_at ? { expiresAt: new Date(row.expires_at) } : {}),
			createdAt: new Date(row.created_at),
		},
		entry: {
			id: row.outbox_id,
			messageId: row.id,
			status: row.outbox_status,
			attemptCount: row.attempt_count,
			availableAt: new Date(row.outbox_available_at),
			...(row.locked_at ? { lockedAt: new Date(row.locked_at) } : {}),
			...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
			createdAt: new Date(row.outbox_created_at),
			updatedAt: new Date(row.outbox_updated_at),
		},
	};
}

function validateTopicVersion(input: MessageTopicVersionInput): void {
	validateIdentifier(input.topicIdentifier, "topic");
	validateIdentifier(input.ownerIdentifier, "owner");
	if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(input.schemaVersion)) {
		throw new CoreError("configuration.invalid", "Invalid messaging schema version.");
	}
	validateJsonObject(input.definition, "topic definition");
}

function validateMessage(input: EnqueueMessageInput, now: Date): void {
	validateIdentifier(input.topicIdentifier, "topic");
	validateIdentifier(input.producerIdentifier, "producer");
	if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(input.schemaVersion)) {
		throw new CoreError("configuration.invalid", "Invalid messaging schema version.");
	}
	if (!["critical", "high", "low", "normal"].includes(input.priority)) {
		throw new CoreError("configuration.invalid", "Invalid message priority.");
	}
	if (input.correlationId && !/^[A-Za-z0-9_-]{8,128}$/.test(input.correlationId)) {
		throw new CoreError("configuration.invalid", "Invalid message correlation identifier.");
	}
	if (input.idempotencyKey && !/^[A-Za-z0-9._:-]{1,160}$/.test(input.idempotencyKey)) {
		throw new CoreError("configuration.invalid", "Invalid message idempotency key.");
	}
	if (input.availableAt && !validDate(input.availableAt)) {
		throw new CoreError("configuration.invalid", "Invalid message availability date.");
	}
	if (
		input.expiresAt &&
		(!validDate(input.expiresAt) || input.expiresAt <= (input.availableAt ?? now))
	) {
		throw new CoreError("configuration.invalid", "Invalid message expiration date.");
	}
	validateJsonObject(input.payload, "message payload");
}

function validateJsonObject(value: unknown, label: string): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new CoreError("configuration.invalid", `Invalid ${label}.`);
	}
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new CoreError("configuration.invalid", `Invalid ${label}.`);
	}
	if (!serialized || Buffer.byteLength(serialized, "utf8") > MAXIMUM_PAYLOAD_BYTES) {
		throw new CoreError("configuration.invalid", `Invalid ${label}.`);
	}
}

function validateIdentifier(value: string, label: string): void {
	if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value) || value.length > 160) {
		throw new CoreError("configuration.invalid", `Invalid messaging ${label} identifier.`);
	}
}

function validDate(value: Date): boolean {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function readSafeErrorCode(error: unknown): string {
	if (
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string" &&
		/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(error.code)
	) {
		return error.code;
	}
	return "messaging.transport_failed";
}

function byOutboxDate(first: OutboxEntry, second: OutboxEntry): number {
	return first.availableAt.getTime() - second.availableAt.getTime();
}

function matchesIdempotentInput(
	message: PersistentMessage | MessageRow,
	input: EnqueueMessageInput,
): boolean {
	const schemaVersion = "schemaVersion" in message ? message.schemaVersion : message.schema_version;
	const correlationId =
		"correlation_id" in message ? (message.correlation_id ?? undefined) : message.correlationId;
	return (
		schemaVersion === input.schemaVersion &&
		message.priority === input.priority &&
		correlationId === input.correlationId &&
		canonicalJson(message.payload) === canonicalJson(input.payload)
	);
}

function canonicalJson(value: CoreJsonValue | Readonly<Record<string, CoreJsonValue>>): string {
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([first], [second]) => first.localeCompare(second))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
