import { CoreError } from "./errors.js";
import type { CoreInstallationState, CoreJsonValue, CoreStore } from "./store.js";

export class CoreSettingsService {
	constructor(private readonly store: CoreStore) {}

	async setUserPreference(userId: string, key: string, value: CoreJsonValue): Promise<void> {
		assertCoreKey(key);
		validateCoreJsonValue(value);
		await this.store.setUserPreference(userId, key, value);
	}

	getUserPreference(userId: string, key: string): Promise<CoreJsonValue | undefined> {
		assertCoreKey(key);
		return this.store.getUserPreference(userId, key);
	}

	async setInstanceSetting(key: string, value: CoreJsonValue): Promise<void> {
		assertCoreKey(key);
		validateCoreJsonValue(value);
		await this.store.setInstanceSetting(key, value);
	}

	getInstanceSetting(key: string): Promise<CoreJsonValue | undefined> {
		assertCoreKey(key);
		return this.store.getInstanceSetting(key);
	}
}

export class InstallationStateService {
	constructor(
		private readonly instanceId: string,
		private readonly store: CoreStore,
		private readonly now: () => Date = () => new Date(),
	) {}

	get(): Promise<CoreInstallationState | undefined> {
		return this.store.getInstallationState(this.instanceId);
	}

	async begin(lockOwner: string, bootstrapVersion: number): Promise<CoreInstallationState> {
		if (!lockOwner.trim() || !Number.isSafeInteger(bootstrapVersion) || bootstrapVersion <= 0) {
			throw new CoreError("configuration.invalid", "Le verrou d’installation est invalide.");
		}
		return this.store.transaction(async () => {
			const current = await this.store.getInstallationState(this.instanceId);
			if (current?.lockOwner && current.lockOwner !== lockOwner) {
				throw new CoreError("lifecycle.invalid_state", "L’installation est déjà verrouillée.");
			}
			const now = this.now();
			const next: CoreInstallationState = {
				instanceId: this.instanceId,
				status: "in-progress",
				bootstrapVersion,
				lockOwner: lockOwner.trim(),
				lockedAt: current?.lockedAt ?? now,
				updatedAt: now,
			};
			await this.store.setInstallationState(next);
			return next;
		});
	}

	async complete(lockOwner: string): Promise<CoreInstallationState> {
		return this.finish(lockOwner, "completed");
	}

	async fail(lockOwner: string, failureCode: string): Promise<CoreInstallationState> {
		if (!failureCode.trim()) {
			throw new CoreError("configuration.invalid", "Le code d’échec est obligatoire.");
		}
		return this.finish(lockOwner, "failed", failureCode.trim());
	}

	private async finish(
		lockOwner: string,
		status: "completed" | "failed",
		failureCode?: string,
	): Promise<CoreInstallationState> {
		return this.store.transaction(async () => {
			const current = await this.store.getInstallationState(this.instanceId);
			if (!current || current.status !== "in-progress" || current.lockOwner !== lockOwner) {
				throw new CoreError("lifecycle.invalid_state", "Le verrou d’installation est invalide.");
			}
			const now = this.now();
			const next: CoreInstallationState = {
				instanceId: this.instanceId,
				status,
				bootstrapVersion: current.bootstrapVersion,
				...(status === "completed" ? { completedAt: now } : {}),
				...(failureCode ? { failureCode } : {}),
				updatedAt: now,
			};
			await this.store.setInstallationState(next);
			return next;
		});
	}
}

function assertCoreKey(key: string): void {
	if (!/^core\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(key)) {
		throw new CoreError("configuration.invalid", "La clé de réglage Core est invalide.");
	}
}

export function validateCoreJsonValue(value: unknown, depth = 0): asserts value is CoreJsonValue {
	if (depth > 32) throw new CoreError("configuration.invalid", "La valeur JSON est trop profonde.");
	if (value === null || typeof value === "boolean" || typeof value === "string") return;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return;
		throw new CoreError("configuration.invalid", "La valeur numérique doit être finie.");
	}
	if (Array.isArray(value)) {
		for (const item of value) validateCoreJsonValue(item, depth + 1);
		return;
	}
	if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		for (const item of Object.values(value)) validateCoreJsonValue(item, depth + 1);
		return;
	}
	throw new CoreError("configuration.invalid", "La valeur doit être du JSON valide.");
}
