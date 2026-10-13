import { randomUUID } from "node:crypto";
import { CoreError } from "./errors.js";
import type { CoreLogger } from "./logging.js";
import type { CoreStore } from "./store.js";

export type ServiceHealth = "healthy" | "unhealthy";

export interface ManagedCoreService {
	readonly name: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	health(): Promise<ServiceHealth>;
}

export type RuntimeState = "created" | "starting" | "running" | "stopping" | "stopped" | "failed";

export class CoreRuntime {
	private active: ManagedCoreService[] = [];
	private currentState: RuntimeState = "created";

	constructor(
		private readonly services: readonly ManagedCoreService[],
		private readonly logger: CoreLogger,
		private readonly shutdownTimeoutMs = 10_000,
	) {}

	get state(): RuntimeState {
		return this.currentState;
	}

	async start(): Promise<void> {
		if (!(this.currentState === "created" || this.currentState === "stopped")) {
			throw new CoreError("lifecycle.invalid_state", "Le Core ne peut pas démarrer dans cet état.");
		}
		this.currentState = "starting";
		try {
			for (const service of this.services) {
				await service.start();
				this.active.push(service);
			}
			this.currentState = "running";
			this.logger.write("info", "core.started", { serviceCount: this.active.length });
		} catch (error) {
			this.currentState = "failed";
			await this.stopActive();
			this.logger.write("error", "core.start_failed");
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.currentState === "stopped") return;
		this.currentState = "stopping";
		await this.stopActive();
		this.currentState = "stopped";
		this.logger.write("info", "core.stopped");
	}

	async health(): Promise<{
		readonly live: boolean;
		readonly ready: boolean;
		readonly services: Readonly<Record<string, ServiceHealth>>;
	}> {
		const entries = await Promise.all(
			this.active.map(async (service) => [service.name, await service.health()] as const),
		);
		return {
			live: this.currentState !== "failed",
			ready: this.currentState === "running" && entries.every(([, health]) => health === "healthy"),
			services: Object.fromEntries(entries),
		};
	}

	private async stopActive(): Promise<void> {
		for (const service of this.active.reverse()) {
			try {
				await withTimeout(service.stop(), this.shutdownTimeoutMs);
			} catch (error) {
				this.logger.write("error", "core.service_stop_failed", {
					service: service.name,
					reason: error instanceof ShutdownTimeoutError ? "timeout" : "failure",
				});
			}
		}
		this.active = [];
	}
}

class ShutdownTimeoutError extends Error {}

async function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new ShutdownTimeoutError()), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

export async function ensureInstanceIdentity(store: CoreStore): Promise<string> {
	const existing = await store.getInstanceId();
	if (existing) return existing;
	return store.transaction(async () => {
		const concurrent = await store.getInstanceId();
		if (concurrent) return concurrent;
		const instanceId = randomUUID();
		await store.setInstanceId(instanceId);
		return (await store.getInstanceId()) ?? instanceId;
	});
}
