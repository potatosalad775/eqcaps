import type { Domain } from './types/schema.generated.ts';

/** Relative tolerance for every membership test (SPEC §4). */
export const EPSILON = 1e-9;

/** `|a − b| ≤ ε · max(1, |a|, |b|)` (SPEC §4). */
export function near(a: number, b: number): boolean {
	return Math.abs(a - b) <= EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Whether `x` is a multiple of `step` within tolerance; the grid is anchored at 0 (SPEC §4). */
export function onGrid(x: number, step: number): boolean {
	const k = x / step;
	return near(k, Math.round(k));
}

export type DomainForm = 'range' | 'stepped' | 'set' | 'locked';

export function domainForm(d: Domain): DomainForm {
	if ('value' in d) return 'locked';
	if ('values' in d) return 'set';
	return 'step' in d ? 'stepped' : 'range';
}

/** Smallest and largest allowed value. */
export function domainBounds(d: Domain): { min: number; max: number } {
	if ('value' in d) return { min: d.value, max: d.value };
	if ('values' in d) return { min: Math.min(...d.values), max: Math.max(...d.values) };
	return { min: d.min, max: d.max };
}

/** A domain that allows exactly one value: `{ value }` or a single-element `{ values }` (SPEC §5.4). */
export function isLockedDomain(d: Domain): boolean {
	return 'value' in d || ('values' in d && d.values.length === 1);
}

/** Order of two numbers, with values within tolerance as ties: 0 if near, else a − b. */
export function compareNear(a: number, b: number): number {
	return a === b || near(a, b) ? 0 : a - b;
}
