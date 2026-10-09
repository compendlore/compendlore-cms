import { randomUUID } from "node:crypto";
import { CoreError } from "./errors.js";

export interface SecretProvider {
	resolve(reference: string): Promise<string>;
}

export interface SecretCipher {
	seal(value: string): string;
	open(value: string): string;
}

export class EnvironmentSecretProvider implements SecretProvider {
	constructor(private readonly environment: NodeJS.ProcessEnv) {}

	async resolve(reference: string): Promise<string> {
		if (!reference.startsWith("env:")) {
			throw new CoreError(
				"configuration.invalid",
				"Le fournisseur de secrets ne reconnaît pas cette référence.",
			);
		}
		const key = reference.slice(4);
		const value = this.environment[key];
		if (!key || !value) throw new CoreError("infrastructure.unavailable", "Secret indisponible.");
		return value;
	}
}

export interface ObjectStorage {
	put(key: string, content: Uint8Array, contentType: string): Promise<void>;
	get(key: string): Promise<Uint8Array | undefined>;
	delete(key: string): Promise<void>;
}

export class InMemoryObjectStorage implements ObjectStorage {
	private readonly objects = new Map<string, { content: Uint8Array; contentType: string }>();

	async put(key: string, content: Uint8Array, contentType: string): Promise<void> {
		this.objects.set(validateStorageKey(key), { content: content.slice(), contentType });
	}

	async get(key: string): Promise<Uint8Array | undefined> {
		return this.objects.get(validateStorageKey(key))?.content.slice();
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(validateStorageKey(key));
	}
}

export type CommunicationTarget =
	| { readonly kind: "all" }
	| { readonly kind: "group" | "role"; readonly id: string }
	| { readonly kind: "users"; readonly ids: readonly string[] };

export type CommunicationMode = "broadcast" | "direct" | "event";

export interface Communication {
	readonly id: string;
	readonly mode: CommunicationMode;
	readonly topic: string;
	readonly target: CommunicationTarget;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly createdAt: Date;
	readonly acknowledgementDeadlineMs?: number;
	readonly retryLimit?: number;
}

export interface CommunicationTransport {
	deliver(message: Communication): Promise<readonly string[]>;
}

export class CommunicationService {
	constructor(
		private readonly transport: CommunicationTransport,
		private readonly maximumDirectUsers = 50,
		private readonly now: () => Date = () => new Date(),
	) {}

	async send(
		message: Omit<Communication, "id" | "createdAt">,
	): Promise<{ readonly message: Communication; readonly recipients: readonly string[] }> {
		if (!message.topic.trim())
			throw new CoreError("configuration.invalid", "Le sujet est obligatoire.");
		if (message.mode === "direct") this.validateDirectTarget(message.target);
		const communication: Communication = {
			...message,
			id: randomUUID(),
			createdAt: this.now(),
		};
		return { message: communication, recipients: await this.transport.deliver(communication) };
	}

	private validateDirectTarget(target: CommunicationTarget): void {
		if (target.kind === "all" || target.kind === "role") {
			throw new CoreError(
				"authorization.denied",
				"Un envoi direct ne peut pas être un envoi de masse.",
			);
		}
		if (
			target.kind === "users" &&
			(target.ids.length === 0 || target.ids.length > this.maximumDirectUsers)
		) {
			throw new CoreError(
				"configuration.invalid",
				"Le nombre de destinataires directs est invalide.",
			);
		}
	}
}

export class RealtimePresence {
	private readonly activity = new Map<string, number>();

	constructor(
		private readonly inactivityMs = 300_000,
		private readonly now: () => Date = () => new Date(),
	) {}

	touch(connectionId: string): void {
		this.activity.set(connectionId, this.now().getTime());
	}

	activeConnections(): readonly string[] {
		const threshold = this.now().getTime() - this.inactivityMs;
		for (const [connectionId, activityAt] of this.activity) {
			if (activityAt <= threshold) this.activity.delete(connectionId);
		}
		return [...this.activity.keys()];
	}
}

export interface OutboundRequest {
	readonly url: URL;
	readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
}

export class OutboundGateway {
	constructor(
		private readonly allowedHosts: ReadonlySet<string>,
		private readonly request: typeof fetch = fetch,
		private readonly timeoutMs = 10_000,
	) {}

	async execute(input: OutboundRequest): Promise<Response> {
		if (input.url.protocol !== "https:" || input.url.username || input.url.password) {
			throw new CoreError("network.denied", "La destination externe n'est pas sûre.");
		}
		if (!this.allowedHosts.has(input.url.hostname.toLowerCase())) {
			throw new CoreError("network.denied", "La destination externe n'est pas autorisée.");
		}
		try {
			return await this.request(input.url, {
				method: input.method,
				...(input.headers ? { headers: input.headers } : {}),
				...(input.body === undefined ? {} : { body: input.body }),
				signal: AbortSignal.timeout(this.timeoutMs),
				redirect: "error",
			});
		} catch (error) {
			throw new CoreError("infrastructure.unavailable", "L'API externe est indisponible.", {
				cause: error,
				retryable: true,
			});
		}
	}
}

export interface ScheduledTask {
	readonly id: string;
	readonly type: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly executeAt: Date;
}

export class InMemoryTaskQueue {
	private readonly tasks = new Map<string, ScheduledTask>();

	schedule(task: Omit<ScheduledTask, "id">): ScheduledTask {
		const scheduled = { ...task, id: randomUUID() };
		this.tasks.set(scheduled.id, scheduled);
		return scheduled;
	}

	due(at: Date): readonly ScheduledTask[] {
		return [...this.tasks.values()].filter((task) => task.executeAt <= at);
	}

	complete(taskId: string): void {
		this.tasks.delete(taskId);
	}
}

function validateStorageKey(key: string): string {
	if (!/^[a-z0-9][a-z0-9/_\-.]{0,511}$/i.test(key) || key.includes("..") || key.startsWith("/")) {
		throw new CoreError("storage.invalid_key", "La clé de stockage est invalide.");
	}
	return key;
}
