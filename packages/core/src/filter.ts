import { near } from './domain.ts';
import type { FilterType } from './types/schema.generated.ts';

/** One filter in canonical units: Hz, RBJ-cookbook Q, dB (SPEC §1). */
export interface Filter {
	type: FilterType;
	freq: number;
	q: number;
	gain: number;
}

/** The v1 filter types (SPEC §5.3). */
export const FILTER_TYPES = ['PK', 'LSC', 'HSC', 'LPQ', 'HPQ', 'BP', 'NO', 'AP'] as const;
export type KnownFilterType = (typeof FILTER_TYPES)[number];

const GAINLESS: ReadonlySet<FilterType> = new Set(['LPQ', 'HPQ', 'BP', 'NO', 'AP']);

export function isKnownType(type: FilterType): type is KnownFilterType {
	return (FILTER_TYPES as readonly FilterType[]).includes(type);
}

/**
 * Whether the type takes `gain` (SPEC §5.3). Unknown types count as gain-using, so their gain is
 * kept and checked rather than discarded (SPEC §13).
 */
export function usesGain(type: FilterType): boolean {
	return !GAINLESS.has(type);
}

/** The filter with `gain` set to 0 for gainless types, as every engine operation sees it (SPEC §13). */
export function normalizeFilter(filter: Filter): Filter {
	const { type, freq, q, gain } = filter;
	return { type, freq, q, gain: usesGain(type) ? gain : 0 };
}

/** Gain-using with gain ≠ 0 (within ε), or gainless (SPEC §7). */
export function isActive(filter: Filter): boolean {
	return !usesGain(filter.type) || !near(filter.gain, 0);
}
