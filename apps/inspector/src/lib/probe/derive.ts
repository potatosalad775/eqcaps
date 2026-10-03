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
import { bandList } from './compare.ts';
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
	/**
	 * The device took every value the probe sent, up to its search limits, in every field
	 * probed: it seems to store what it is sent without checking it, so the probe says nothing
	 * about its ranges. Such a probe isn't counting evidence for them.
	 */
	unchecked: boolean;
}

/** Used for a field neither the probe, the profile nor the wire bounds. */
const DEFAULTS: Record<'freq' | 'q' | 'gain', Domain> = {
	freq: { min: 20, max: 20000, step: 1 },
	q: { min: 0.1, max: 10, step: 0.01 },
	gain: { min: -12, max: 12, step: 0.1 }
};

const LABEL = { freq: 'frequency', q: 'Q', gain: 'gain', preamp: 'preamp' } as const;

/**
 * Notes about bands, one line for every band a note applies to ("gain maximum in every band:
 * …"). A note's text marks where the bands go with `{where}`.
 */
class Notes {
	private readonly lines = new Map<string, number[]>();
	constructor(private readonly count: number) {}

	add(text: string, band?: number) {
		const bands = this.lines.get(text) ?? [];
		if (band !== undefined) bands.push(band);
		this.lines.set(text, bands);
	}

	list(): string[] {
		return [...this.lines].map(([text, bands]) =>
			text.replace('{where}', bands.length ? bandsWhere(bands, this.count) : '')
		);
	}
}

/** " in band 3", " in bands 1–4, 6", " in every band"; nothing for a one-band engine. */
function bandsWhere(bands: readonly number[], count: number): string {
	if (count <= 1) return '';
	if (new Set(bands).size >= count) return ' in every band';
	const list = bandList(bands);
	return ` in band${bands.length > 1 ? 's' : ''} ${list}`;
}

function boundNote(field: keyof typeof LABEL, side: 'min' | 'max', b: Bound, label = '') {
	const name = `${LABEL[field]} ${side === 'max' ? 'maximum' : 'minimum'}{where}${label}`;
	if (b.how === 'limit') {
		return `${name}: the device took the probe's search limit (${b.value}), so the real bound is ${side === 'max' ? 'at least' : 'at most'} that.`;
	}
	if (b.how === 'inconclusive') {
		return `${name}: inconclusive; ${b.value} is the furthest value the device kept.`;
	}
	return null;
}

/** A domain from a finding: a set, a locked value, or a range on the device's grid. */
function domainOf(
	f: FieldFinding,
	step: number | undefined,
	field: keyof typeof LABEL,
	notes: Notes,
	band?: number,
	label = ''
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
		const n = boundNote(field, side, b, label);
		if (n) notes.add(n, band);
	}
	const min = f.min.value;
	const max = f.max.value;
	if (near(min, max)) return { value: min };
	if (step && onGrid(min, step) && onGrid(max, step)) return { min, max, step };
	if (step) {
		notes.add(
			`${LABEL[field]}{where}${label}: bounds ${min} and ${max} are off the ${step} grid, so no step is given.`,
			band
		);
	}
	return { min, max };
}

/** Both bounds at the search limit: the device took everything the probe sent. */
const unbounded = (f: FieldFinding | undefined) =>
	f?.min?.how === 'limit' && f?.max?.how === 'limit';

/** Slot `i` of `profile`, merged, with its variants. */
function profileSlot(profile: Profile | undefined, i: number): SlotFields | undefined {
	if (!profile || (profile.bandCount !== null && i >= profile.bandCount)) return undefined;
	return mergeSlotFields(profile.band, slotOverrides(profile).get(i)?.entry);
}

/** Variants from conditional windows: one per window, type conditions merged where they agree. */
function variantsOf(
	conditions: NonNullable<ProbeResult['findings']['slots'][number]['conditions']>,
	step: number | undefined,
	notes: Notes,
	band: number
): Variant[] {
	const typed = new Map<string, { types: FilterType[]; freq: Domain }>();
	const other: Variant[] = [];
	for (const c of conditions) {
		const freq = domainOf(c.freq, step, 'freq', notes, band, ` (${c.label})`);
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
	const { analysis, profile } = context;
	const count = findings.bandCount.value;
	const notes = new Notes(count);
	const limit = findings.bandCount.writeLimit;
	if (limit) {
		notes.add(
			`Band count: writes of ${limit.refused} bands or more changed nothing, while writes of ${limit.kept} were kept. That may be the device, or the way this protocol writes to it: ${count} is what the device took from this protocol.`
		);
	} else if (findings.bandCount.atLeast) {
		notes.add(`Band count: the device kept all ${count} bands written, so it may have more.`);
	}
	const step = (field: 'freq' | 'q' | 'gain' | 'preamp') => {
		const s = findings.steps[field];
		if (s?.kind === 'grid') return s.step;
		const w = field === 'preamp' ? analysis.wire.preamp : analysis.wire[field];
		return w && !('values' in w) ? w.step : undefined;
	};
	const fallbacks = new Set<string>();
	let searched = 0;
	let open = 0;
	const slots: SlotFields[] = [];
	for (let i = 0; i < count; i++) {
		const f = findings.slots[i] ?? {};
		const known = profileSlot(profile, i);
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
			const finding = f[field];
			if (finding?.min && finding.max) searched++;
			if (unbounded(finding)) {
				open++;
				// The device took everything up to the limits: that says nothing about its range.
				if (known?.[field]) {
					slot[field] = known[field];
					notes.add(
						`${LABEL[field]}{where}: the device took every value up to the probe's search limits, so the probe can't tell its range; the profile's is kept.`,
						i
					);
					continue;
				}
			}
			const probed = finding ? domainOf(finding, step(field), field, notes, i) : null;
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
			const variants = variantsOf(f.conditions, step('freq'), notes, i);
			if (variants.length) slot.variants = variants;
		} else if (result.mode === 'quick' && known?.variants?.length) {
			slot.variants = known.variants;
		}
		slots.push(slot);
	}
	if (fallbacks.size) {
		notes.add(`Not probed: ${[...fallbacks].join(', ')}. Check these by hand.`);
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
			notes.add(
				'The device sorts bands by frequency itself; writing them in ascending order keeps read-backs in step.'
			);
		}
		const spacing = profile?.rules?.filter((r) => r.type !== 'ascendingFrequency') ?? [];
		rules.push(...spacing);
	} else {
		rules = profile?.rules ?? [];
	}

	let preamp: Preamp;
	const pre = findings.preamp;
	if (pre && unbounded(pre) && profile?.preamp.mode === 'manual') {
		preamp = profile.preamp;
		notes.add(
			"preamp: the device took every value up to the probe's search limits, so the probe can't tell its range; the profile's is kept."
		);
	} else if (pre) {
		const d = domainOf(pre, step('preamp'), 'preamp', notes);
		preamp = d ? { mode: 'manual', gain: d } : (profile?.preamp ?? { mode: 'unknown' });
	} else {
		preamp = profile?.preamp ?? { mode: 'unknown' };
	}

	if (findings.wholeSet) {
		notes.add(
			'The device refused whole writes when one band was invalid, so it was probed band by band.'
		);
	}
	if (findings.resets) {
		notes.add(
			`${findings.resets} write${findings.resets > 1 ? 's' : ''} changed bands that weren't under test (possible silent resets); those test values were counted as refused.`
		);
	}
	const unchecked = searched > 0 && open === searched;
	const list = notes.list();
	if (unchecked) {
		list.unshift(
			"The device took every value the probe sent, up to its search limits, in every field: it seems to store what it is sent without checking it. Reading back can't show such a device's limits; take its ranges from the vendor's app or documents, or from a measurement."
		);
	}
	return {
		constraints: { bandCount: count, band, ...(bands ? { bands } : {}), rules, preamp },
		notes: list,
		unchecked
	};
}
