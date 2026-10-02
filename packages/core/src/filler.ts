import type { NumericField } from './dependencies.ts';
import { domainBounds, near } from './domain.ts';
import { isKnownType, usesGain, type Filter } from './filter.ts';
import { normalizeDecimal, project } from './project.ts';
import { resolveField, type EngineProfile, type EngineSlot } from './resolve.ts';
import type { Domain, FilterType } from './types/schema.generated.ts';

// Neutral fillers for empty slots (SPEC §13.7), and the frequency chain that ascendingFrequency
// imposes on the completed slot array (SPEC §7), which validate checks and complete fills.

/** PK if allowed, else the first known gain-using type, else AP (flat magnitude), else the first. */
export function neutralType(types: readonly FilterType[]): FilterType {
	if (types.includes('PK')) return 'PK';
	return (
		types.find((t) => usesGain(t) && isKnownType(t)) ??
		(types.includes('AP') ? 'AP' : (types[0] as FilterType))
	);
}

function neutralField(slot: EngineSlot, values: Partial<Filter>, f: Exclude<NumericField, 'freq'>) {
	const type = values.type as FilterType;
	if (f === 'gain')
		return usesGain(type) ? project(0, resolveField(slot, 'gain', values), 'gain') : 0;
	return project(1, resolveField(slot, 'q', values), 'q');
}

/** A filler's type and the fields evaluated before freq, plus the freq domain they select. */
export interface FillerStart {
	values: Partial<Filter> & { type: FilterType };
	freqDomain: Domain;
}

export function fillerStart(slot: EngineSlot): FillerStart {
	const values: FillerStart['values'] = { type: neutralType(slot.types) };
	for (const f of slot.order) {
		if (f === 'freq') break;
		values[f] = neutralField(slot, values, f);
	}
	return { values, freqDomain: resolveField(slot, 'freq', values) };
}

/** The filler with its frequency chosen: the remaining fields follow. */
export function fillerFinish(slot: EngineSlot, start: FillerStart, freq: number): Filter {
	const values: Partial<Filter> = { ...start.values, freq };
	for (const f of slot.order.slice(slot.order.indexOf('freq') + 1)) {
		if (f !== 'freq') values[f] = neutralField(slot, values, f);
	}
	return values as Filter;
}

/** The filler frequency when no rule constrains it: locked value, or the log centre, projected. */
export function defaultFillerFreq(d: Domain): number {
	const { min, max } = domainBounds(d);
	return project(Math.sqrt(min * max), d, 'freq');
}

// --- Bounds ------------------------------------------------------------------------------------

/** x > v (open) or x ≥ v (closed) for a lower bound; x < v or x ≤ v for an upper one. */
interface Bound {
	v: number;
	open: boolean;
}

/** Infimum or supremum of a set of members; `attained` if it is a member itself. */
interface Extreme {
	v: number;
	attained: boolean;
}

const NO_LOWER: Bound = { v: -Infinity, open: false };
const NO_UPPER: Bound = { v: Infinity, open: false };

function above(b: Bound, x: number): boolean {
	if (b.v === -Infinity) return true;
	return b.open ? x > b.v && !near(x, b.v) : x > b.v || near(x, b.v);
}

function below(b: Bound, x: number): boolean {
	if (b.v === Infinity) return true;
	return b.open ? x < b.v && !near(x, b.v) : x < b.v || near(x, b.v);
}

/** The lowest member of `d` above `b`, or null if there is none. */
function lowest(d: Domain, b: Bound): Extreme | null {
	if ('value' in d) return above(b, d.value) ? { v: d.value, attained: true } : null;
	if ('values' in d) {
		const v = d.values.find((x) => above(b, x));
		return v === undefined ? null : { v, attained: true };
	}
	if (above(b, d.min)) return { v: d.min, attained: true };
	if (!('step' in d)) {
		if (b.open) return d.max > b.v && !near(d.max, b.v) ? { v: b.v, attained: false } : null;
		return below({ v: d.max, open: false }, b.v)
			? { v: Math.min(b.v, d.max), attained: true }
			: null;
	}
	let k = Math.floor(b.v / d.step) - 1;
	while (!above(b, normalizeDecimal(k * d.step))) k++;
	const x = normalizeDecimal(k * d.step);
	if (near(x, d.max)) return { v: d.max, attained: true };
	return x < d.max ? { v: x, attained: true } : null;
}

/** The highest member of `d` below `b`, or null if there is none. */
function highest(d: Domain, b: Bound): Extreme | null {
	if ('value' in d) return below(b, d.value) ? { v: d.value, attained: true } : null;
	if ('values' in d) {
		const v = d.values.findLast((x) => below(b, x));
		return v === undefined ? null : { v, attained: true };
	}
	if (below(b, d.max)) return { v: d.max, attained: true };
	if (!('step' in d)) {
		if (b.open) return d.min < b.v && !near(d.min, b.v) ? { v: b.v, attained: false } : null;
		return above({ v: d.min, open: false }, b.v)
			? { v: Math.max(b.v, d.min), attained: true }
			: null;
	}
	let k = Math.ceil(b.v / d.step) + 1;
	while (!below(b, normalizeDecimal(k * d.step))) k--;
	const x = normalizeDecimal(k * d.step);
	if (near(x, d.min)) return { v: d.min, attained: true };
	return x > d.min ? { v: x, attained: true } : null;
}

/** The lowest member of `d` that is at least `x`, or null if there is none. */
export function lowestAtLeast(d: Domain, x: number): number | null {
	return lowest(d, { v: x, open: false })?.v ?? null;
}

/** The bound a chosen value (or an extreme of the values a slot can still take) puts on the next slot. */
const lowerFrom = (e: Extreme, strict: boolean): Bound => ({ v: e.v, open: strict || !e.attained });
const upperFrom = lowerFrom;

// --- The ascending chain -----------------------------------------------------------------------

type Slots = readonly (Filter | null | undefined)[];

/** Number of slots the chain runs over: bandCount, or the array's length when unbounded. */
const chainLength = (p: EngineProfile, slots: Slots) => p.bandCount ?? slots.length;

/**
 * Slots at which `ascendingFrequency` breaks on the completed array (SPEC §7): a filter not above
 * everything before it, or an empty slot no filler can fill. Exact: each empty slot takes the
 * lowest frequency its filler's domain allows, which is optimal for every later slot. Empty slots
 * of an unbounded profile are skipped, because complete leaves them out.
 */
export function ascendingBreaks(p: EngineProfile, slots: Slots, strict: boolean): number[] {
	const breaks: number[] = [];
	let lb = NO_LOWER;
	for (let i = 0; i < chainLength(p, slots); i++) {
		const f = slots[i];
		if (f) {
			if (!above(lb, f.freq)) breaks.push(i);
			lb = { v: f.freq, open: strict };
		} else if (p.bandCount !== null) {
			const e = lowest(fillerStart(p.slots[i] as EngineSlot).freqDomain, lb);
			if (e) lb = lowerFrom(e, strict);
			else breaks.push(i);
		}
	}
	return breaks;
}

/**
 * Frequencies for the fillers of the empty slots under `ascendingFrequency`. A run of empty slots
 * is spread evenly in log frequency between its neighbours, within what each filler's domain and
 * the slots after it allow. Slots with no room at all get their default frequency and are listed
 * in `noRoom`.
 */
export function ascendingFillerFreqs(
	p: EngineProfile,
	slots: Slots,
	starts: ReadonlyMap<number, FillerStart>,
	strict: boolean
): { freqs: Map<number, number>; noRoom: number[] } {
	const n = p.bandCount ?? 0;
	// upper[i]: what slots after i leave for slot i.
	const upper: Bound[] = new Array<Bound>(n);
	let ub = NO_UPPER;
	for (let i = n - 1; i >= 0; i--) {
		upper[i] = ub;
		const f = slots[i];
		if (f) ub = { v: f.freq, open: strict };
		else {
			const e = highest((starts.get(i) as FillerStart).freqDomain, ub);
			if (e) ub = upperFrom(e, strict);
		}
	}

	const freqs = new Map<number, number>();
	const noRoom: number[] = [];
	let lb = NO_LOWER;
	for (let i = 0; i < n; i++) {
		const f = slots[i];
		if (f) {
			lb = { v: f.freq, open: strict };
			continue;
		}
		const d = (starts.get(i) as FillerStart).freqDomain;
		const hiBound = upper[i] as Bound;
		const lo = lowest(d, lb);
		const hi = highest(d, hiBound);
		const room =
			lo &&
			hi &&
			(lo.v < hi.v
				? !near(lo.v, hi.v) || (lo.attained && hi.attained)
				: near(lo.v, hi.v) && lo.attained && hi.attained);
		if (!lo || !hi || !room) {
			const x = defaultFillerFreq(d);
			noRoom.push(i);
			freqs.set(i, x);
			lb = { v: x, open: strict };
			continue;
		}
		// Empty slots from here up to the next filter, this one included.
		let run = 1;
		while (i + run < n && !slots[i + run]) run++;
		const target = lo.v * (hi.v / lo.v) ** (1 / (run + 1));
		let x = project(target, d, 'freq');
		if (!above(lb, x)) x = lo.attained ? lo.v : target;
		if (!below(hiBound, x)) x = hi.attained ? hi.v : target;
		freqs.set(i, x);
		lb = { v: x, open: strict };
	}
	return { freqs, noRoom };
}
