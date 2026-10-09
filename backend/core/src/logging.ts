export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
	readonly timestamp: string;
	readonly level: LogLevel;
	readonly event: string;
	readonly correlationId?: string;
	readonly context: Readonly<Record<string, unknown>>;
}

export interface CoreLogger {
	write(level: LogLevel, event: string, context?: Readonly<Record<string, unknown>>): void;
}

const sensitiveKey = /authorization|cookie|email|password|secret|token/i;

export function redactLogContext(
	context: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return Object.fromEntries(
		Object.entries(context).map(([key, value]) => [
			key,
			sensitiveKey.test(key) ? "[REDACTED]" : value,
		]),
	);
}

export class MemoryLogger implements CoreLogger {
	readonly entries: LogEntry[] = [];

	constructor(private readonly now: () => Date = () => new Date()) {}

	write(level: LogLevel, event: string, context: Readonly<Record<string, unknown>> = {}): void {
		this.entries.push({
			timestamp: this.now().toISOString(),
			level,
			event,
			context: redactLogContext(context),
		});
	}
}
