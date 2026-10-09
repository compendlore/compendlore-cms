import {
	SQLDatabase,
	type Primitive,
	type ResultRow,
	type Transaction,
} from "encore.dev/storage/sqldb";
import { CoreError } from "./src/errors.js";

export type SqlValue = Exclude<Primitive, undefined>;

export interface SqlStatement {
	readonly text: string;
	readonly values: readonly SqlValue[];
}

export function sql(strings: TemplateStringsArray, ...values: SqlValue[]): SqlStatement {
	return {
		text: strings.reduce(
			(statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ""),
			"",
		),
		values,
	};
}

export interface DatabaseResult<Row extends ResultRow = ResultRow> {
	readonly rows: readonly Row[];
	readonly rowCount: number;
}

export interface TransactionContext {
	query<Row extends ResultRow = ResultRow>(statement: SqlStatement): Promise<DatabaseResult<Row>>;
}

export interface CoreDatabase extends TransactionContext {
	readonly name: "core";
	start(): Promise<void>;
	stop(): Promise<void>;
	health(): Promise<"healthy" | "unhealthy">;
	transaction<Result>(
		operation: (transaction: TransactionContext) => Promise<Result>,
	): Promise<Result>;
}

interface EncoreQueryExecutor {
	rawQueryAll<Row extends ResultRow = ResultRow>(
		query: string,
		...params: Primitive[]
	): Promise<Row[]>;
}

class EncoreTransactionContext implements TransactionContext {
	constructor(private readonly transaction: Transaction) {}

	async query<Row extends ResultRow = ResultRow>(
		statement: SqlStatement,
	): Promise<DatabaseResult<Row>> {
		return execute<Row>(this.transaction, statement);
	}
}

export class EncoreCoreDatabase implements CoreDatabase {
	readonly name = "core" as const;

	constructor(private readonly database: SQLDatabase) {}

	async start(): Promise<void> {
		if ((await this.health()) !== "healthy") {
			throw new CoreError("infrastructure.unavailable", "PostgreSQL est indisponible.", {
				retryable: true,
			});
		}
	}

	async stop(): Promise<void> {
		// Encore possède et ferme le pool de connexions du Core.
	}

	async health(): Promise<"healthy" | "unhealthy"> {
		try {
			await this.database.rawQueryRow(/* pgsql */ "SELECT 1 AS healthy");
			return "healthy";
		} catch {
			return "unhealthy";
		}
	}

	async query<Row extends ResultRow = ResultRow>(
		statement: SqlStatement,
	): Promise<DatabaseResult<Row>> {
		return execute<Row>(this.database, statement);
	}

	async transaction<Result>(
		operation: (transaction: TransactionContext) => Promise<Result>,
	): Promise<Result> {
		await using transaction = await this.database.begin();
		try {
			const result = await operation(new EncoreTransactionContext(transaction));
			await transaction.commit();
			return result;
		} catch (error) {
			await transaction.rollback().catch(() => undefined);
			throw error;
		}
	}
}

const databaseResource = new SQLDatabase("core", {
	migrations: {
		path: "./migrations",
	},
});

export const coreDatabase: CoreDatabase = new EncoreCoreDatabase(databaseResource);

async function execute<Row extends ResultRow>(
	executor: EncoreQueryExecutor,
	statement: SqlStatement,
): Promise<DatabaseResult<Row>> {
	const rows = await executor.rawQueryAll<Row>(statement.text, ...statement.values);
	return { rows, rowCount: rows.length };
}
