import { randomUUID } from "node:crypto";
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
	constructor(
		private readonly store: CoreStore,
		private readonly now: () => Date = () => new Date(),
	) {}

	async publish(input: PublishCoreEventInput): Promise<CoreEvent> {
		const ownerIdentifier = validateIdentifier(input.ownerIdentifier, "propriétaire");
		const topic = validateIdentifier(input.topic, "sujet");
		if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion <= 0) {
			throw new CoreError(
				"configuration.invalid",
				"La version du schéma d’événement est invalide.",
			);
		}
		const receivedAt = this.now();
		const occurredAt = input.occurredAt ?? receivedAt;
		assertValidDate(occurredAt, "La date de l’événement est invalide.");
		assertValidDate(input.retentionUntil, "La date de conservation est invalide.");
		if (occurredAt.getTime() > receivedAt.getTime() + MAXIMUM_CLOCK_DRIFT_MS) {
			throw new CoreError("configuration.invalid", "L’événement est daté trop loin dans le futur.");
		}
		if (input.retentionUntil <= receivedAt) {
			throw new CoreError(
				"configuration.invalid",
				"La conservation de l’événement doit être future.",
			);
		}

		if (
			input.payload === null ||
			Array.isArray(input.payload) ||
			typeof input.payload !== "object" ||
			Object.getPrototypeOf(input.payload) !== Object.prototype
		) {
			throw new CoreError("configuration.invalid", "La charge utile doit être un objet JSON.");
		}
		validateCoreJsonValue(input.payload);
		const serializedPayload = JSON.stringify(input.payload);
		if (Buffer.byteLength(serializedPayload, "utf8") > MAXIMUM_PAYLOAD_BYTES) {
			throw new CoreError(
				"configuration.invalid",
				"La charge utile de l’événement est trop grande.",
			);
		}
		const payload = JSON.parse(serializedPayload) as Readonly<Record<string, CoreJsonValue>>;
		const idempotencyKey = input.idempotencyKey?.trim();
		if (idempotencyKey && idempotencyKey.length > 128) {
			throw new CoreError("configuration.invalid", "La clé d’idempotence est trop longue.");
		}

		const stored = await this.store.appendEvent({
			id: randomUUID(),
			ownerIdentifier,
			topic,
			schemaVersion: input.schemaVersion,
			payload,
			occurredAt: new Date(occurredAt),
			receivedAt,
			retentionUntil: new Date(input.retentionUntil),
			...(idempotencyKey ? { idempotencyKey } : {}),
		});
		if (
			idempotencyKey &&
			(stored.topic !== topic ||
				stored.schemaVersion !== input.schemaVersion ||
				JSON.stringify(stored.payload) !== serializedPayload)
		) {
			throw new CoreError(
				"configuration.invalid",
				"La clé d’idempotence désigne déjà un événement différent.",
			);
		}
		return stored;
	}

	async registerConsumer(input: RegisterCoreEventConsumerInput): Promise<CoreEventConsumer> {
		const identifier = validateIdentifier(input.identifier, "consommateur");
		const ownerIdentifier = validateIdentifier(input.ownerIdentifier, "propriétaire");
		const topics = [...new Set(input.topics.map((topic) => validateIdentifier(topic, "sujet")))];
		if (topics.length === 0 || topics.length > MAXIMUM_TOPICS_PER_CONSUMER) {
			throw new CoreError(
				"configuration.invalid",
				"La liste des sujets du consommateur est invalide.",
			);
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

	read(consumerIdentifier: string, batchSize = 100): Promise<readonly CoreEvent[]> {
		validateIdentifier(consumerIdentifier, "consommateur");
		if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > MAXIMUM_BATCH_SIZE) {
			throw new CoreError("configuration.invalid", "La taille du lot d’événements est invalide.");
		}
		return this.store.readEventsForConsumer(consumerIdentifier, batchSize);
	}

	acknowledge(consumerIdentifier: string, sequence: bigint): Promise<void> {
		validateIdentifier(consumerIdentifier, "consommateur");
		if (sequence < 0n) {
			throw new CoreError("configuration.invalid", "Le curseur d’événements est invalide.");
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
}

function validateIdentifier(value: string, label: string): string {
	const normalized = value.trim().toLowerCase();
	if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(normalized) || normalized.length > 160) {
		throw new CoreError("configuration.invalid", `L’identifiant de ${label} est invalide.`);
	}
	return normalized;
}

function assertValidDate(value: Date, message: string): void {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
		throw new CoreError("configuration.invalid", message);
	}
}
