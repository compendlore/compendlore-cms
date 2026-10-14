export interface AdministrationAssetIdentity {
	readonly userId: string;
	readonly isAdministrator: boolean;
	readonly secondFactorVerified: boolean;
	readonly sessionActive?: boolean;
	readonly secondFactorExpiresAt?: Date;
}

export interface AdministrationAsset {
	readonly contentType: string;
	readonly bytes: Uint8Array;
	readonly cacheControl?: string;
	readonly contentSecurityPolicy?: string;
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
	constructor(
		private readonly assets: AdministrationAssetRepository,
		private readonly now: () => Date = () => new Date(),
	) {}

	async deliver(
		identity: AdministrationAssetIdentity | undefined,
		requestedPath: string,
	): Promise<AdministrationAsset> {
		assertAdministrationAccess(identity, this.now());
		const path = normalizeAdministrationAssetPath(requestedPath);
		const asset = await this.assets.read(path);
		if (!asset)
			throw new AdministrationAssetAccessError(
				"administration.asset_not_found",
				404,
				"Administration asset not found.",
			);
		return Object.freeze({
			...asset,
			cacheControl: "no-store, private",
			contentSecurityPolicy:
				"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
		});
	}
}

export function assertAdministrationAccess(
	identity: AdministrationAssetIdentity | undefined,
	now = new Date(),
): asserts identity is AdministrationAssetIdentity {
	if (!identity?.isAdministrator || identity.sessionActive === false)
		throw new AdministrationAssetAccessError("authorization.denied", 403, "Access denied.");
	if (
		!identity.secondFactorVerified ||
		(identity.secondFactorExpiresAt !== undefined && identity.secondFactorExpiresAt <= now)
	)
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
