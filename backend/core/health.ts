import { api } from "encore.dev/api";
import type { IncomingMessage, ServerResponse } from "node:http";
import { inspectEncoreCore } from "./encore-runtime.js";

export interface HealthResponse {
	readonly status: "ok" | "unavailable";
	readonly components: {
		readonly core: "operational" | "unavailable";
		readonly database: "operational" | "unavailable";
		readonly objectStorage: "operational" | "unavailable";
	};
}

export const health = api.raw(
	{ expose: true, method: "GET", path: "/health" },
	(_request: IncomingMessage, response: ServerResponse) => {
		void handleHealth(response);
	},
);

async function handleHealth(response: ServerResponse): Promise<void> {
	const health = await inspectEncoreCore();
	const databaseHealthy = health.services.core === "healthy";
	const objectStorageHealthy = health.services["object-storage"] === "healthy";
	const ready = health.live && health.ready && databaseHealthy && objectStorageHealthy;
	const body: HealthResponse = {
		status: ready ? "ok" : "unavailable",
		components: {
			core: ready ? "operational" : "unavailable",
			database: databaseHealthy ? "operational" : "unavailable",
			objectStorage: objectStorageHealthy ? "operational" : "unavailable",
		},
	};
	response.statusCode = ready ? 200 : 503;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(JSON.stringify(body));
}
