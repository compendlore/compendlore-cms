import { randomUUID } from "node:crypto";
import { sql, type CoreDatabase } from "./database.js";
import { CoreError } from "./src/errors.js";
import {
	validateScheduledTask,
	validateTaskLimit,
	type ScheduledTask,
	type TaskQueue,
} from "./src/services.js";

interface TaskRow {
	[key: string]: unknown;
	id: string;
	type: string;
	payload: Record<string, unknown>;
	execute_at: Date;
}

export class PostgresTaskQueue implements TaskQueue {
	constructor(private readonly database: CoreDatabase) {}

	async schedule(task: Omit<ScheduledTask, "id">): Promise<ScheduledTask> {
		validateScheduledTask(task);
		const id = randomUUID();
		await this.database.query(/* pgsql */ sql`
			INSERT INTO core.tasks (id, type, payload, execute_at)
			VALUES (${id}, ${task.type}, ${JSON.stringify(task.payload)}, ${task.executeAt})
		`);
		return { ...task, id };
	}

	async claimDue(at: Date, limit = 100): Promise<readonly ScheduledTask[]> {
		validateTaskLimit(limit);
		if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
			throw new CoreError("configuration.invalid", "La date de lecture est invalide.");
		}
		return this.database.transaction(async (transaction) => {
			const result = await transaction.query<TaskRow>(/* pgsql */ sql`
				WITH due AS (
					SELECT id
					FROM core.tasks
					WHERE status = 'pending' AND execute_at <= ${at}
					ORDER BY execute_at, created_at
					FOR UPDATE SKIP LOCKED
					LIMIT ${limit}
				)
				UPDATE core.tasks AS task
				SET status = 'running', attempts = task.attempts + 1
				FROM due
				WHERE task.id = due.id
				RETURNING task.id, task.type, task.payload, task.execute_at
			`);
			return result.rows
				.map(toScheduledTask)
				.sort((left, right) => left.executeAt.getTime() - right.executeAt.getTime());
		});
	}

	async complete(taskId: string): Promise<void> {
		await this.updateStatus(taskId, "completed");
	}

	async fail(taskId: string): Promise<void> {
		await this.updateStatus(taskId, "failed");
	}

	private async updateStatus(taskId: string, status: "completed" | "failed"): Promise<void> {
		const result = await this.database.query(/* pgsql */ sql`
			UPDATE core.tasks
			SET status = ${status}
			WHERE id = ${taskId} AND status = 'running'
			RETURNING id
		`);
		if (result.rowCount !== 1) {
			throw new CoreError("lifecycle.invalid_state", "La tâche n’est pas en cours d’exécution.");
		}
	}
}

function toScheduledTask(row: TaskRow): ScheduledTask {
	return {
		id: row.id,
		type: row.type,
		payload: row.payload,
		executeAt: row.execute_at,
	};
}
