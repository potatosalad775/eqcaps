/**
 * Dotted-numeric order (SPEC §3): split on non-digits, compare components numerically, missing
 * components count as 0. Returns a negative number, 0 or a positive number.
 */
export function compareFirmware(a: string, b: string): number {
	const parts = (v: string) => v.split(/\D+/).filter(Boolean).map(Number);
	const pa = parts(a);
	const pb = parts(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** Whether two firmware ranges (min inclusive, max exclusive, missing = unbounded) overlap. */
export function firmwareRangesOverlap(
	a: { min?: string; max?: string } | undefined,
	b: { min?: string; max?: string } | undefined
): boolean {
	const below = (min: string | undefined, max: string | undefined) =>
		min === undefined || max === undefined || compareFirmware(min, max) < 0;
	return below(a?.min, b?.max) && below(b?.min, a?.max);
}
