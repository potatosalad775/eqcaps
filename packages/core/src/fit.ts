import {
	assignEngine,
	hungarian,
	orderedAssignEngine,
	withFlat,
	type AssignResult
} from './assign.ts';
import { compareNear, near } from './domain.ts';
import { fitToSlot } from './fit-slot.ts';
import { isActive, normalizeFilter, usesGain, type Filter } from './filter.ts';
import { project } from './project.ts';
import { engineProfile, type EngineProfile, type EngineSlot } from './resolve.ts';
import type { FilterType, Preamp, Profile } from './types/schema.generated.ts';
import { validateEngine, type Violation } from './validate.ts';

/** One difference between a wanted filter (or preamp) and what fit wrote for it. */
export interface Change {
	/** Index of the input filter; null for the preamp. */
	filter: number | null;
	slot: number | null;
	field: 'type' | 'freq' | 'q' | 'gain' | 'preamp';
	wanted: number | FilterType;
	written: number | FilterType;
}

export interface FitResult {
	/** Written values, one per slot: what to send to the engine. */
	slots: (Filter | null)[];
	preamp: number;
	/**
	 * Every field of an assigned active filter that came out different, in input order; then the
	 * preamp. A flat filter's fields aren't reported: whatever they are written as, it does nothing.
	 */
	changes: Change[];
	/** Wanted filters that got no slot. */
	unassigned: Filter[];
	/**
	 * Slot of each wanted filter, flat ones included: null when it got none (no slot left, or a
	 * flat filter the slots or rules couldn't take).
	 */
	slotOf: (number | null)[];
	/** validate(slots, preamp) is empty. */
	feasible: boolean;
}

/**
 * The written values that come closest to the response the user wants (SPEC §13.6). Input: the
 * app's filters and preamp (dB). Normative only through its properties: sound, faithful on valid
 * input, idempotent, and it never adds active filters.
 *
 * One pass assigns, projects and applies the rules. Some of its choices (which assignment wins
 * under ascendingFrequency) depend on the input values, so a pass over its own output can choose
 * differently. fit therefore repeats the pass on its output until a result
 * comes back (at most MAX_PASSES times). Usually that is a fixpoint. On profiles whose rules can
 * never be met it can be a cycle, and fit takes the member with the fewest violations, then the
 * one whose filters are closest to the wanted ones as a multiset, then the first in slot order.
 * Both are idempotent: a fit of the chosen result's filters walks the same cycle,
 * the choice depends only on its members, and there the chosen result is at distance 0.
 */
export function fit(profile: Profile, filters: readonly Filter[], preamp = 0): FitResult {
	const p = engineProfile(profile);
	const wanted = filters.map(normalizeFilter);
	const pre = fitPreamp(profile.preamp, preamp);

	let cur = pass(p, wanted, pre);
	const seen = [cur];
	for (let i = 1; i < MAX_PASSES; i++) {
		const input = cur.slots.flatMap((f, s) => (f ? [{ s, f }] : []));
		const next = pass(
			p,
			input.map((x) => x.f),
			pre
		);
		const back = seen.findIndex((x) => sameSlots(next.slots, x.slots));
		if (back >= 0) {
			cur = closest(p, wanted, seen.slice(back));
			break;
		}
		// Compose: input filter k → slot s of this pass → entry j of the next input → next slot.
		const entry = new Map(input.map((x, j) => [x.s, j]));
		const lost = new Map(cur.lost);
		const slotOf = cur.slotOf.map((s, k) => {
			if (s === null) return null;
			const j = entry.get(s) as number;
			const reason = next.lost.get(j);
			if (reason) lost.set(k, reason);
			return next.slotOf[j] ?? null;
		});
		cur = { ...next, slotOf, lost };
		seen.push(cur);
	}

	const { slots, slotOf, lost } = cur;
	const changes: Change[] = [];
	slotOf.forEach((s, k) => {
		const w = wanted[k] as Filter;
		const add = (field: Change['field'], from: number | FilterType, to: number | FilterType) =>
			changes.push({ filter: k, slot: s, field, wanted: from, written: to });
		if (s === null) {
			// Projected flat, and the rules left no room to write it flat: its slot is left empty.
			if (lost.get(k) === 'flattened') add('gain', w.gain, 0);
			return;
		}
		if (!isActive(w)) return;
		const r = slots[s] as Filter;
		if (w.type !== r.type) add('type', w.type, r.type);
		for (const field of ['freq', 'q', 'gain'] as const) {
			if (field === 'gain' && !usesGain(w.type) && !usesGain(r.type)) continue;
			if (!near(w[field], r[field])) add(field, w[field], r[field]);
		}
	});
	if (!near(preamp, pre)) {
		changes.push({ filter: null, slot: null, field: 'preamp', wanted: preamp, written: pre });
	}
	return {
		slots,
		preamp: pre,
		changes,
		unassigned: wanted.filter((_, k) => lost.get(k) === 'unassigned'),
		slotOf: [...slotOf],
		feasible: cur.violations.length === 0
	};
}

/** Upper bound on fit's passes; in practice a second pass confirms the first. */
const MAX_PASSES = 32;

/**
 * The member of a cycle of passes that fit returns: fewest violations, then least distance to the
 * wanted filters, then first in slot order. It depends only on the cycle's members.
 */
function closest(p: EngineProfile, wanted: readonly Filter[], passes: readonly Pass[]): Pass {
	const active = wanted.filter(isActive);
	const scored = passes.map((x) => ({
		x,
		d: distance(
			active,
			x.slots.flatMap((s) => (s && isActive(s) ? [s] : []))
		)
	}));
	scored.sort(
		(a, b) =>
			a.x.violations.length - b.x.violations.length ||
			compareNear(a.d, b.d) ||
			compareSlots(a.x.slots, b.x.slots)
	);
	return (scored[0] as { x: Pass }).x;
}

/** Penalty for a type change, a lost filter or a non-finite field. */
const FAR = 1e3;

const octaves = (a: number, b: number) => {
	const d = Math.abs(Math.log2(a / b));
	return Number.isFinite(d) ? d : FAR;
};

/** Octaves of freq and q plus gain in 6 dB units, as assign measures a move. */
function apart(w: Filter, r: Filter): number {
	const gain = usesGain(w.type) || usesGain(r.type) ? Math.abs(w.gain - r.gain) / 6 : 0;
	return (
		(w.type === r.type ? 0 : FAR) +
		octaves(w.freq, r.freq) +
		octaves(w.q, r.q) +
		(Number.isFinite(gain) ? gain : FAR)
	);
}

/** Min-cost matching of the wanted filters onto the written ones, as multisets. */
function distance(wanted: readonly Filter[], written: readonly Filter[]): number {
	const at = (r: number, j: number) =>
		j < written.length ? apart(wanted[r] as Filter, written[j] as Filter) : FAR;
	const rowToCol = hungarian(wanted.length, written.length + wanted.length, at);
	return rowToCol.reduce((sum, j, r) => sum + at(r, j), 0);
}

function compareSlots(a: readonly (Filter | null)[], b: readonly (Filter | null)[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const x = a[i];
		const y = b[i];
		if (!x || !y) {
			if (x || y) return x ? 1 : -1;
			continue;
		}
		const c =
			(x.type < y.type ? -1 : x.type > y.type ? 1 : 0) ||
			compareNear(x.freq, y.freq) ||
			compareNear(x.q, y.q) ||
			compareNear(x.gain, y.gain);
		if (c) return c;
	}
	return a.length - b.length;
}

function sameSlots(a: readonly (Filter | null)[], b: readonly (Filter | null)[]): boolean {
	return (
		a.length === b.length &&
		a.every((x, i) => {
			const y = b[i];
			if (!x || !y) return !x && !y;
			return x.type === y.type && near(x.freq, y.freq) && near(x.q, y.q) && near(x.gain, y.gain);
		})
	);
}

interface Pass {
	slots: (Filter | null)[];
	/** For each input filter, its slot in `slots`. */
	slotOf: (number | null)[];
	/** Active input filters without a slot: no slot left, or projected flat with no room to stay. */
	lost: Map<number, 'unassigned' | 'flattened'>;
	violations: Violation[];
}

function pass(p: EngineProfile, wanted: readonly Filter[], preamp: number): Pass {
	// Under ascendingFrequency, a frequency-ordered assignment may do better than the min-cost
	// one. It wins only if it keeps as many filters and breaks fewer rules.
	let best = attempt(p, wanted, assignEngine(p, wanted), preamp);
	if (best.violations.some((v) => v.rule === 'ascendingFrequency')) {
		const other = attempt(p, wanted, orderedAssignEngine(p, wanted), preamp);
		const kept = (a: Pass) => a.slots.filter((f) => f && isActive(f)).length;
		if (kept(other) >= kept(best) && other.violations.length < best.violations.length) best = other;
	}
	return best;
}

function fitPreamp(mode: Preamp, preamp: number): number {
	if (mode.mode === 'manual') return project(preamp, mode.gain, 'preamp');
	if (mode.mode === 'none') return 0;
	return preamp;
}

function attempt(
	p: EngineProfile,
	wanted: readonly Filter[],
	activeOnly: AssignResult,
	preamp: number
): Pass {
	const assigned = withFlat(p, wanted, activeOnly);
	if (assigned === activeOnly) return place(p, wanted, activeOnly, preamp);
	// Flat filters only fill in: if laying them out costs a rule, write the active ones alone.
	const flat = place(p, wanted, assigned, preamp);
	const bare = place(p, wanted, activeOnly, preamp);
	return flat.violations.length <= bare.violations.length ? flat : bare;
}

function place(
	p: EngineProfile,
	wanted: readonly Filter[],
	assigned: AssignResult,
	preamp: number
): Pass {
	const bounded = p.bandCount !== null;
	const filterIn = new Map<number, number>();
	assigned.slotOf.forEach((s, k) => {
		if (s !== null) filterIn.set(s, k);
	});
	const slotAt = (s: number) => p.slots[p.bandCount === null ? 0 : s] as EngineSlot;
	const lost = new Map<number, 'unassigned' | 'flattened'>();
	assigned.slotOf.forEach((s, k) => {
		if (s === null && isActive(wanted[k] as Filter)) lost.set(k, 'unassigned');
	});
	let slots = assigned.slots.map((f, s) => {
		if (!f) return null;
		const k = filterIn.get(s) as number;
		const w = wanted[k] as Filter;
		const g = fitToSlot(slotAt(s), w);
		// A flat filter that can only be written active is left out: fit never adds one.
		if (!isActive(w)) return isActive(g) ? null : g;
		// One projected flat keeps its slot, written flat, where the engine has slots to keep.
		if (isActive(g) || bounded) return g;
		lost.set(k, 'flattened');
		return null;
	});
	let slotOf = assigned.slotOf.map((s) => (s !== null && slots[s] ? s : null));
	if (p.bandCount === null) {
		// Unbounded: no empty slots.
		const index = new Map<number, number>();
		slots = slots.filter((f, s) => {
			if (f) index.set(s, index.size);
			return f !== null;
		});
		slotOf = slotOf.map((s) => (s === null ? null : (index.get(s) as number)));
	}
	const wantedIn = new Map<number, Filter>();
	slotOf.forEach((s, k) => {
		if (s !== null) wantedIn.set(s, wanted[k] as Filter);
	});
	for (const rule of p.profile.rules ?? []) {
		if (rule.type === 'minSpacing') spread(p, slots, wantedIn, slotAt, rule.octaves);
	}
	if (!bounded) return { slots, slotOf, lost, violations: validateEngine(p, slots, preamp) };
	const kept = keepFlatWithinRules(p, slots, preamp);
	slotOf = slotOf.map((s, k) => {
		if (s === null || kept.slots[s]) return s;
		if (isActive(wanted[k] as Filter)) lost.set(k, 'flattened');
		return null;
	});
	return { slots: kept.slots, slotOf, lost, violations: kept.violations };
}

/**
 * The slots with as many flat filters as the rules allow: all of them when they add no violation,
 * otherwise each one, in slot order, that doesn't add one. Flat filters never move an active one,
 * and minSpacing ignores them, so spreading first and deciding here is safe.
 */
function keepFlatWithinRules(
	p: EngineProfile,
	slots: (Filter | null)[],
	preamp: number
): { slots: (Filter | null)[]; violations: Violation[] } {
	const all = validateEngine(p, slots, preamp);
	const flat = slots.flatMap((f, s) => (f && !isActive(f) ? [s] : []));
	if (flat.length === 0) return { slots, violations: all };
	let out = slots.map((f) => (f && isActive(f) ? f : null));
	let violations = validateEngine(p, out, preamp);
	if (all.length <= violations.length) return { slots, violations: all };
	for (const s of flat) {
		const trial = [...out];
		trial[s] = slots[s] as Filter;
		const v = validateEngine(p, trial, preamp);
		if (v.length <= violations.length) {
			out = trial;
			violations = v;
		}
	}
	return { slots: out, violations };
}

/**
 * minSpacing (SPEC §13.6 step 3): walk the active filters by ascending frequency and move each
 * one that sits too close to the previous up to the lowest frequency its domain allows at
 * `octaves` above it. A filter that can't get far enough stays where it is.
 */
function spread(
	p: EngineProfile,
	slots: (Filter | null)[],
	wanted: ReadonlyMap<number, Filter>,
	slotAt: (s: number) => EngineSlot,
	octaves: number
): void {
	const order = slots
		.flatMap((f, s) => (f && isActive(f) ? [s] : []))
		.sort((a, b) => compareNear((slots[a] as Filter).freq, (slots[b] as Filter).freq) || a - b);
	const farEnough = (a: number, b: number) => {
		const gap = Math.log2(b / a);
		return gap >= octaves || near(gap, octaves);
	};
	for (let i = 1; i < order.length; i++) {
		const prev = (slots[order[i - 1] as number] as Filter).freq;
		const s = order[i] as number;
		if (farEnough(prev, (slots[s] as Filter).freq)) continue;
		const moved = fitToSlot(slotAt(s), wanted.get(s) as Filter, prev * 2 ** octaves);
		if (farEnough(prev, moved.freq)) slots[s] = moved;
	}
}
