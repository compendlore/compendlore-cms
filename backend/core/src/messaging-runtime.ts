import { CoreError } from "./errors.js";

export interface OutboxMessage<TPayload = Readonly<Record<string, unknown>>> {
	readonly id: string;
	readonly payload: TPayload;
	readonly attemptCount: number;
	readonly availableAt: Date;
}

export interface OutboxPort<TPayload = Readonly<Record<string, unknown>>> {
	claim(limit: number, now: Date): Promise<readonly OutboxMessage<TPayload>[]>;
	published(id: string, at: Date): Promise<void>;
	retry(id: string, input: { readonly at: Date; readonly errorCode: string }): Promise<void>;
	deadLetter(id: string, input: { readonly at: Date; readonly reasonCode: string }): Promise<void>;
}

export interface OutboxPublisher<TPayload = Readonly<Record<string, unknown>>> {
	publish(message: OutboxMessage<TPayload>): Promise<void>;
}

export interface OutboxDispatchReport {
	readonly claimed: number;
	readonly published: number;
	readonly retried: number;
	readonly deadLettered: number;
}

export class ReliableOutboxDispatcher<TPayload = Readonly<Record<string, unknown>>> {
	constructor(
		private readonly outbox: OutboxPort<TPayload>,
		private readonly publisher: OutboxPublisher<TPayload>,
		private readonly maximumAttempts = 5,
		private readonly baseRetryDelayMs = 1_000,
		private readonly now: () => Date = () => new Date(),
	) {
		if (maximumAttempts < 1 || baseRetryDelayMs < 1) {
			throw new CoreError("configuration.invalid", "La politique de reprise est invalide.");
		}
	}

	async dispatch(limit = 100): Promise<OutboxDispatchReport> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
			throw new CoreError("configuration.invalid", "La taille du lot d’outbox est invalide.");
		}
		const startedAt = this.now();
		const messages = await this.outbox.claim(limit, startedAt);
		let published = 0;
		let retried = 0;
		let deadLettered = 0;
		for (const message of messages) {
			try {
				await this.publisher.publish(message);
				await this.outbox.published(message.id, this.now());
				published += 1;
			} catch (error) {
				const attempt = message.attemptCount + 1;
				const errorCode = safeErrorCode(error);
				if (attempt >= this.maximumAttempts) {
					await this.outbox.deadLetter(message.id, {
						at: this.now(),
						reasonCode: errorCode,
					});
					deadLettered += 1;
				} else {
					const delay = this.baseRetryDelayMs * 2 ** Math.min(attempt - 1, 16);
					await this.outbox.retry(message.id, {
						at: new Date(this.now().getTime() + delay),
						errorCode,
					});
					retried += 1;
				}
			}
		}
		return { claimed: messages.length, published, retried, deadLettered };
	}
}

function safeErrorCode(error: unknown): string {
	if (
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string" &&
		/^[a-z][a-z0-9._-]{0,159}$/.test(error.code)
	) {
		return error.code;
	}
	return "messaging.delivery_failed";
}
