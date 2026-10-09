export interface FoundationIdentity {
	readonly packageName: string;
	readonly description: string;
	readonly status: "foundation";
}

export const foundation: FoundationIdentity = Object.freeze({
	packageName: "@compendlore/cms-registry",
	description: "Pont déclaratif entre le Core et les modules métier",
	status: "foundation",
});
