import { api } from "encore.dev/api";

export interface HealthResponse {
	readonly status: "ok";
	readonly components: {
		readonly core: "operational";
		readonly gateway: "operational";
		readonly registry: "operational";
	};
}

export const health = api(
	{ expose: true, method: "GET", path: "/health" },
	async (): Promise<HealthResponse> => ({
		status: "ok",
		components: {
			core: "operational",
			gateway: "operational",
			registry: "operational",
		},
	}),
);
