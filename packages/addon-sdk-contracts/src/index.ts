export interface FoundationIdentity {
	readonly packageName: string;
	readonly description: string;
	readonly status: "foundation";
}

export const foundation: FoundationIdentity = Object.freeze({
	packageName: "@compendlore/addon-sdk-contracts",
	description: "Point d'extraction futur des contrats publics du SDK",
	status: "foundation",
});
