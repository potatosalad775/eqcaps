import type { NumericField } from './dependencies.ts';
import { compareNear, domainBounds, near } from './domain.ts';
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

/** ISO 266 one-third-octave nominal frequencies (R10), per decade: 1, 1.25, 1.6, … 8. */
const NOMINAL = [1, 1.25, 1.6, 2, 2.5, 3.15, 4, 5, 6.3, 8];
/** How far a filler may move from its target to land on a nominal frequency: 1/3 octave. */
const NOMINAL_REACH = Math.LN2 / 3;
/** How far a stepped or set domain may move a nominal frequency it contains: 1/12 octave. */
const NOMINAL_SLACK = Math.LN2 / 12;

/**
 * The member of `d` at the nominal frequency within its bounds nearest `target` that `fits`
 * accepts, or null if none is within reach. Fillers read back as 630 Hz rather than 632 Hz.
 */
function nominalNear(target: number, d: Domain, fits: (x: number) => boolean): number | null {
	const { min, max } = domainBounds(d);
	const decade = Math.floor(Math.log10(target));
	const candidates = [decade - 1, decade, decade + 1]
		.flatMap((k) => NOMINAL.map((n) => normalizeDecimal(n * 10 ** k)))
		.filter((c) => (c > min || near(c, min)) && (c < max || near(c, max)))
		.filter((c) => Math.abs(Math.log(c / target)) <= NOMINAL_REACH)
		.map((c) => ({ c, distance: Math.abs(Math.log(c / target)) }))
		// Ties go to the lower frequency, as in project.
		.sort((a, b) => compareNear(a.distance, b.distance) || a.c - b.c)
		.map(({ c }) => c);
	for (const c of candidates) {
		const x = project(c, d, 'freq');
		if (Math.abs(Math.log(x / c)) <= NOMINAL_SLACK && fits(x)) return x;
	}
	return null;
}

/**
 * The filler frequency when no rule constrains it: locked value, or the log centre, moved to a
 * nominal frequency where the domain has one nearby, projected.
 */
export function defaultFillerFreq(d: Domain): number {
	const { min, max } = domainBounds(d);
	const centre = Math.sqrt(min * max);
	return nominalNear(centre, d, () => true) ?? project(centre, d, 'freq');
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
 * is spread evenly in log frequency between its neighbours, each moved to a nearby nominal
 * frequency where one keeps the order, within what each filler's domain and the slots after it
 * allow. Slots with no room at all get their default frequency and are listed
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
	// The even spread a run of empty slots started with, so that moving one filler to a nominal
	// frequency doesn't shift the targets of the rest.
	let spread: { from: number; to: number; first: number; run: number } | null = null;
	let lb = NO_LOWER;
	for (let i = 0; i < n; i++) {
		const f = slots[i];
		if (f) {
			lb = { v: f.freq, open: strict };
			spread = null;
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
			spread = null;
			continue;
		}
		// Empty slots from here up to the next filter, this one included.
		let run = 1;
		while (i + run < n && !slots[i + run]) run++;
		spread ??= { from: lo.v, to: hi.v, first: i, run };
		const planned =
			spread.from * (spread.to / spread.from) ** ((i - spread.first + 1) / (spread.run + 1));
		const target =
			planned > lo.v && planned < hi.v ? planned : lo.v * (hi.v / lo.v) ** (1 / (run + 1));
		let x =
			nominalNear(target, d, (v) => above(lb, v) && below(hiBound, v)) ??
			project(target, d, 'freq');
		if (!above(lb, x)) x = lo.attained ? lo.v : target;
		if (!below(hiBound, x)) x = hi.attained ? hi.v : target;
		freqs.set(i, x);
		lb = { v: x, open: strict };
	}
	return { freqs, noRoom };
}

/**
 * Frequencies for the fillers of the empty slots when no rule orders them. They share out the gaps
 * between the filled slots (and the ends of the fillers' domains), widest gap first, spread evenly
 * in log frequency within each, and go to the empty slots in ascending order. Each moves to a
 * nearby nominal frequency above the filler before it, where its domain has one.
 */
export function spreadFillerFreqs(
	slots: Slots,
	starts: ReadonlyMap<number, FillerStart>
): Map<number, number> {
	const empty = [...starts.keys()].sort((a, b) => a - b);
	const domain = (i: number) => (starts.get(i) as FillerStart).freqDomain;
	const freqs = new Map<number, number>();
	let lo = Infinity;
	let hi = -Infinity;
	for (const i of empty) {
		const b = domainBounds(domain(i));
		lo = Math.min(lo, b.min);
		hi = Math.max(hi, b.max);
	}
	if (!(lo > 0 && hi > lo)) {
		for (const i of empty) freqs.set(i, defaultFillerFreq(domain(i)));
		return freqs;
	}

	const filled = slots.flatMap((f) => (f && f.freq > lo && f.freq < hi ? [f.freq] : []));
	const edges = [...new Set([lo, ...filled, hi])].sort((a, b) => a - b);
	const counts = edges.slice(1).map(() => 0);
	const share = (g: number) =>
		Math.log((edges[g + 1] as number) / (edges[g] as number)) / ((counts[g] as number) + 1);
	for (let n = 0; n < empty.length; n++) {
		let widest = 0;
		for (let g = 1; g < counts.length; g++) if (share(g) > share(widest)) widest = g;
		counts[widest] = (counts[widest] as number) + 1;
	}
	const targets = counts.flatMap((count, g) => {
		const [a, b] = [edges[g] as number, edges[g + 1] as number];
		return Array.from({ length: count }, (_, k) => a * (b / a) ** ((k + 1) / (count + 1)));
	});

	let prev = 0;
	empty.forEach((i, k) => {
		const target = targets[k] as number;
		const d = domain(i);
		const x =
			nominalNear(target, d, (v) => v > prev && !near(v, prev)) ?? project(target, d, 'freq');
		freqs.set(i, x);
		prev = x;
	});
	return freqs;
}
