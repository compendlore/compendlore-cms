export const foundation = Object.freeze({
	packageName: "@compendlore/cms-registry",
	description: "Pont déclaratif entre le Core et les modules métier",
	status: "operational",
});

export * from "./contracts.js";
export * from "./messaging.js";
export * from "./statistics.js";
export type { RegisteredMethodContext, RegisteredMethodHandler } from "./dispatcher.js";
export { RegistryError } from "./errors.js";
export { CmsRegistry, createInMemoryCmsRegistry } from "./registry.js";
export * from "./schema.js";
