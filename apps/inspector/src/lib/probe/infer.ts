// Inference from observations (INSPECTOR §3.2): which grid explains what a device stored, and the
// candidate values a bound search tries first. Pure functions; the probe engine feeds them.

import { near, onGrid } from '@potatosalad775/eqcaps-core';

/** One observation of a field: the value the wire carried, and the value the device stored. */
export interface Pair {
	sent: number;
	stored: number;
	/** The band it was seen in, where that matters (a clamp is at the edge of its band's window). */
	slot?: number;
}

export type Rounding = 'nearest' | 'toward-zero' | 'down' | 'up';

export type StepResult =
	| { kind: 'grid'; step: number; rounding: Rounding }
	/** A float field the device stores as sent: no grid. */
	| { kind: 'continuous' }
	| { kind: 'irregular' }
	| { kind: 'insufficient' };

/** Steps devices use, from 1/4096 to 1000 (INSPECTOR §3.2). */
export const KNOWN_STEPS: readonly number[] = [
	1 / 4096,
	1 / 2048,
	1 / 1024,
	0.001,
	1 / 512,
	1 / 256,
	1 / 128,
	0.01,
	1 / 64,
	1 / 60,
	0.02,
	1 / 40,
	1 / 32,
	0.05,
	1 / 16,
	1 / 14,
	0.1,
	1 / 8,
	0.2,
	0.25,
	0.5,
	1,
	2,
	5,
	10,
	100,
	1000
];

const ROUND: Record<Rounding, (x: number) => number> = {
	nearest: (x) => Math.round(x),
	'toward-zero': (x) => Math.trunc(x),
	down: (x) => Math.floor(x),
	up: (x) => Math.ceil(x)
};

/** `x / step`, snapped to the nearest integer when it is within tolerance of one. */
function units(x: number, step: number): number {
	const k = x / step;
	return near(k, Math.round(k)) ? Math.round(k) : k;
}

/** The value `sent` lands on when the device stores it on a `step` grid with `rounding`. */
export function onStep(sent: number, step: number, rounding: Rounding): number {
	return ROUND[rounding](units(sent, step)) * step;
}

/** Whether every pair is explained by a `step` grid with `rounding`, or may be passed over. */
function explains(
	pairs: readonly Pair[],
	step: number,
	rounding: Rounding,
	mayFail?: (p: Pair, step: number) => boolean
): boolean {
	return pairs.every(
		(p) =>
			(onGrid(p.stored, step) && near(onStep(p.sent, step, rounding), p.stored)) ||
			(mayFail?.(p, step) ?? false)
	);
}

/**
 * Greatest common divisor of real numbers, to within `tolerance`: the finest grid all of them lie
 * on. Returns 0 for an empty list.
 */
export function realGcd(values: readonly number[], tolerance: number): number {
	let g = 0;
	for (const v of values.map(Math.abs)) {
		let a = Math.max(g, v);
		let b = Math.min(g, v);
		while (b > tolerance) {
			const r = a % b;
			a = b;
			b = r < tolerance || b - r < tolerance ? 0 : r;
		}
		g = a;
	}
	return g;
}

/**
 * The largest step that explains every observation (INSPECTOR §3.2): every stored value on its
 * grid, and every sent value landing on its stored value. Candidates are the known steps and the
 * GCD of the stored values (grids are anchored at 0, SPEC §4), never finer than the wire's
 * resolution. Rounding to nearest is preferred; truncating devices are recognised too. A float
 * wire (no `wireStep`) whose values all come back as sent is continuous. Fewer than three
 * distinct sent values say nothing. `mayFail` lets a pair go unexplained by a candidate (a clamp,
 * which says where a range ends rather than what its grid is).
 */
export function inferStep(
	pairs: readonly Pair[],
	wireStep?: number,
	mayFail?: (p: Pair, step: number) => boolean
): StepResult {
	const distinct = new Set(pairs.map((p) => p.sent));
	if (distinct.size < 3) return { kind: 'insufficient' };
	const asSent = (p: Pair) =>
		Math.abs(p.stored - p.sent) <= 1e-6 * Math.max(1, Math.abs(p.sent), Math.abs(p.stored));
	if (wireStep === undefined && pairs.every((p) => asSent(p) || (mayFail?.(p, 0) ?? false))) {
		return { kind: 'continuous' };
	}
	const floor = wireStep ?? 0;
	const tolerance = floor > 0 ? floor / 4 : 1e-7;
	const stored = pairs.map((p) => p.stored).filter((v) => !near(v, 0));
	const gcd = realGcd(stored, tolerance);
	const tidy = (x: number) => Number(x.toPrecision(12));
	const candidates = [...KNOWN_STEPS, ...(gcd > 0 ? [tidy(gcd)] : []), ...(floor ? [floor] : [])]
		.filter((c) => c >= floor * (1 - 1e-9))
		.sort((a, b) => b - a);
	for (const step of candidates) {
		for (const rounding of Object.keys(ROUND) as Rounding[]) {
			if (explains(pairs, step, rounding, mayFail)) return { kind: 'grid', step, rounding };
		}
	}
	return { kind: 'irregular' };
}

/** Values bound searches try first: where devices usually put their limits. */
export const NICE: Record<'gain' | 'q' | 'freq', readonly number[]> = {
	gain: [0.5, 1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 16, 18, 20, 24, 25, 30],
	q: [
		0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 1, 2, 3, 4, 5, 6, 8, 10, 12,
		15, 16, 20, 24, 25, 30, 32, 40, 50, 64, 100
	],
	freq: [
		1, 2, 5, 10, 12, 15, 16, 20, 25, 30, 40, 50, 100, 200, 500, 1000, 2000, 5000, 8000, 10000,
		12000, 15000, 16000, 18000, 19000, 20000, 21000, 22000, 22050, 24000, 25000, 30000, 32000, 40000
	]
};

/** Search limits: bound searches start here, and a bound at a limit is reported as "at least". */
export const LIMITS: Record<'gain' | 'q' | 'freq' | 'preamp', { min: number; max: number }> = {
	gain: { min: -30, max: 30 },
	q: { min: 0.01, max: 100 },
	freq: { min: 1, max: 40000 },
	preamp: { min: -30, max: 30 }
};

/** Whether a field is searched on a log scale (Q and frequency) or a linear one (gains). */
export const isLog = (field: string) => field === 'q' || field === 'freq';

/** The midpoint of `a` and `b`: geometric for log fields. */
export function midpoint(a: number, b: number, log: boolean): number {
	return log ? Math.sqrt(a * b) : (a + b) / 2;
}

/** `x` on a `step` grid, or `x` itself without one. */
export function snap(x: number, step: number | undefined): number {
	if (!step) return x;
	return Number((Math.round(x / step) * step).toPrecision(12));
}
