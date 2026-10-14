import { randomUUID } from "node:crypto";
import { ApiGatewayError } from "./gateway.js";

const DEFAULT_INACTIVITY_MS = 300_000;
const DEFAULT_DIRECT_RECIPIENT_LIMIT = 50;
const MAXIMUM_PAYLOAD_BYTES = 1_048_576;
const messageKinds = new Set<RealtimeMessageKind>([
	"catalog-invalidation",
	"maintenance",
	"notification",
	"task-progress",
]);
const deliveryModes = new Set<RealtimeDeliveryMode>(["direct", "durable", "simple"]);

export type RealtimeMessageKind =
	"catalog-invalidation" | "maintenance" | "notification" | "task-progress";
export type RealtimeDeliveryMode = "direct" | "durable" | "simple";
export type RealtimeTarget =
	| { readonly kind: "all" }
	| { readonly kind: "group" | "role"; readonly identifier: string }
	| { readonly kind: "user"; readonly identifier: string }
	| { readonly kind: "users"; readonly identifiers: readonly string[] };

export interface RealtimeConnectionIdentity {
	readonly userId: string;
	readonly groups: ReadonlySet<string>;
	readonly roles: ReadonlySet<string>;
}

export interface RealtimeMessage {
	readonly id: string;
	readonly sequence: number;
	readonly kind: RealtimeMessageKind;
	readonly mode: RealtimeDeliveryMode;
	readonly target: RealtimeTarget;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly createdAt: Date;
	readonly expiresAt: Date;
	readonly acknowledgementTimeoutMs?: number;
	readonly retryLimit?: number;
}

export interface SendRealtimeMessageInput {
	readonly kind: RealtimeMessageKind;
	readonly mode: RealtimeDeliveryMode;
	readonly target: RealtimeTarget;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly ttlMs: number;
	readonly acknowledgementTimeoutMs?: number;
	readonly retryLimit?: number;
}

interface ConnectionState {
	readonly id: string;
	readonly identity: RealtimeConnectionIdentity;
	lastActivityAt: number;
	lastDeliveredSequence: number;
}

interface DeliveryState {
	readonly connectionId: string;
	readonly messageId: string;
	attempts: number;
	nextAttemptAt: number;
	acknowledgedAt?: number;
}

export class RealtimeHub {
	private readonly connections = new Map<string, ConnectionState>();
	private readonly messages: RealtimeMessage[] = [];
	private readonly deliveries = new Map<string, DeliveryState>();
	private readonly connectedRecipients = new Map<string, ReadonlySet<string>>();
	private nextSequence = 1;

	constructor(
		private readonly inactivityMs = DEFAULT_INACTIVITY_MS,
		private readonly maximumDirectRecipients = DEFAULT_DIRECT_RECIPIENT_LIMIT,
		private readonly now: () => Date = () => new Date(),
	) {}

	open(identity: RealtimeConnectionIdentity, afterSequence = 0): string {
		if (!identity.userId.trim() || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
			throw new ApiGatewayError("realtime.connection_invalid", 400, "Realtime connection invalid.");
		}
		const id = randomUUID();
		this.connections.set(id, {
			id,
			identity,
			lastActivityAt: this.now().getTime(),
			lastDeliveredSequence: afterSequence,
		});
		return id;
	}

	touch(connectionId: string): void {
		const connection = this.requireActive(connectionId);
		connection.lastActivityAt = this.now().getTime();
	}

	close(connectionId: string): void {
		this.connections.delete(connectionId);
	}

	send(input: SendRealtimeMessageInput): RealtimeMessage {
		validateMessage(input);
		const now = this.now();
		const recipients = [...this.connections.values()].filter((connection) =>
			matchesTarget(connection.identity, input.target),
		);
		if (input.mode === "direct") {
			if (input.target.kind === "all") {
				throw new ApiGatewayError(
					"realtime.mass_direct_forbidden",
					400,
					"Realtime mass direct forbidden.",
				);
			}
			if (recipients.length > this.maximumDirectRecipients) {
				throw new ApiGatewayError(
					"realtime.direct_limit_exceeded",
					400,
					"Realtime direct limit exceeded.",
				);
			}
		}
		const message: RealtimeMessage = {
			id: randomUUID(),
			sequence: this.nextSequence,
			kind: input.kind,
			mode: input.mode,
			target: input.target,
			payload: structuredClone(input.payload),
			createdAt: now,
			expiresAt: new Date(now.getTime() + input.ttlMs),
			...(input.mode === "direct"
				? {
						acknowledgementTimeoutMs: input.acknowledgementTimeoutMs ?? 5_000,
						retryLimit: input.retryLimit ?? 3,
					}
				: {}),
		};
		this.nextSequence += 1;
		this.messages.push(message);
		if (message.mode !== "durable") {
			this.connectedRecipients.set(
				message.id,
				new Set(recipients.map((recipient) => recipient.id)),
			);
		}
		if (message.mode === "direct") {
			for (const recipient of recipients) {
				this.deliveries.set(deliveryKey(recipient.id, message.id), {
					connectionId: recipient.id,
					messageId: message.id,
					attempts: 0,
					nextAttemptAt: now.getTime(),
				});
			}
		}
		return message;
	}

	poll(connectionId: string, limit = 100): readonly RealtimeMessage[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new ApiGatewayError("realtime.limit_invalid", 400, "Realtime limit invalid.");
		}
		const connection = this.requireActive(connectionId);
		const now = this.now().getTime();
		const messages = this.messages
			.filter(
				(message) =>
					(message.mode === "direct" || message.sequence > connection.lastDeliveredSequence) &&
					message.expiresAt.getTime() > now &&
					matchesTarget(connection.identity, message.target) &&
					(message.mode === "durable" ||
						this.connectedRecipients.get(message.id)?.has(connection.id)) &&
					(message.mode !== "direct" || this.directDeliveryDue(connection.id, message, now)),
			)
			.slice(0, limit);
		if (messages.length > 0) {
			connection.lastDeliveredSequence = Math.max(
				connection.lastDeliveredSequence,
				...messages.map((message) => message.sequence),
			);
		}
		for (const message of messages) {
			if (message.mode !== "direct") continue;
			const delivery = this.deliveries.get(deliveryKey(connection.id, message.id));
			if (!delivery) continue;
			delivery.attempts += 1;
			delivery.nextAttemptAt = now + message.acknowledgementTimeoutMs!;
		}
		return messages;
	}

	acknowledge(connectionId: string, messageId: string): void {
		this.requireActive(connectionId);
		const delivery = this.deliveries.get(deliveryKey(connectionId, messageId));
		if (!delivery) {
			throw new ApiGatewayError(
				"realtime.acknowledgement_invalid",
				404,
				"Realtime acknowledgement invalid.",
			);
		}
		delivery.acknowledgedAt = this.now().getTime();
	}

	retryDue(): readonly { readonly connectionId: string; readonly messageId: string }[] {
		this.disconnectInactive();
		const now = this.now().getTime();
		const due: { connectionId: string; messageId: string }[] = [];
		for (const delivery of this.deliveries.values()) {
			if (delivery.acknowledgedAt || !this.connections.has(delivery.connectionId)) continue;
			const message = this.messages.find((candidate) => candidate.id === delivery.messageId);
			if (
				message &&
				message.expiresAt.getTime() > now &&
				delivery.attempts < message.retryLimit! &&
				delivery.nextAttemptAt <= now
			) {
				due.push({ connectionId: delivery.connectionId, messageId: delivery.messageId });
			}
		}
		return due;
	}

	disconnectInactive(): readonly string[] {
		const threshold = this.now().getTime() - this.inactivityMs;
		const disconnected: string[] = [];
		for (const [id, connection] of this.connections) {
			if (connection.lastActivityAt <= threshold) {
				this.connections.delete(id);
				disconnected.push(id);
			}
		}
		return disconnected;
	}

	private directDeliveryDue(connectionId: string, message: RealtimeMessage, now: number): boolean {
		const delivery = this.deliveries.get(deliveryKey(connectionId, message.id));
		return Boolean(
			delivery &&
			!delivery.acknowledgedAt &&
			delivery.attempts < message.retryLimit! &&
			delivery.nextAttemptAt <= now,
		);
	}

	private requireActive(connectionId: string): ConnectionState {
		this.disconnectInactive();
		const connection = this.connections.get(connectionId);
		if (!connection) {
			throw new ApiGatewayError("realtime.connection_closed", 410, "Realtime connection closed.");
		}
		return connection;
	}
}

function validateMessage(input: SendRealtimeMessageInput): void {
	if (!messageKinds.has(input.kind) || !deliveryModes.has(input.mode)) {
		throw new ApiGatewayError("realtime.message_invalid", 400, "Realtime message invalid.");
	}
	validateTarget(input.target);
	if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > 604_800_000) {
		throw new ApiGatewayError("realtime.message_invalid", 400, "Realtime message invalid.");
	}
	if (input.mode === "direct") {
		if (
			input.acknowledgementTimeoutMs !== undefined &&
			(!Number.isSafeInteger(input.acknowledgementTimeoutMs) ||
				input.acknowledgementTimeoutMs < 100)
		) {
			throw new ApiGatewayError("realtime.message_invalid", 400, "Realtime message invalid.");
		}
		if (
			input.retryLimit !== undefined &&
			(!Number.isSafeInteger(input.retryLimit) || input.retryLimit < 1 || input.retryLimit > 10)
		) {
			throw new ApiGatewayError("realtime.message_invalid", 400, "Realtime message invalid.");
		}
	} else if (input.acknowledgementTimeoutMs !== undefined || input.retryLimit !== undefined) {
		throw new ApiGatewayError("realtime.message_invalid", 400, "Realtime message invalid.");
	}
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(input.payload);
	} catch {
		throw new ApiGatewayError("realtime.message_invalid", 400, "Realtime message invalid.");
	}
	if (!serialized || Buffer.byteLength(serialized, "utf8") > MAXIMUM_PAYLOAD_BYTES) {
		throw new ApiGatewayError("realtime.message_invalid", 400, "Realtime message invalid.");
	}
}

function validateTarget(target: RealtimeTarget): void {
	if (target.kind === "all") return;
	if (target.kind === "users") {
		if (
			target.identifiers.length === 0 ||
			target.identifiers.length > 10_000 ||
			new Set(target.identifiers).size !== target.identifiers.length ||
			target.identifiers.some((identifier) => !validTargetIdentifier(identifier))
		) {
			throw new ApiGatewayError("realtime.target_invalid", 400, "Realtime target invalid.");
		}
		return;
	}
	if (
		!["group", "role", "user"].includes(target.kind) ||
		!validTargetIdentifier(target.identifier)
	) {
		throw new ApiGatewayError("realtime.target_invalid", 400, "Realtime target invalid.");
	}
}

function validTargetIdentifier(identifier: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(identifier);
}

function matchesTarget(identity: RealtimeConnectionIdentity, target: RealtimeTarget): boolean {
	if (target.kind === "all") return true;
	if (target.kind === "user") return target.identifier === identity.userId;
	if (target.kind === "users") return target.identifiers.includes(identity.userId);
	if (target.kind === "group") return identity.groups.has(target.identifier);
	return identity.roles.has(target.identifier);
}

function deliveryKey(connectionId: string, messageId: string): string {
	return `${connectionId}\0${messageId}`;
}
