import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CoreError } from "./errors.js";
import type { CoreLogger } from "./logging.js";
import type { CoreStore } from "./store.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export interface InstallationTokenPublisher {
	publish(token: string): Promise<void>;
	clear(): Promise<void>;
	isAvailable?(): Promise<boolean>;
}

export class SecureFileInstallationTokenPublisher implements InstallationTokenPublisher {
	private readonly absolutePath: string;

	constructor(path: string) {
		this.absolutePath = resolve(path);
	}

	async publish(token: string): Promise<void> {
		await mkdir(dirname(this.absolutePath), { recursive: true });
		const temporaryPath = `${this.absolutePath}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await chmod(temporaryPath, 0o600);
			await rm(this.absolutePath, { force: true });
			await rename(temporaryPath, this.absolutePath);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	async clear(): Promise<void> {
		await rm(this.absolutePath, { force: true });
	}

	async isAvailable(): Promise<boolean> {
		try {
			await access(this.absolutePath);
			return true;
		} catch {
			return false;
		}
	}
}

export class InstallationTokenService {
	constructor(
		private readonly instanceId: string,
		private readonly store: CoreStore,
		private readonly publisher: InstallationTokenPublisher,
		private readonly logger: CoreLogger,
		private readonly ttlMs: number,
		private readonly now: () => Date = () => new Date(),
	) {}

	async ensureAvailable(): Promise<void> {
		if ((await this.store.countUsers()) > 0) {
			await this.clearPublishedToken();
			return;
		}

		const now = this.now();
		const current = await this.store.getInstallationToken(this.instanceId);
		if (
			current &&
			!current.consumedAt &&
			current.expiresAt.getTime() > now.getTime() &&
			((await this.publisher.isAvailable?.()) ?? true)
		) {
			return;
		}

		const token = randomBytes(32).toString("base64url");
		await this.store.transaction(async () => {
			const concurrent = await this.store.getInstallationToken(this.instanceId);
			if (
				concurrent &&
				!concurrent.consumedAt &&
				concurrent.expiresAt.getTime() > now.getTime() &&
				((await this.publisher.isAvailable?.()) ?? true)
			) {
				return;
			}
			await this.store.setInstallationToken({
				instanceId: this.instanceId,
				tokenDigest: digest(token),
				createdAt: now,
				expiresAt: new Date(now.getTime() + this.ttlMs),
			});
			await this.publisher.publish(token);
		});
		this.logger.write("info", "core.installation_token.created", {
			expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
		});
	}

	async consume(token: string, consumedAt: Date): Promise<boolean> {
		if (!token) return false;
		return this.store.consumeInstallationToken(this.instanceId, digest(token), consumedAt);
	}

	async complete(): Promise<void> {
		try {
			await this.publisher.clear();
		} catch {
			this.logger.write("error", "core.installation_token.clear_failed");
		}
	}

	private async clearPublishedToken(): Promise<void> {
		try {
			await this.publisher.clear();
		} catch (error) {
			this.logger.write("error", "core.installation_token.clear_failed");
			throw new CoreError(
				"infrastructure.unavailable",
				"Le fichier du jeton d’installation n’a pas pu être supprimé.",
				{ cause: error },
			);
		}
	}
}
