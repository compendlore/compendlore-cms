export interface AdministrationAssetIdentity {
	readonly userId: string;
	readonly isAdministrator: boolean;
	readonly secondFactorVerified: boolean;
}

export interface AdministrationAsset {
	readonly contentType: string;
	readonly bytes: Uint8Array;
}

export interface AdministrationAssetRepository {
	read(path: string): Promise<AdministrationAsset | undefined>;
}

export class AdministrationAssetAccessError extends Error {
	constructor(
		readonly code:
			| "administration.asset_not_found"
			| "administration.second_factor_required"
			| "authorization.denied",
		readonly status: 401 | 403 | 404,
		message: string,
	) {
		super(message);
		this.name = "AdministrationAssetAccessError";
	}
}

export class AdministrationBundleDelivery {
	constructor(private readonly assets: AdministrationAssetRepository) {}

	async deliver(
		identity: AdministrationAssetIdentity | undefined,
		requestedPath: string,
	): Promise<AdministrationAsset> {
		assertAdministrationAccess(identity);
		const path = normalizeAdministrationAssetPath(requestedPath);
		const asset = await this.assets.read(path);
		if (!asset)
			throw new AdministrationAssetAccessError(
				"administration.asset_not_found",
				404,
				"Administration asset not found.",
			);
		return asset;
	}
}

export function assertAdministrationAccess(
	identity: AdministrationAssetIdentity | undefined,
): asserts identity is AdministrationAssetIdentity {
	if (!identity?.isAdministrator)
		throw new AdministrationAssetAccessError("authorization.denied", 403, "Access denied.");
	if (!identity.secondFactorVerified)
		throw new AdministrationAssetAccessError(
			"administration.second_factor_required",
			401,
			"Administration second factor required.",
		);
}

export function normalizeAdministrationAssetPath(requestedPath: string): string {
	const path =
		requestedPath === "" || requestedPath === "/"
			? "index.html"
			: requestedPath.replace(/^\/+/, "");
	if (!/^(?:index\.html|assets\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(path) || path.endsWith(".map")) {
		throw new AdministrationAssetAccessError(
			"administration.asset_not_found",
			404,
			"Administration asset not found.",
		);
	}
	return path;
}
