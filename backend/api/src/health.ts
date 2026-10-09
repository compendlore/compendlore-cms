import { api } from "encore.dev/api";

export interface HealthResponse {
	readonly status: "ok";
	readonly core: "phase-3-core";
}

export const health = api(
	{ expose: true, method: "GET", path: "/health" },
	async (): Promise<HealthResponse> => ({
		status: "ok",
		core: "phase-3-core",
	}),
);
