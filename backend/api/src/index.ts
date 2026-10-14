export interface FoundationIdentity {
	readonly packageName: string;
	readonly description: string;
	readonly status: "operational";
}

export const foundation: FoundationIdentity = Object.freeze({
	packageName: "@compendlore/api",
	description: "CMS API gateway",
	status: "operational",
});

export * from "./gateway.js";
export * from "./administration-assets.js";
export * from "./realtime.js";
