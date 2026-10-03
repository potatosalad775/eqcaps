import { assignEngine } from './assign.ts';
import { compareNear, near } from './domain.ts';
import { ascendingBreaks } from './filler.ts';
import { isActive, isKnownType, normalizeFilter, usesGain, type Filter } from './filter.ts';
import { domainViolation } from './project.ts';
import { engineProfile, resolveField, type EngineProfile } from './resolve.ts';
import type { Domain, FilterType, Profile, Rule } from './types/schema.generated.ts';

export type ViolationCode =
	| 'type-not-allowed'
	| 'unknown-type'
	| 'out-of-range'
	| 'off-grid'
	| 'not-in-set'
	| 'locked'
	| 'too-many-bands'
	| 'rule-violated'
	| 'unknown-rule';

/** Why a set of written filters is not accepted (SPEC §13.4). */
export interface Violation {
	/** The slot at fault; null for profile-level problems (unknown rule, preamp, band count). */
	slot: number | null;
	field: 'type' | 'freq' | 'q' | 'gain' | 'preamp' | null;
	code: ViolationCode;
	/** The rule's type, for rule-violated and unknown-rule. */
	rule?: string;
	/** What would have been valid. */
	allowed?: Domain | FilterType[];
	/** validateList only: index of the input filter at fault. */
	filter?: number;
}

const KNOWN_RULES: ReadonlySet<string> = new Set(['ascendingFrequency', 'minSpacing']);

/**
 * Check an assigned array of written filters, one per slot, null for empty (SPEC §13.4). Exact
 * and normative. Violations come in this order: per slot, ascending, the type and then freq, q,
 * gain; too-many-bands; each rule in profile order; preamp. `preamp` is in dB; leave it out when
 * the app has none.
 */
export function validate(
	profile: Profile,
	slots: readonly (Filter | null)[],
	preamp?: number
): Violation[] {
	return validateEngine(engineProfile(profile), slots, preamp);
}

export function validateEngine(
	p: EngineProfile,
	slots: readonly (Filter | null | undefined)[],
	preamp?: number
): Violation[] {
	const out: Violation[] = [];
	const count = p.bandCount ?? slots.length;
	for (let i = 0; i < Math.min(count, slots.length); i++) {
		const raw = slots[i];
		if (!raw) continue;
		const f = normalizeFilter(raw);
		const slot = p.slots[p.bandCount === null ? 0 : i];
		if (!slot) continue;
		if (!slot.types.includes(f.type)) {
			out.push({ slot: i, field: 'type', code: 'type-not-allowed', allowed: slot.types });
		} else if (!isKnownType(f.type)) {
			out.push({ slot: i, field: 'type', code: 'unknown-type' });
		}
		for (const field of ['freq', 'q', 'gain'] as const) {
			if (field === 'gain' && !usesGain(f.type)) continue;
			const domain = resolveField(slot, field, f);
			const code = domainViolation(f[field], domain);
			if (code) out.push({ slot: i, field, code, allowed: domain });
		}
	}
	if (p.bandCount !== null && slots.slice(p.bandCount).some(Boolean)) {
		out.push({ slot: null, field: null, code: 'too-many-bands' });
	}
	for (const rule of p.profile.rules ?? []) out.push(...checkRule(p, slots, rule));
	if (preamp !== undefined) {
		const pre = p.profile.preamp;
		if (pre.mode === 'manual') {
			const code = domainViolation(preamp, pre.gain);
			if (code) out.push({ slot: null, field: 'preamp', code, allowed: pre.gain });
		} else if (pre.mode === 'none' && !near(preamp, 0)) {
			out.push({ slot: null, field: 'preamp', code: 'locked', allowed: { value: 0 } });
		}
	}
	return out;
}

function checkRule(
	p: EngineProfile,
	slots: readonly (Filter | null | undefined)[],
	rule: Rule
): Violation[] {
	const type = (rule as { type: string }).type;
	if (!KNOWN_RULES.has(type))
		return [{ slot: null, field: null, code: 'unknown-rule', rule: type }];
	const violated = (slot: number): Violation => ({
		slot,
		field: 'freq',
		code: 'rule-violated',
		rule: type
	});
	if (rule.type === 'ascendingFrequency') {
		return ascendingBreaks(p, slots, rule.strict ?? true).map(violated);
	}
	if (rule.type === 'minSpacing') {
		return spacingBreaks(p, slots, rule.octaves).map(violated);
	}
	return [];
}

/**
 * Slots whose active filter sits closer than `octaves` to the next lower active filter. Ties in
 * frequency are ordered by slot index; the higher slot of the pair is reported.
 */
export function spacingBreaks(
	p: EngineProfile,
	slots: readonly (Filter | null | undefined)[],
	octaves: number
): number[] {
	const count = p.bandCount ?? slots.length;
	const active: { slot: number; freq: number }[] = [];
	for (let i = 0; i < Math.min(count, slots.length); i++) {
		const f = slots[i];
		if (f && isActive(normalizeFilter(f))) active.push({ slot: i, freq: f.freq });
	}
	active.sort((a, b) => compareNear(a.freq, b.freq) || a.slot - b.slot);
	const breaks: number[] = [];
	for (let k = 1; k < active.length; k++) {
		const lo = active[k - 1] as { freq: number };
		const hi = active[k] as { slot: number; freq: number };
		const gap = Math.log2(hi.freq / lo.freq);
		if (gap < octaves && !near(gap, octaves)) breaks.push(hi.slot);
	}
	return breaks.sort((a, b) => a - b);
}

/**
 * The convenience check apps run while editing (SPEC §13.4): normalize each filter, `assign`,
 * `validate`, plus a too-many-bands violation for each filter that found no slot. Violations
 * about a slot also name the input filter in `filter`. Not normative, because assign isn't.
 */
export function validateList(
	profile: Profile,
	filters: readonly Filter[],
	preamp?: number
): Violation[] {
	const p = engineProfile(profile);
	const written = filters.map(normalizeFilter);
	const assigned = assignEngine(p, written);
	const filterOf = new Map<number, number>();
	assigned.slotOf.forEach((s, k) => {
		if (s !== null) filterOf.set(s, k);
	});
	const out = validateEngine(p, assigned.slots, preamp).map((v) => {
		const k = v.slot === null ? undefined : filterOf.get(v.slot);
		return k === undefined ? v : { ...v, filter: k };
	});
	written.forEach((f, k) => {
		if (assigned.slotOf[k] === null && isActive(f)) {
			out.push({ slot: null, field: null, code: 'too-many-bands', filter: k });
		}
	});
	return out;
}
