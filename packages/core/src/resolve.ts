import { fieldOrder, type NumericField } from './dependencies.ts';
import { isLockedDomain, near } from './domain.ts';
import { normalizeFilter, type Filter } from './filter.ts';
import { mergeSlotFields, slotOverrides } from './slots.ts';
import type {
	Domain,
	FilterType,
	Law,
	NumericCondition,
	Profile,
	Variant,
	When
} from './types/schema.generated.ts';

/** One merged slot, ready for the engine. */
export interface EngineSlot {
	label?: string;
	types: FilterType[];
	freq: Domain;
	q: Domain;
	gain: Domain;
	variants: Variant[];
	/** Evaluation order of the numeric fields (`type` comes first). */
	order: NumericField[];
}

/**
 * A profile prepared for the engine operations: merged slots, field orders, laws. Built once per
 * operation; profiles are never cached across calls, since apps edit them in place.
 */
export interface EngineProfile {
	profile: Profile;
	bandCount: number | null;
	/** One per slot, or the template alone when unbounded. */
	slots: EngineSlot[];
	laws: Law[];
	/** Every slot accepts exactly the same filters. */
	homogeneous: boolean;
}

export function engineProfile(profile: Profile): EngineProfile {
	const overrides = slotOverrides(profile);
	const laws = profile.realization?.laws ?? [];
	const slots: EngineSlot[] = [];
	for (let i = 0; i < (profile.bandCount ?? 1); i++) {
		const merged = mergeSlotFields(profile.band, overrides.get(i)?.entry);
		const { label, types, freq, q, gain, variants = [] } = merged;
		if (!types || !freq || !q || !gain) {
			throw new Error(
				`profile "${profile.id}" is invalid: slot ${i} lacks types, freq, q or gain (run validateProfile)`
			);
		}
		slots.push({
			...(label !== undefined && { label }),
			types,
			freq,
			q,
			gain,
			variants,
			order: fieldOrder(merged, laws)
		});
	}
	const key = (s: EngineSlot) => JSON.stringify([s.types, s.freq, s.q, s.gain, s.variants]);
	const first = key(slots[0] as EngineSlot);
	return {
		profile,
		bandCount: profile.bandCount,
		slots,
		laws,
		homogeneous: slots.every((s) => key(s) === first)
	};
}

export function engineSlot(p: EngineProfile, i: number): EngineSlot {
	const bounded = p.bandCount !== null;
	if (!Number.isInteger(i) || i < 0 || (bounded && i >= (p.bandCount as number))) {
		throw new RangeError(`slot ${i} does not exist (bandCount is ${p.bandCount})`);
	}
	return p.slots[bounded ? i : 0] as EngineSlot;
}

function numericHolds(c: NumericCondition, x: number | undefined): boolean {
	if (x === undefined || x === null || Number.isNaN(x)) return false;
	return (
		(c.eq === undefined || near(x, c.eq)) &&
		(c.gt === undefined || (x > c.gt && !near(x, c.gt))) &&
		(c.gte === undefined || x > c.gte || near(x, c.gte)) &&
		(c.lt === undefined || (x < c.lt && !near(x, c.lt))) &&
		(c.lte === undefined || x < c.lte || near(x, c.lte))
	);
}

/** Whether all conditions hold (SPEC §6). Comparisons use the §4 tolerance. */
export function whenHolds(when: When, values: Partial<Filter>): boolean {
	if (when.type) {
		const t = values.type;
		if (t === undefined || t === null) return false;
		if (when.type.eq !== undefined && t !== when.type.eq) return false;
		if (when.type.in !== undefined && !when.type.in.includes(t)) return false;
	}
	for (const f of ['freq', 'q', 'gain'] as const) {
		const c = when[f];
		if (c && !numericHolds(c, values[f])) return false;
	}
	return true;
}

/** Effective domain of one field: the first variant that holds and defines it, else the slot's (SPEC §6). */
export function resolveField(
	slot: EngineSlot,
	field: NumericField,
	values: Partial<Filter>
): Domain {
	for (const v of slot.variants) {
		const d = v[field];
		if (d && whenHolds(v.when, values)) return d;
	}
	return slot[field];
}

/** Domains of one slot, with variants resolved against a filter if one is given (SPEC §13.1). */
export interface EffectiveSlot {
	label?: string;
	types: FilterType[];
	freq: Domain;
	q: Domain;
	gain: Domain;
	/** Fields with exactly one allowed value; UIs render them read-only. */
	locked: { type: boolean; freq: boolean; q: boolean; gain: boolean };
}

/**
 * Merge `band` with the override for slot `i`, and select variants against `filter` when given
 * (SPEC §13.1). Exact and normative. Throws a RangeError for a slot that doesn't exist.
 */
export function resolveSlot(profile: Profile, i: number, filter?: Filter): EffectiveSlot {
	return effectiveSlot(engineSlot(engineProfile(profile), i), filter);
}

export function effectiveSlot(slot: EngineSlot, filter?: Filter): EffectiveSlot {
	const values = filter ? normalizeFilter(filter) : {};
	const freq = resolveField(slot, 'freq', values);
	const q = resolveField(slot, 'q', values);
	const gain = resolveField(slot, 'gain', values);
	return {
		...(slot.label !== undefined && { label: slot.label }),
		types: slot.types,
		freq,
		q,
		gain,
		locked: {
			type: slot.types.length === 1,
			freq: isLockedDomain(freq),
			q: isLockedDomain(q),
			gain: isLockedDomain(gain)
		}
	};
}
