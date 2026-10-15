import { useEffect, useState } from "react";

export type RegistryAdministrationAction = "activate" | "disable" | "repair" | "withdraw";

export interface RegistryAdministrationItemView {
	readonly key: string;
	readonly identifier: string;
	readonly type: string;
	readonly state: string;
	readonly version: string;
	readonly owner: { readonly kind: string; readonly identifier: string };
	readonly locked: boolean;
	readonly dependencies: readonly string[];
	readonly dependents: readonly string[];
	readonly blockers: readonly string[];
	readonly allowedActions: readonly RegistryAdministrationAction[];
	readonly error?: string;
}

export interface RegistryAdministrationProjectionView {
	readonly generatedAt: string;
	readonly contributions: readonly RegistryAdministrationItemView[];
}

export class RegistryAdministrationClient {
	constructor(private readonly endpoint = "/backend/api/administration/v1/registry") {}

	async load(signal?: AbortSignal): Promise<RegistryAdministrationProjectionView> {
		const response = await fetch(this.endpoint, {
			headers: { accept: "application/json" },
			credentials: "same-origin",
			...(signal ? { signal } : {}),
		});
		if (!response.ok) throw new Error("The registry administration projection is unavailable.");
		return parseRegistryAdministrationProjection(await response.json());
	}
}

export function parseRegistryAdministrationProjection(
	value: unknown,
): RegistryAdministrationProjectionView {
	const projection = record(value);
	const generatedAt = text(projection.generatedAt);
	if (Number.isNaN(Date.parse(generatedAt))) throw invalid();
	return {
		generatedAt,
		contributions: array(projection.contributions).map(item),
	};
}

const client = new RegistryAdministrationClient();

export function useRegistryAdministrationProjection(
	fallback: RegistryAdministrationProjectionView,
	enabled = true,
): RegistryAdministrationProjectionView {
	const [projection, setProjection] = useState(fallback);
	useEffect(() => {
		if (!enabled) {
			setProjection(fallback);
			return;
		}
		const controller = new AbortController();
		void client
			.load(controller.signal)
			.then(setProjection)
			.catch((error: unknown) => {
				if (!(error instanceof DOMException && error.name === "AbortError"))
					setProjection(fallback);
			});
		return () => controller.abort();
	}, [enabled, fallback]);
	return projection;
}

function item(value: unknown): RegistryAdministrationItemView {
	const contribution = record(value);
	const owner = record(contribution.owner);
	const allowedActions = array(contribution.allowedActions).map(action);
	return {
		key: identifier(contribution.key),
		identifier: identifier(contribution.identifier),
		type: identifier(contribution.type),
		state: identifier(contribution.state),
		version: version(contribution.version),
		owner: { kind: identifier(owner.kind), identifier: identifier(owner.identifier) },
		locked: boolean(contribution.locked),
		dependencies: array(contribution.dependencies).map(identifier),
		dependents: array(contribution.dependents).map(identifier),
		blockers: array(contribution.blockers).map(identifier),
		allowedActions,
		...(contribution.error === undefined ? {} : { error: text(contribution.error) }),
	};
}

function action(value: unknown): RegistryAdministrationAction {
	if (!["activate", "disable", "repair", "withdraw"].includes(String(value))) throw invalid();
	return value as RegistryAdministrationAction;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
	if (!Array.isArray(value) || value.length > 500) throw invalid();
	return value;
}

function identifier(value: unknown): string {
	if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value))
		throw invalid();
	return value;
}

function version(value: unknown): string {
	if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value))
		throw invalid();
	return value;
}

function text(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 500) throw invalid();
	return value;
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw invalid();
	return value;
}

function invalid(): Error {
	return new Error("The registry administration projection is invalid.");
}
