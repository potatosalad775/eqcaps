// RBJ-cookbook biquads quantized to Q2.30, as Walkplay, Moondrop and Conexant firmware take them
// alongside the band's own parameters.

import type { FilterType } from '@potatosalad775/eqcaps-core';

const Q30 = 1073741824;

/**
 * [b0, b1, b2, −a1, −a2] normalized by a0 and scaled by 2^30: low and high shelves, and peaking
 * for every other type (these protocols have no other coefficient form).
 */
export function biquadQ30(
	type: FilterType,
	freq: number,
	gain: number,
	q: number,
	sampleRate: number
): [number, number, number, number, number] {
	const A = Math.pow(10, gain / 40);
	const w0 = (2 * Math.PI * freq) / sampleRate;
	const sin = Math.sin(w0);
	const cos = Math.cos(w0);
	let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
	if (type === 'LSC' || type === 'HSC') {
		const alpha = (sin / 2) * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
		const s = 2 * Math.sqrt(A) * alpha;
		if (type === 'LSC') {
			b0 = A * (A + 1 - (A - 1) * cos + s);
			b1 = 2 * A * (A - 1 - (A + 1) * cos);
			b2 = A * (A + 1 - (A - 1) * cos - s);
			a0 = A + 1 + (A - 1) * cos + s;
			a1 = -2 * (A - 1 + (A + 1) * cos);
			a2 = A + 1 + (A - 1) * cos - s;
		} else {
			b0 = A * (A + 1 + (A - 1) * cos + s);
			b1 = -2 * A * (A - 1 + (A + 1) * cos);
			b2 = A * (A + 1 + (A - 1) * cos - s);
			a0 = A + 1 - (A - 1) * cos + s;
			a1 = 2 * (A - 1 - (A + 1) * cos);
			a2 = A + 1 - (A - 1) * cos - s;
		}
	} else {
		const alpha = sin / (2 * q);
		b0 = 1 + alpha * A;
		b1 = -2 * cos;
		b2 = 1 - alpha * A;
		a0 = 1 + alpha / A;
		a1 = -2 * cos;
		a2 = 1 - alpha / A;
	}
	const r = (c: number) => Math.round(c * Q30);
	return [r(b0 / a0), r(b1 / a0), r(b2 / a0), r(-a1 / a0), r(-a2 / a0)];
}

/** Five coefficients as 20 little-endian int32 bytes. */
export function coefficientBytes(coeffs: readonly number[]): number[] {
	return coeffs.flatMap((v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
}
