// From what a probe found to profile constraints (INSPECTOR §3.2 step 5): band count, per-slot
// types and domains (template plus overrides), variants, the ordering rule and the preamp. What a
// probe didn't look at (a quick probe's Q, say) comes from the matched profile, else from the
// codec's wire, and the notes say so.

import {
	mergeSlotFields,
	near,
	onGrid,
	slotOverrides,
	type BandOverride,
	type Domain,
	type FilterType,
	type Preamp,
	type Profile,
	type Rule,
	type SlotFields,
	type Variant
} from '@potatosalad775/eqcaps-core';
import type { CodecAnalysis } from '@potatosalad775/eqcaps-device-bridge';
import type { Bound, FieldFinding, ProbeResult } from './types.ts';

/** The constraint part of a profile, as a probe derives it. */
export interface DerivedConstraints {
	bandCount: number;
	band: SlotFields;
	bands?: BandOverride[];
	rules: Rule[];
	preamp: Preamp;
}

export interface Derivation {
	constraints: DerivedConstraints;
	/** What the derivation assumed or couldn't settle, for `meta.notes` and the screen. */
	notes: string[];
}

/** Used for a field neither the probe, the profile nor the wire bounds. */
const DEFAULTS: Record<'freq' | 'q' | 'gain', Domain> = {
	freq: { min: 20, max: 20000, step: 1 },
	q: { min: 0.1, max: 10, step: 0.01 },
	gain: { min: -12, max: 12, step: 0.1 }
};

const LABEL = { freq: 'frequency', q: 'Q', gain: 'gain', preamp: 'preamp' } as const;

function boundNote(field: keyof typeof LABEL, side: 'min' | 'max', b: Bound, where: string) {
	if (b.how === 'limit') {
		return `${LABEL[field]} ${side === 'max' ? 'maximum' : 'minimum'}${where}: the device took the probe's search limit (${b.value}), so the real bound is ${side === 'max' ? 'at least' : 'at most'} that.`;
	}
	if (b.how === 'inconclusive') {
		return `${LABEL[field]} ${side === 'max' ? 'maximum' : 'minimum'}${where}: inconclusive; ${b.value} is the furthest value the device kept.`;
	}
	return null;
}

/** A domain from a finding: a set, a locked value, or a range on the device's grid. */
function domainOf(
	f: FieldFinding,
	step: number | undefined,
	field: keyof typeof LABEL,
	where: string,
	notes: string[]
): Domain | null {
	if (f.values) {
		if (f.values.length === 0) return null;
		return f.values.length === 1 ? { value: f.values[0]! } : { values: f.values };
	}
	if (!f.min || !f.max) return null;
	for (const [side, b] of [
		['min', f.min],
		['max', f.max]
	] as const) {
		const n = boundNote(field, side, b, where);
		if (n) notes.push(n);
	}
	const min = f.min.value;
	const max = f.max.value;
	if (near(min, max)) return { value: min };
	if (step && onGrid(min, step) && onGrid(max, step)) return { min, max, step };
	if (step)
		notes.push(
			`${LABEL[field]}${where}: bounds ${min} and ${max} are off the ${step} grid, so no step is given.`
		);
	return { min, max };
}

/** Slot `i` of `profile`, merged, with its variants. */
function profileSlot(profile: Profile | undefined, i: number): SlotFields | undefined {
	if (!profile || (profile.bandCount !== null && i >= profile.bandCount)) return undefined;
	return mergeSlotFields(profile.band, slotOverrides(profile).get(i)?.entry);
}

/** Variants from conditional windows: one per window, type conditions merged where they agree. */
function variantsOf(
	conditions: NonNullable<ProbeResult['findings']['slots'][number]['conditions']>,
	step: number | undefined,
	where: string,
	notes: string[]
): Variant[] {
	const typed = new Map<string, { types: FilterType[]; freq: Domain }>();
	const other: Variant[] = [];
	for (const c of conditions) {
		const freq = domainOf(c.freq, step, 'freq', `${where} (${c.label})`, notes);
		if (!freq) continue;
		const type = c.when.type?.eq;
		if (type) {
			const key = JSON.stringify(freq);
			const entry = typed.get(key) ?? { types: [], freq };
			entry.types.push(type);
			typed.set(key, entry);
		} else other.push({ when: c.when, freq });
	}
	const byType: Variant[] = [...typed.values()].map((e) => ({
		when: { type: e.types.length === 1 ? { eq: e.types[0]! } : { in: e.types } },
		freq: e.freq
	}));
	return [...byType, ...other];
}

/**
 * Per-key template and overrides from one merged slot per index: the template takes each key's
 * most common value, and slots that differ get an override, grouped by equal content (SPEC §5.2).
 */
export function assembleSlots(slots: readonly SlotFields[]): {
	band: SlotFields;
	bands?: BandOverride[];
} {
	const keys = ['label', 'types', 'freq', 'q', 'gain', 'variants'] as const;
	const band: SlotFields = {};
	for (const key of keys) {
		const counts = new Map<string, number>();
		for (const s of slots) {
			const v = JSON.stringify(s[key] ?? null);
			counts.set(v, (counts.get(v) ?? 0) + 1);
		}
		const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
		if (best && best[0] !== 'null') (band as Record<string, unknown>)[key] = JSON.parse(best[0]);
	}
	const groups = new Map<string, number[]>();
	slots.forEach((s, i) => {
		const diff: Record<string, unknown> = {};
		for (const key of keys) {
			const v = JSON.stringify(s[key] ?? null);
			if (v !== JSON.stringify(band[key] ?? null)) diff[key] = s[key] ?? [];
		}
		if (Object.keys(diff).length === 0) return;
		const k = JSON.stringify(diff);
		groups.set(k, [...(groups.get(k) ?? []), i]);
	});
	const bands: BandOverride[] = [...groups.entries()].map(([k, idx]) => ({
		index: idx.length === 1 ? idx[0]! : idx,
		...(JSON.parse(k) as SlotFields)
	}));
	return bands.length ? { band, bands } : { band };
}

const realTypes = (types: readonly FilterType[]) => types.filter((t) => !t.startsWith('x-'));

/** The profile constraints a probe's findings support; null when the band count wasn't found. */
export function deriveConstraints(
	result: Pick<ProbeResult, 'findings' | 'mode'>,
	context: { analysis: CodecAnalysis; profile?: Profile }
): Derivation | null {
	const { findings } = result;
	if (!findings.bandCount) return null;
	const notes: string[] = [];
	const { analysis, profile } = context;
	const count = findings.bandCount.value;
	if (findings.bandCount.atLeast) {
		notes.push(`Band count: the device kept all ${count} bands written, so it may have more.`);
	}
	const step = (field: 'freq' | 'q' | 'gain' | 'preamp') => {
		const s = findings.steps[field];
		if (s?.kind === 'grid') return s.step;
		const w = field === 'preamp' ? analysis.wire.preamp : analysis.wire[field];
		return w && !('values' in w) ? w.step : undefined;
	};
	const fallbacks = new Set<string>();
	const slots: SlotFields[] = [];
	for (let i = 0; i < count; i++) {
		const f = findings.slots[i] ?? {};
		const known = profileSlot(profile, i);
		const where = count > 1 ? ` in band ${i + 1}` : '';
		const slot: SlotFields = {};
		if (known?.label !== undefined) slot.label = known.label;
		if (f.types) slot.types = f.types;
		else {
			slot.types = known?.types ?? realTypes(analysis.types);
			fallbacks.add(
				`types (${known?.types ? 'from the profile' : 'every type the protocol can write'})`
			);
		}
		for (const field of ['freq', 'q', 'gain'] as const) {
			const probed = f[field] ? domainOf(f[field]!, step(field), field, where, notes) : null;
			if (probed) {
				slot[field] = probed;
				continue;
			}
			const fromProfile = known?.[field];
			const fromWire = analysis[field];
			slot[field] = fromProfile ?? fromWire ?? DEFAULTS[field];
			fallbacks.add(
				`${LABEL[field]} (${fromProfile ? 'from the profile' : fromWire ? 'the protocol’s wire limits' : 'a placeholder'})`
			);
		}
		if (f.conditions?.length) {
			const variants = variantsOf(f.conditions, step('freq'), where, notes);
			if (variants.length) slot.variants = variants;
		} else if (result.mode === 'quick' && known?.variants?.length) {
			slot.variants = known.variants;
		}
		slots.push(slot);
	}
	if (fallbacks.size) {
		notes.push(`Not probed: ${[...fallbacks].join(', ')}. Check these by hand.`);
	}
	const { band, bands } = assembleSlots(slots);

	let rules: Rule[];
	const order = findings.order;
	if (order && 'rule' in order) {
		rules =
			order.rule === 'none'
				? []
				: [{ type: 'ascendingFrequency', ...(order.strict === false ? { strict: false } : {}) }];
		if (order.rule === 'reorders') {
			notes.push(
				'The device sorts bands by frequency itself; writing them in ascending order keeps read-backs in step.'
			);
		}
		const spacing = profile?.rules?.filter((r) => r.type !== 'ascendingFrequency') ?? [];
		rules.push(...spacing);
	} else {
		rules = profile?.rules ?? [];
	}

	let preamp: Preamp;
	if (findings.preamp) {
		const d = domainOf(findings.preamp, step('preamp'), 'preamp', '', notes);
		preamp = d ? { mode: 'manual', gain: d } : (profile?.preamp ?? { mode: 'unknown' });
	} else {
		preamp = profile?.preamp ?? { mode: 'unknown' };
	}

	if (findings.wholeSet) {
		notes.push(
			'The device refused whole writes when one band was invalid, so it was probed band by band.'
		);
	}
	if (findings.resets) {
		notes.push(
			`${findings.resets} write${findings.resets > 1 ? 's' : ''} changed bands that weren't under test (possible silent resets); those test values were counted as refused.`
		);
	}
	return {
		constraints: { bandCount: count, band, ...(bands ? { bands } : {}), rules, preamp },
		notes
	};
}
