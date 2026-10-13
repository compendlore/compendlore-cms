import { NativeContentRegistry } from "../../cms-registry/src/index.js";
import { nativeSiteContribution } from "../../site/src/native-contributions.js";
import {
	NativeCatalogApi,
	type NativeCatalogIdentity,
	type NativeCatalogIdentityResolver,
} from "./native-catalog.js";

export interface NativeCatalogRuntime {
	readonly catalog: NativeCatalogApi;
	readonly identities: NativeCatalogIdentityResolver;
}

export function createNativeCatalogRuntime(): NativeCatalogRuntime {
	const registry = new NativeContentRegistry();
	registry.register(nativeSiteContribution);
	return {
		catalog: new NativeCatalogApi(registry),
		identities: new AnonymousNativeCatalogIdentityResolver(),
	};
}

class AnonymousNativeCatalogIdentityResolver implements NativeCatalogIdentityResolver {
	async resolve(): Promise<NativeCatalogIdentity> {
		return {
			authenticated: false,
			capabilities: new Set(),
			permissions: new Set(),
			roles: new Set(),
		};
	}
}
