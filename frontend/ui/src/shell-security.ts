export type AdministrationSessionStatus = "authenticated" | "expired" | "revoked";

export interface AdministrationSessionSnapshot {
	readonly status: AdministrationSessionStatus;
	readonly subjectIdentifier: string;
	readonly roles: readonly string[];
	readonly capabilities: ReadonlySet<string>;
	readonly secondFactorVerified: boolean;
	readonly secondFactorExpiresAt?: number;
	readonly revision: string;
}

export function parseAdministrationSessionSnapshot(value: unknown): AdministrationSessionSnapshot {
	if (!isRecord(value)) throw new Error("Administration session payload must be an object.");
	if (
		!isStatus(value.status) ||
		typeof value.subjectIdentifier !== "string" ||
		!isStringArray(value.roles) ||
		!isStringArray(value.capabilities) ||
		typeof value.secondFactorVerified !== "boolean" ||
		typeof value.revision !== "string" ||
		(value.secondFactorExpiresAt !== undefined && typeof value.secondFactorExpiresAt !== "number")
	) {
		throw new Error("Administration session payload is invalid.");
	}
	return Object.freeze({
		status: value.status,
		subjectIdentifier: value.subjectIdentifier,
		roles: Object.freeze([...value.roles]),
		capabilities: new Set(value.capabilities),
		secondFactorVerified: value.secondFactorVerified,
		...(value.secondFactorExpiresAt === undefined
			? {}
			: { secondFactorExpiresAt: value.secondFactorExpiresAt }),
		revision: value.revision,
	});
}

export function hasAdministrationShellAccess(
	session: AdministrationSessionSnapshot,
	now = Date.now(),
): boolean {
	return (
		session.status === "authenticated" &&
		session.roles.includes("administrator") &&
		session.capabilities.has("core.administration.access") &&
		session.secondFactorVerified &&
		(session.secondFactorExpiresAt === undefined || session.secondFactorExpiresAt > now)
	);
}

export interface AdministrationSessionGuardPorts {
	readonly purgeSensitiveState: () => void;
	readonly leaveAdministration: () => void;
}

export class AdministrationSessionGuard {
	private revoked = false;

	constructor(private readonly ports: AdministrationSessionGuardPorts) {}

	revalidate(session: AdministrationSessionSnapshot, now = Date.now()): boolean {
		if (hasAdministrationShellAccess(session, now)) return true;
		this.revoke();
		return false;
	}

	revoke(): void {
		if (this.revoked) return;
		this.revoked = true;
		this.ports.purgeSensitiveState();
		this.ports.leaveAdministration();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStatus(value: unknown): value is AdministrationSessionStatus {
	return value === "authenticated" || value === "expired" || value === "revoked";
}
