import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { CoreError } from "./errors.js";
import { validateCoreJsonValue } from "./settings.js";
import type { CoreEvent, CoreEventConsumer, CoreJsonValue, CoreStore } from "./store.js";

const MAXIMUM_PAYLOAD_BYTES = 65_536;
const MAXIMUM_BATCH_SIZE = 500;
const MAXIMUM_TOPICS_PER_CONSUMER = 64;
const MAXIMUM_CLOCK_DRIFT_MS = 300_000;

export interface PublishCoreEventInput {
	readonly ownerIdentifier: string;
	readonly topic: string;
	readonly schemaVersion: number;
	readonly payload: Readonly<Record<string, CoreJsonValue>>;
	readonly occurredAt?: Date;
	readonly retentionUntil: Date;
	readonly idempotencyKey?: string;
}

export interface RegisterCoreEventConsumerInput {
	readonly identifier: string;
	readonly ownerIdentifier: string;
	readonly topics: readonly string[];
	readonly startAt: "earliest" | "latest";
}

export class CoreEventStream {
	private readonly integrityKey: string;

	constructor(
		private readonly store: CoreStore,
		integritySecret: string,
		private readonly now: () => Date = () => new Date(),
	) {
		if (Buffer.byteLength(integritySecret, "utf8") < 32) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		this.integrityKey = createHmac("sha256", integritySecret)
			.update("compendlore.core.event-stream.v1")
			.digest("hex");
	}

	async publish(input: PublishCoreEventInput): Promise<CoreEvent> {
		const ownerIdentifier = validateIdentifier(input.ownerIdentifier, "owner");
		const topic = validateIdentifier(input.topic, "sujet");
		if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion <= 0) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		const receivedAt = this.now();
		const occurredAt = input.occurredAt ?? receivedAt;
		assertValidDate(occurredAt, "The event date is invalid.");
		assertValidDate(input.retentionUntil, "The retention date is invalid.");
		if (occurredAt.getTime() > receivedAt.getTime() + MAXIMUM_CLOCK_DRIFT_MS) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		if (input.retentionUntil <= receivedAt) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}

		if (
			input.payload === null ||
			Array.isArray(input.payload) ||
			typeof input.payload !== "object" ||
			Object.getPrototypeOf(input.payload) !== Object.prototype
		) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		validateCoreJsonValue(input.payload);
		const serializedPayload = canonicalizeJson(input.payload);
		if (Buffer.byteLength(serializedPayload, "utf8") > MAXIMUM_PAYLOAD_BYTES) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		const payload = JSON.parse(serializedPayload) as Readonly<Record<string, CoreJsonValue>>;
		const idempotencyKey = input.idempotencyKey?.trim();
		if (idempotencyKey && idempotencyKey.length > 128) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}

		const unsignedEvent = {
			id: randomUUID(),
			ownerIdentifier,
			topic,
			schemaVersion: input.schemaVersion,
			payload,
			occurredAt: new Date(occurredAt),
			receivedAt,
			retentionUntil: new Date(input.retentionUntil),
			...(idempotencyKey ? { idempotencyKey } : {}),
		};
		const payloadChecksum = checksum(serializedPayload);
		const stored = await this.store.appendEvent({
			...unsignedEvent,
			payloadChecksum,
			signature: signEvent(unsignedEvent, payloadChecksum, this.integrityKey),
		});
		this.assertIntegrity(stored);
		if (
			idempotencyKey &&
			(stored.topic !== topic ||
				stored.schemaVersion !== input.schemaVersion ||
				JSON.stringify(stored.payload) !== serializedPayload)
		) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		return stored;
	}

	async registerConsumer(input: RegisterCoreEventConsumerInput): Promise<CoreEventConsumer> {
		const identifier = validateIdentifier(input.identifier, "consommateur");
		const ownerIdentifier = validateIdentifier(input.ownerIdentifier, "owner");
		const topics = [...new Set(input.topics.map((topic) => validateIdentifier(topic, "sujet")))];
		if (topics.length === 0 || topics.length > MAXIMUM_TOPICS_PER_CONSUMER) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		const now = this.now();
		return this.store.registerEventConsumer({
			identifier,
			ownerIdentifier,
			topics,
			lastSequence: input.startAt === "latest" ? await this.store.latestEventSequence() : 0n,
			active: true,
			createdAt: now,
			updatedAt: now,
		});
	}

	async read(consumerIdentifier: string, batchSize = 100): Promise<readonly CoreEvent[]> {
		validateIdentifier(consumerIdentifier, "consommateur");
		if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > MAXIMUM_BATCH_SIZE) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		const events = await this.store.readEventsForConsumer(consumerIdentifier, batchSize);
		for (const event of events) this.assertIntegrity(event);
		return events;
	}

	acknowledge(consumerIdentifier: string, sequence: bigint): Promise<void> {
		validateIdentifier(consumerIdentifier, "consommateur");
		if (sequence < 0n) {
			throw new CoreError("configuration.invalid", "Invalid configuration.");
		}
		return this.store.advanceEventConsumer(consumerIdentifier, sequence, this.now());
	}

	deactivateConsumer(consumerIdentifier: string): Promise<void> {
		validateIdentifier(consumerIdentifier, "consommateur");
		return this.store.setEventConsumerActive(consumerIdentifier, false, this.now());
	}

	purgeExpired(): Promise<number> {
		return this.store.purgeExpiredEvents(this.now());
	}

	private assertIntegrity(event: CoreEvent): void {
		const serializedPayload = canonicalizeJson(event.payload);
		const expectedChecksum = checksum(serializedPayload);
		const expectedSignature = signEvent(event, expectedChecksum, this.integrityKey);
		if (
			!safeEqual(event.payloadChecksum, expectedChecksum) ||
			!safeEqual(event.signature, expectedSignature)
		) {
			throw new CoreError(
				"infrastructure.unavailable",
				"The required infrastructure is unavailable.",
			);
		}
	}
}

type UnsignedEvent = Pick<
	CoreEvent,
	| "id"
	| "ownerIdentifier"
	| "topic"
	| "schemaVersion"
	| "occurredAt"
	| "receivedAt"
	| "retentionUntil"
	| "idempotencyKey"
>;

function checksum(serializedPayload: string): string {
	return createHash("sha256").update(serializedPayload).digest("hex");
}

function signEvent(event: UnsignedEvent, payloadChecksum: string, key: string): string {
	return createHmac("sha256", key)
		.update(
			JSON.stringify([
				event.id,
				event.ownerIdentifier,
				event.topic,
				event.schemaVersion,
				payloadChecksum,
				event.occurredAt.toISOString(),
				event.receivedAt.toISOString(),
				event.retentionUntil.toISOString(),
				event.idempotencyKey ?? null,
			]),
		)
		.digest("hex");
}

function canonicalizeJson(value: CoreJsonValue): string {
	if (value === null || typeof value === "boolean" || typeof value === "number") {
		return JSON.stringify(value);
	}
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
	const object = value as Readonly<Record<string, CoreJsonValue>>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(object[key]!)}`)
		.join(",")}}`;
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function validateIdentifier(value: string, label: string): string {
	const normalized = value.trim().toLowerCase();
	if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(normalized) || normalized.length > 160) {
		throw new CoreError("configuration.invalid", `The ${label} identifier is invalid.`);
	}
	return normalized;
}

function assertValidDate(value: Date, message: string): void {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
		throw new CoreError("configuration.invalid", message);
	}
}
