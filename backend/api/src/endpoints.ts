import { api } from "encore.dev/api";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiAudience, ApiHttpMethod } from "../../cms-registry/src/index.js";
import { ApiGateway, type ApiCredentials } from "./gateway.js";

const BODY_LIMIT = 1_048_576;
let configuredGateway: ApiGateway | undefined;

export function configureApiGateway(gateway: ApiGateway): void {
	if (configuredGateway && configuredGateway !== gateway) {
		throw new Error("An internal operation failed.");
	}
	configuredGateway = gateway;
}

export const internalGateway = api.raw(
	{
		expose: false,
		method: "*",
		path: "/internal/:contractVersion/*route",
		bodyLimit: 1_048_576,
		tags: ["gateway", "internal"],
		sensitive: true,
	},
	(request, response) => {
		void handle(request, response, "internal");
	},
);

export const siteGateway = api.raw(
	{
		expose: true,
		method: "*",
		path: "/api/site/:contractVersion/*route",
		bodyLimit: 1_048_576,
		tags: ["gateway", "site"],
		sensitive: true,
	},
	(request, response) => {
		void handle(request, response, "site");
	},
);

export const publicGateway = api.raw(
	{
		expose: true,
		method: "*",
		path: "/api/public/:contractVersion/*route",
		bodyLimit: 1_048_576,
		tags: ["gateway", "public"],
		sensitive: true,
	},
	(request, response) => {
		void handle(request, response, "public");
	},
);

async function handle(
	request: IncomingMessage,
	response: ServerResponse,
	audience: ApiAudience,
): Promise<void> {
	try {
		if (!configuredGateway) {
			writeJson(response, 503, {
				error: "api.unavailable",
				message: "La passerelle API n’est pas initialisée.",
			});
			return;
		}
		const method = normalizeMethod(request.method);
		const parsedUrl = new URL(request.url ?? "/", "http://cms.internal");
		const { version, route } = parseGatewayPath(parsedUrl.pathname, audience);
		const body =
			method === "GET" || method === "DELETE" ? queryAsObject(parsedUrl) : await readJson(request);
		const credentials = readCredentials(request);
		const idempotencyKey = header(request, "x-idempotency-key");
		const locale = header(request, "accept-language");
		const correlationId = header(request, "x-correlation-id");
		const result = await configuredGateway.invoke({
			audience,
			method,
			route,
			contractVersion: version,
			body,
			...(credentials ? { credentials } : {}),
			...(idempotencyKey ? { idempotencyKey } : {}),
			...(locale ? { locale } : {}),
			...(correlationId ? { correlationId } : {}),
		});
		response.setHeader("x-correlation-id", result.correlationId);
		writeJson(response, result.status, result.body);
	} catch {
		writeJson(response, 400, {
			error: "api.transport_invalid",
			message: "La requête de transport est invalide.",
		});
	}
}

function parseGatewayPath(
	pathname: string,
	audience: ApiAudience,
): { readonly version: string; readonly route: string } {
	const prefix = audience === "internal" ? "/internal/" : `/api/${audience}/`;
	if (!pathname.startsWith(prefix)) throw new Error("An internal operation failed.");
	const [version, ...segments] = pathname.slice(prefix.length).split("/");
	if (!version || segments.length === 0) throw new Error("An internal operation failed.");
	return {
		version: decodeURIComponent(version),
		route: `/${segments.map(decodeURIComponent).join("/")}`,
	};
}

function normalizeMethod(method: string | undefined): ApiHttpMethod {
	if (
		method === "DELETE" ||
		method === "GET" ||
		method === "PATCH" ||
		method === "POST" ||
		method === "PUT"
	) {
		return method;
	}
	throw new Error("An internal operation failed.");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > BODY_LIMIT) throw new Error("Corps trop volumineux.");
		chunks.push(buffer);
	}
	if (size === 0) return null;
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function queryAsObject(url: URL): Readonly<Record<string, string | readonly string[]>> {
	const output: Record<string, string | string[]> = {};
	for (const [key, value] of url.searchParams) {
		const existing = output[key];
		if (existing === undefined) output[key] = value;
		else if (Array.isArray(existing)) existing.push(value);
		else output[key] = [existing, value];
	}
	return output;
}

function readCredentials(request: IncomingMessage): ApiCredentials | undefined {
	const authorization = header(request, "authorization");
	const apiKey = header(request, "x-api-key");
	if (apiKey) return { apiKey };
	if (!authorization) return undefined;
	const separator = authorization.indexOf(" ");
	if (separator < 1) return undefined;
	const scheme = authorization.slice(0, separator).toLowerCase();
	const token = authorization.slice(separator + 1).trim();
	if (!token) return undefined;
	if (scheme === "bearer") return { oauthToken: token };
	if (scheme === "session") return { sessionToken: token };
	return undefined;
}

function header(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
	if (response.headersSent) return;
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(JSON.stringify(body));
}
