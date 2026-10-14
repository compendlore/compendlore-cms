export interface RichBrandSegmentView {
	readonly identifier: string;
	readonly text: string;
	readonly styleSlot?: string;
}

export interface RichBrandView {
	readonly accessibleLabel: string;
	readonly segments: readonly RichBrandSegmentView[];
	readonly logoSource?: string;
}

export function isSafeThemeBrandLogoSource(source: string | undefined): source is string {
	return source !== undefined && /^\/theme-assets\/[a-z0-9][a-z0-9._/-]*$/i.test(source);
}

export function resolveRichBrandAccessibleLabel(
	brand: RichBrandView | undefined,
	fallbackLabel: string,
): string {
	const label = brand?.accessibleLabel.trim();
	return label && label.length <= 160 ? label : fallbackLabel;
}

export function RichBrandContent({
	brand,
	fallbackLabel,
}: {
	readonly brand?: RichBrandView | undefined;
	readonly fallbackLabel: string;
}) {
	const segments = brand?.segments.filter((segment) => segment.text.length > 0) ?? [];
	const logoSource = isSafeThemeBrandLogoSource(brand?.logoSource) ? brand.logoSource : undefined;
	return (
		<>
			{logoSource ? <img className="brand__logo" src={logoSource} alt="" /> : null}
			<span className="brand__segments" aria-hidden="true">
				{segments.length > 0
					? segments.map((segment) => (
							<span
								key={segment.identifier}
								className="brand__segment"
								data-style-slot={segment.styleSlot}
							>
								{segment.text}
							</span>
						))
					: fallbackLabel}
			</span>
		</>
	);
}
