import type { Primitive, ResultRow } from "encore.dev/storage/sqldb";

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
