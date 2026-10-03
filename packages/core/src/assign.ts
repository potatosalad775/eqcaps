import { compareNear, near } from './domain.ts';
import { fitToSlot } from './fit-slot.ts';
import { isActive, normalizeFilter, usesGain, type Filter } from './filter.ts';
import { domainViolation } from './project.ts';
import { engineProfile, resolveField, type EngineProfile, type EngineSlot } from './resolve.ts';
import type { Profile } from './types/schema.generated.ts';

export interface AssignResult {
	/** One entry per slot (bandCount of them; as many as assigned filters when unbounded). */
	slots: (Filter | null)[];
	/** Active filters that got no slot. */
	unassigned: Filter[];
	/** For each input filter, its slot, or null when inactive (dropped) or unassigned. */
	slotOf: (number | null)[];
}

/**
 * Map a list of written filters onto slots (SPEC §13.5). Inactive filters are dropped. Normative
 * property: if an assignment exists in which every filter's type is allowed and every field is
 * in its domain, the result is one. Which one is informative.
 *
 * Homogeneous engines keep list order (frequency order under ascendingFrequency). Otherwise a
 * min-cost matching: the cost of a filter in a slot is how far projection moves it (octaves for
 * freq and q, gain in 6 dB units) plus a large penalty for a disallowed type. When there are more
 * filters than slots, those with the smallest |gain| are left out first. Under
 * ascendingFrequency, a frequency-ordered matching is preferred unless only the unordered one is
 * valid.
 */
export function assign(profile: Profile, filters: readonly Filter[]): AssignResult {
	return assignEngine(engineProfile(profile), filters);
}

const TYPE_PENALTY = 1e6;
const DROP_PENALTY = 1e9;
// Costs of a filter that fits are ~1e-16 (grid normalization); anything above this is a real move.
const TOLERANCE = 1e-12;

/** How audible a filter is, for choosing which to leave out: |gain|, gainless filters always win. */
const significance = (f: Filter) =>
	usesGain(f.type) ? (Number.isFinite(f.gain) ? Math.min(Math.abs(f.gain), 100) : 0) : 100;

/** Cost of leaving filter k out; on equal significance, later filters go first. */
const dropCost = (f: Filter, k: number) => DROP_PENALTY + 1e3 * significance(f) - 1e-3 * k;

const finite = (x: number) => (Number.isFinite(x) ? x : 1e3);
const octaves = (a: number, b: number) => finite(Math.abs(Math.log2(a / b)));

function cost(slot: EngineSlot, f: Filter): number {
	const g = fitToSlot(slot, f);
	return (
		(g.type === f.type ? 0 : TYPE_PENALTY) +
		octaves(f.freq, g.freq) +
		octaves(f.q, g.q) +
		finite(Math.abs(f.gain - g.gain) / 6)
	);
}

/** The filter is accepted by the slot as it is. */
export function fitsSlot(slot: EngineSlot, f: Filter): boolean {
	if (!slot.types.includes(f.type)) return false;
	return (['freq', 'q', 'gain'] as const).every(
		(field) =>
			(field === 'gain' && !usesGain(f.type)) ||
			domainViolation(f[field], resolveField(slot, field, f)) === null
	);
}

const freqKey = (f: Filter) => (Number.isFinite(f.freq) ? f.freq : Infinity);

export function assignEngine(p: EngineProfile, input: readonly Filter[]): AssignResult {
	const filters = input.map(normalizeFilter);
	const active = filters.flatMap((f, k) => (isActive(f) ? [k] : []));
	const ascending = (p.profile.rules ?? []).find((r) => r.type === 'ascendingFrequency');
	const strict = ascending?.strict ?? true;
	const m = p.bandCount ?? active.length;

	let slotOf: Map<number, number>;
	if (p.homogeneous) {
		let kept = active;
		if (kept.length > m) {
			const rank = [...kept].sort(
				(a, b) => significance(filters[b] as Filter) - significance(filters[a] as Filter) || a - b
			);
			const keep = new Set(rank.slice(0, m));
			kept = kept.filter((k) => keep.has(k));
		}
		if (ascending) {
			kept = [...kept].sort(
				(a, b) => compareNear(freqKey(filters[a] as Filter), freqKey(filters[b] as Filter)) || a - b
			);
		}
		slotOf = new Map(kept.map((k, s) => [k, s]));
	} else {
		const c = costs(p, filters, active);
		const h = normalize(c, matching(c), false);
		slotOf = h.slotOf;
		if (ascending && !inOrder(p, filters, h.slotOf, strict)) {
			const o = normalize(c, ordered(c, filters), true);
			if (!(valid(p, filters, h, m) && !valid(p, filters, o, m))) slotOf = o.slotOf;
		}
	}
	return result(filters, m, slotOf);
}

/** The frequency-ordered matching on its own, for fit's second attempt under ascendingFrequency. */
export function orderedAssignEngine(p: EngineProfile, input: readonly Filter[]): AssignResult {
	const filters = input.map(normalizeFilter);
	const active = filters.flatMap((f, k) => (isActive(f) ? [k] : []));
	const m = p.bandCount ?? active.length;
	if (p.homogeneous) return assignEngine(p, filters);
	const c = costs(p, filters, active);
	return result(filters, m, normalize(c, ordered(c, filters), true).slotOf);
}

function result(filters: Filter[], m: number, slotOf: Map<number, number>): AssignResult {
	const slots: (Filter | null)[] = new Array<Filter | null>(m).fill(null);
	for (const [k, s] of slotOf) slots[s] = { ...(filters[k] as Filter) };
	return {
		slots,
		unassigned: filters.filter((f, k) => isActive(f) && !slotOf.has(k)).map((f) => ({ ...f })),
		slotOf: filters.map((_, k) => slotOf.get(k) ?? null)
	};
}

// --- Matching ----------------------------------------------------------------------------------

interface Costs {
	/** Input indices of the active filters; row r is filter active[r]. */
	active: number[];
	/** cost[r][s] for active filter r in slot s. */
	cost: number[][];
	drop: number[];
	slots: number;
}

interface Assignment {
	/** Input filter index → slot. */
	slotOf: Map<number, number>;
}

function costs(p: EngineProfile, filters: Filter[], active: number[]): Costs {
	const slots = p.slots.length;
	return {
		active,
		cost: active.map((k) => p.slots.map((slot) => cost(slot, filters[k] as Filter))),
		drop: active.map((k) => dropCost(filters[k] as Filter, k)),
		slots
	};
}

/** Min-cost matching (Hungarian), with one "left out" column per filter when they outnumber slots. */
function matching(c: Costs): Assignment {
	const n = c.active.length;
	const extra = n > c.slots ? n : 0;
	const cols = c.slots + extra;
	const at = (r: number, j: number) =>
		j < c.slots ? (c.cost[r]?.[j] as number) : (c.drop[r] as number);
	const rowToCol = hungarian(n, cols, at);
	const slotOf = new Map<number, number>();
	rowToCol.forEach((j, r) => {
		if (j < c.slots) slotOf.set(c.active[r] as number, j);
	});
	return { slotOf };
}

/**
 * Min-cost assignment of n rows to distinct columns (n ≤ cols), O(n²·cols). Returns the column
 * of each row.
 */
export function hungarian(
	n: number,
	cols: number,
	cost: (r: number, j: number) => number
): number[] {
	const u = new Float64Array(n + 1);
	const v = new Float64Array(cols + 1);
	const p = new Int32Array(cols + 1);
	const way = new Int32Array(cols + 1);
	for (let i = 1; i <= n; i++) {
		p[0] = i;
		let j0 = 0;
		const minv = new Float64Array(cols + 1).fill(Infinity);
		const used = new Uint8Array(cols + 1);
		do {
			used[j0] = 1;
			const i0 = p[j0] as number;
			let delta = Infinity;
			let j1 = 0;
			for (let j = 1; j <= cols; j++) {
				if (used[j]) continue;
				const cur = cost(i0 - 1, j - 1) - (u[i0] as number) - (v[j] as number);
				if (cur < (minv[j] as number)) {
					minv[j] = cur;
					way[j] = j0;
				}
				if ((minv[j] as number) < delta) {
					delta = minv[j] as number;
					j1 = j;
				}
			}
			for (let j = 0; j <= cols; j++) {
				if (used[j]) {
					u[p[j] as number] = (u[p[j] as number] as number) + delta;
					v[j] = (v[j] as number) - delta;
				} else {
					minv[j] = (minv[j] as number) - delta;
				}
			}
			j0 = j1;
		} while (p[j0] !== 0);
		do {
			const j1 = way[j0] as number;
			p[j0] = p[j1] as number;
			j0 = j1;
		} while (j0 !== 0);
	}
	const rowToCol = new Array<number>(n).fill(-1);
	for (let j = 1; j <= cols; j++) if ((p[j] as number) > 0) rowToCol[(p[j] as number) - 1] = j - 1;
	return rowToCol;
}

/**
 * Min-cost assignment that keeps filters in frequency order across slots (dynamic programming
 * over filters × slots). Filters may be left out and slots left empty.
 */
function ordered(c: Costs, filters: Filter[]): Assignment {
	const rows = c.active
		.map((k, r) => ({ k, r }))
		.sort(
			(a, b) =>
				compareNear(freqKey(filters[a.k] as Filter), freqKey(filters[b.k] as Filter)) || a.k - b.k
		);
	const n = rows.length;
	const m = c.slots;
	const w = m + 1;
	const dp = new Float64Array((n + 1) * w);
	for (let i = 1; i <= n; i++)
		dp[i * w] = (dp[(i - 1) * w] as number) + (c.drop[(rows[i - 1] as { r: number }).r] as number);
	const fill = (i: number, j: number) => {
		const { r } = rows[i - 1] as { r: number };
		return Math.min(
			dp[i * w + j - 1] as number,
			(dp[(i - 1) * w + j] as number) + (c.drop[r] as number),
			(dp[(i - 1) * w + j - 1] as number) + (c.cost[r]?.[j - 1] as number)
		);
	};
	for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i * w + j] = fill(i, j);

	// Walk back preferring to leave the later slot empty, which moves filters to earlier slots.
	const slotOf = new Map<number, number>();
	let i = n;
	let j = m;
	while (i > 0) {
		const here = dp[i * w + j] as number;
		const { k, r } = rows[i - 1] as { k: number; r: number };
		if (j > 0 && here === dp[i * w + j - 1]) j--;
		else if (
			j > 0 &&
			here === (dp[(i - 1) * w + j - 1] as number) + (c.cost[r]?.[j - 1] as number)
		) {
			slotOf.set(k, j - 1);
			i--;
			j--;
		} else i--;
	}
	return { slotOf };
}

/**
 * Settle ties deterministically without raising the cost: move filters down into earlier empty
 * slots, and (unless order must be kept) undo swaps of input order, while that costs nothing.
 */
function normalize(c: Costs, a: Assignment, keepOrder: boolean): Assignment {
	const row = new Map(c.active.map((k, r) => [k, r]));
	const at = (k: number, s: number) => c.cost[row.get(k) as number]?.[s] as number;
	const occupant = new Array<number | undefined>(c.slots);
	for (const [k, s] of a.slotOf) occupant[s] = k;

	for (let changed = true; changed;) {
		changed = false;
		for (let s = 0; s < c.slots; s++) {
			const k = occupant[s];
			if (k === undefined) continue;
			// Under keepOrder, only the free slots right below s keep the order.
			let from = 0;
			if (keepOrder) {
				from = s;
				while (from > 0 && occupant[from - 1] === undefined) from--;
			}
			for (let t = from; t < s; t++) {
				if (occupant[t] === undefined && at(k, t) <= at(k, s) + TOLERANCE) {
					occupant[t] = k;
					occupant[s] = undefined;
					changed = true;
					break;
				}
			}
		}
		if (keepOrder) continue;
		for (let s1 = 0; s1 < c.slots; s1++) {
			for (let s2 = s1 + 1; s2 < c.slots; s2++) {
				const a1 = occupant[s1];
				const b2 = occupant[s2];
				if (a1 === undefined || b2 === undefined || a1 < b2) continue;
				if (at(a1, s2) + at(b2, s1) <= at(a1, s1) + at(b2, s2) + TOLERANCE) {
					occupant[s1] = b2;
					occupant[s2] = a1;
					changed = true;
				}
			}
		}
	}
	const slotOf = new Map<number, number>();
	occupant.forEach((k, s) => {
		if (k !== undefined) slotOf.set(k, s);
	});
	return { slotOf };
}

/** Assigned frequencies, once projected onto their slots, ascend with the slot index. */
function inOrder(
	p: EngineProfile,
	filters: Filter[],
	slotOf: Map<number, number>,
	strict: boolean
): boolean {
	const freqs = [...slotOf]
		.sort((a, b) => a[1] - b[1])
		.map(([k, s]) => fitToSlot(p.slots[s] as EngineSlot, filters[k] as Filter).freq);
	return freqs.every((f, i) => {
		if (i === 0) return true;
		const prev = freqs[i - 1] as number;
		return strict ? f > prev && !near(f, prev) : f > prev || near(f, prev);
	});
}

/** Every filter that can have a slot has one, and each fits its slot as it is. */
function valid(p: EngineProfile, filters: Filter[], a: Assignment, m: number): boolean {
	const active = filters.filter(isActive).length;
	if (a.slotOf.size !== Math.min(active, m)) return false;
	return [...a.slotOf].every(([k, s]) => fitsSlot(p.slots[s] as EngineSlot, filters[k] as Filter));
}
