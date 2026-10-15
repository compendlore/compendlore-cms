import { useEffect, useState } from "react";

export interface PageProjectionView {
	readonly identifier: string;
	readonly component: string;
	readonly title: string;
	readonly content: readonly PageContentBlockView[];
	readonly revision: number;
	readonly fingerprint: string;
}

export interface PageContentBlockView {
	readonly kind: "card" | "header";
	readonly eyebrow?: string;
	readonly title: string;
	readonly description?: string;
}

export interface PageProjectionRequest {
	readonly path: string;
	readonly surface: "administration" | "site";
	readonly locale: string;
	readonly signal?: AbortSignal;
}

export class PageProjectionClient {
	constructor(private readonly endpoint = "/backend/api/site/v1/pages/resolve") {}

	async load(request: PageProjectionRequest): Promise<PageProjectionView | undefined> {
		const url = new URL(this.endpoint, window.location.origin);
		url.searchParams.set("path", request.path);
		url.searchParams.set("surface", request.surface);
		const response = await fetch(url, {
			headers: { accept: "application/json", "accept-language": request.locale },
			credentials: "same-origin",
			...(request.signal ? { signal: request.signal } : {}),
		});
		if (response.status === 404) return undefined;
		if (!response.ok) throw new Error("The page projection is unavailable.");
		return parsePageProjection(await response.json());
	}
}

export function parsePageProjection(value: unknown): PageProjectionView {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	const projection = value as Record<string, unknown>;
	return {
		identifier: identifier(projection.identifier),
		component: identifier(projection.component),
		title: text(projection.title),
		content: array(projection.content).map(pageContentBlock),
		revision: positiveInteger(projection.revision),
		fingerprint: fingerprint(projection.fingerprint),
	};
}

function pageContentBlock(value: unknown): PageContentBlockView {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	const block = value as Record<string, unknown>;
	if (block.kind !== "card" && block.kind !== "header") throw invalid();
	return {
		kind: block.kind,
		title: text(block.title),
		...(block.eyebrow === undefined ? {} : { eyebrow: text(block.eyebrow) }),
		...(block.description === undefined ? {} : { description: text(block.description) }),
	};
}

function array(value: unknown): readonly unknown[] {
	if (!Array.isArray(value) || value.length > 100) throw invalid();
	return value;
}

const pageProjectionClient = new PageProjectionClient();

export function usePageProjection(
	request: Omit<PageProjectionRequest, "signal">,
	fallback: PageProjectionView | undefined,
	enabled = true,
): PageProjectionView | undefined {
	const [projection, setProjection] = useState(fallback);
	useEffect(() => {
		if (!enabled) {
			setProjection(fallback);
			return;
		}
		const controller = new AbortController();
		void pageProjectionClient
			.load({ ...request, signal: controller.signal })
			.then(setProjection)
			.catch((error: unknown) => {
				if (!(error instanceof DOMException && error.name === "AbortError"))
					setProjection(fallback);
			});
		return () => controller.abort();
	}, [request.locale, request.path, request.surface, fallback, enabled]);
	return projection;
}

function identifier(value: unknown): string {
	if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value))
		throw invalid();
	return value;
}

function text(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 500) throw invalid();
	return value;
}

function positiveInteger(value: unknown): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalid();
	return Number(value);
}

function fingerprint(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw invalid();
	return value;
}

function invalid(): Error {
	return new Error("The page projection is invalid.");
}
