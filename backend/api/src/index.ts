export interface FoundationIdentity {
	readonly packageName: string;
	readonly description: string;
	readonly status: "foundation";
}

export const foundation: FoundationIdentity = Object.freeze({
	packageName: "@compendlore/api",
	description: "Façade API du CMS",
	status: "foundation",
});

export * from "./gateway.js";
export * from "./administration-assets.js";
export * from "./realtime.js";
export * from "./native-catalog.js";
