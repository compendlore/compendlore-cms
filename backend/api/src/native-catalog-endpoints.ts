import { api } from "encore.dev/api";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	NativeCatalogAccessError,
	NativeCatalogUnavailableError,
	readConfiguredNativeCatalog,
} from "./native-catalog.js";

export const siteNativeCatalog = api.raw(
	{
		expose: true,
		method: "GET",
		path: "/api/catalog/site",
		tags: ["catalog", "site"],
	},
	(request, response) => void handleCatalog(request, response, "site"),
);

export const administrationNativeCatalog = api.raw(
	{
		expose: true,
		method: "GET",
		path: "/api/catalog/administration",
		tags: ["catalog", "administration"],
		sensitive: true,
	},
	(request, response) => void handleCatalog(request, response, "administration"),
);

async function handleCatalog(
	request: IncomingMessage,
	response: ServerResponse,
	surface: "administration" | "site",
): Promise<void> {
	try {
		write(response, 200, await readConfiguredNativeCatalog(request, surface));
	} catch (error) {
		if (
			error instanceof NativeCatalogAccessError ||
			error instanceof NativeCatalogUnavailableError
		) {
			write(response, error.httpStatus, { error: error.code });
			return;
		}
		write(response, 500, { error: "catalog.internal" });
	}
}

function write(response: ServerResponse, status: number, body: unknown): void {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(JSON.stringify(body));
}
