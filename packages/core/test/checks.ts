import { expect } from 'vitest';
import {
	assign,
	complete,
	fit,
	isActive,
	near,
	normalizeFilter,
	validate,
	validateList,
	type Filter,
	type Profile
} from '../src/index.ts';
import { fitsSlot } from '../src/assign.ts';
import { engineProfile, type EngineSlot } from '../src/resolve.ts';

// The normative properties of the property ops (SPEC §13.5–§13.7), as assertions. Shared by the
// random property tests and the conformance vectors for assign, fit and complete.

export const same = (a: Filter | null | undefined, b: Filter | null | undefined): boolean =>
	(!a && !b) ||
	(!!a &&
		!!b &&
		a.type === b.type &&
		near(a.freq, b.freq) &&
		near(a.q, b.q) &&
		near(a.gain, b.gain));

/** Equal as multisets, within ε. */
export function sameMultiset(as: readonly Filter[], bs: readonly Filter[]): boolean {
	if (as.length !== bs.length) return false;
	const left = [...bs];
	return as.every((a) => {
		const i = left.findIndex((b) => same(a, b));
		if (i < 0) return false;
		left.splice(i, 1);
		return true;
	});
}

export const present = (xs: readonly (Filter | null)[]) =>
	xs.filter((x): x is Filter => x !== null);
const activeCount = (xs: readonly (Filter | null)[]) =>
	present(xs).map(normalizeFilter).filter(isActive).length;

/** Codes that may remain after fit: rules it couldn't satisfy, and what this engine can't check. */
const RESIDUAL = new Set(['rule-violated', 'unknown-rule', 'unknown-type']);

/** Sound: feasible ⇔ validate(slots) = []; slots and preamp always land in their domains. */
export function checkSound(profile: Profile, filters: Filter[], preamp: number): void {
	const r = fit(profile, filters, preamp);
	const violations = validate(profile, r.slots, r.preamp);
	expect(r.feasible).toBe(violations.length === 0);
	expect(violations.filter((v) => !RESIDUAL.has(v.code))).toEqual([]);
}

/** Faithful: validateList(x) = [] ⇒ the slots hold x, with no changes. Returns whether it applied. */
export function checkFaithful(profile: Profile, filters: Filter[], preamp: number): boolean {
	if (validateList(profile, filters, preamp).length > 0) return false;
	const r = fit(profile, filters, preamp);
	expect(r.changes).toEqual([]);
	expect(r.unassigned).toEqual([]);
	expect(r.feasible).toBe(true);
	const wanted = filters.map(normalizeFilter).filter(isActive);
	expect(sameMultiset(present(r.slots), wanted), JSON.stringify({ r, wanted })).toBe(true);
	return true;
}

/** Idempotent: fit(F.slots) has F's slots, preamp and feasibility. */
export function checkIdempotent(profile: Profile, filters: Filter[], preamp: number): void {
	const f = fit(profile, filters, preamp);
	const g = fit(profile, present(f.slots), f.preamp);
	const ctx = JSON.stringify({ f: f.slots, g: g.slots });
	expect(g.slots.length, ctx).toBe(f.slots.length);
	g.slots.forEach((s, i) => expect(same(s, f.slots[i]), ctx).toBe(true));
	expect(g.preamp).toBe(f.preamp);
	expect(g.feasible).toBe(f.feasible);
	// A feasible result is valid input, so a second fit changes nothing (faithful). An infeasible
	// one can come back with the same slots but its filters paired with different inputs.
	if (f.feasible) {
		expect(g.changes, ctx).toEqual([]);
		expect(g.unassigned).toEqual([]);
	}
}

/** fit never increases the number of active filters. */
export function checkNoAddedBands(profile: Profile, filters: Filter[], preamp: number): void {
	const r = fit(profile, filters, preamp);
	expect(activeCount(r.slots)).toBeLessThanOrEqual(activeCount(filters));
	expect(activeCount(r.slots) + r.unassigned.length).toBeLessThanOrEqual(activeCount(filters));
}

/** slotOf pairs every filled slot with exactly one wanted filter, the one its changes name. */
export function checkSlotOf(profile: Profile, filters: Filter[], preamp: number): void {
	const r = fit(profile, filters, preamp);
	expect(r.slotOf).toHaveLength(filters.length);
	const used = r.slotOf.filter((s): s is number => s !== null);
	expect(new Set(used).size).toBe(used.length);
	expect(used.every((s) => r.slots[s])).toBe(true);
	expect(used.length).toBe(r.slots.filter(Boolean).length);
	for (const c of r.changes) if (c.filter !== null) expect(c.slot).toBe(r.slotOf[c.filter]);
}

export function checkFit(profile: Profile, filters: Filter[], preamp: number): void {
	checkSound(profile, filters, preamp);
	checkSlotOf(profile, filters, preamp);
	checkFaithful(profile, filters, preamp);
	checkIdempotent(profile, filters, preamp);
	checkNoAddedBands(profile, filters, preamp);
}

/**
 * assign's normative property. `valid`: an assignment exists in which every active filter has a
 * slot whose types and domains accept it; then assign must return one.
 */
export function checkAssign(profile: Profile, filters: Filter[], valid: boolean): void {
	const p = engineProfile(profile);
	const r = assign(profile, filters);
	expect(r.slotOf).toHaveLength(filters.length);
	filters.forEach((f, k) => {
		if (!isActive(normalizeFilter(f))) expect(r.slotOf[k]).toBeNull();
	});
	if (!valid) return;
	expect(r.unassigned).toEqual([]);
	filters.forEach((f, k) => {
		if (!isActive(normalizeFilter(f))) return;
		const s = r.slotOf[k];
		expect(s).not.toBeNull();
		const slot = p.slots[p.bandCount === null ? 0 : (s as number)] as EngineSlot;
		expect(fitsSlot(slot, normalizeFilter(f)), JSON.stringify({ f, s })).toBe(true);
	});
}

/**
 * complete's properties: exactly bandCount filters, filled slots kept, fillers in their domains
 * and neutral unless a warning says otherwise, and ascendingFrequency kept whenever validate
 * found room for the fillers.
 */
export function checkComplete(profile: Profile, slots: (Filter | null)[]): void {
	const r = complete(profile, slots);
	if (profile.bandCount === null) {
		expect(r.filters).toEqual(present(slots).map(normalizeFilter));
		return;
	}
	expect(r.filters).toHaveLength(profile.bandCount);
	slots.slice(0, profile.bandCount).forEach((s, i) => {
		if (s) expect(r.filters[i]).toEqual(normalizeFilter(s));
	});
	const before = validate(profile, slots);
	const after = validate(profile, r.filters);
	const fillerFaults = after.filter(
		(v) => v.slot !== null && !slots[v.slot] && !RESIDUAL.has(v.code)
	);
	expect(fillerFaults).toEqual([]);
	const warned = new Set(r.warnings.filter((w) => w.code === 'not-neutral').map((w) => w.slot));
	r.filters.forEach((f, i) => {
		if (!slots[i] && !warned.has(i)) expect(isActive(f)).toBe(false);
	});
	const asc = (vs: typeof before) => vs.filter((v) => v.rule === 'ascendingFrequency');
	if (asc(before).length === 0) {
		expect(asc(after)).toEqual([]);
		expect(r.warnings.filter((w) => w.code === 'no-room')).toEqual([]);
	}
}
