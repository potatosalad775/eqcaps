// From a guided read's findings to profile constraints (INSPECTOR §3.3): band count, the slot
// template from band 1, overrides for bands that differ, and the preamp. A field no step settled
// comes from the matched profile, else from the protocol's wire limits, and the notes say which.

import {
	domainBounds,
	onGrid,
	type BandOverride,
	type Domain,
	type FilterType,
	type Preamp,
	type Profile,
	type SlotFields
} from '@potatosalad775/eqcaps-core';
import { LABEL, type BandFindings, type FieldFindings, type Inference } from './infer.ts';
import type { GuidedContext } from './types.ts';

export interface GuidedConstraints {
	bandCount: number;
	band: Required<Pick<SlotFields, 'types' | 'freq' | 'q' | 'gain'>>;
	bands?: BandOverride[];
	preamp: Preamp;
}

export interface Derived {
	constraints: GuidedConstraints;
	/** Where a value didn't come from the reads, and what disagreed: for `meta.notes`. */
	notes: string[];
	/** What a guided read never checks, for the evidence file's `notChecked`. */
	notChecked: string[];
}

/** Placeholders when neither the reads, the profile nor the wire bound a field. */
const DEFAULTS: Record<'freq' | 'q' | 'gain', Domain> = {
	freq: { min: 20, max: 20000, step: 1 },
	q: { min: 0.1, max: 10, step: 0.01 },
	gain: { min: -12, max: 12, step: 0.1 }
};

export const NOT_CHECKED = [
	'Conditional domains (a window that changes with gain or type) and rules were not checked.'
];

/**
 * The constraints the inference supports. `base` is the profile the device was matched to (its
 * slot template fills fields no step settled); `wireTypes` are the types the protocol can write,
 * used when no step listed the app's types.
 */
export function deriveConstraints(
	inf: Inference,
	ctx: GuidedContext,
	base: Profile | null,
	wireTypes: readonly FilterType[]
): Derived {
	const notes: string[] = [];
	const bandCount = inf.bandCount ?? base?.bandCount ?? ctx.first.filters.length;
	if (inf.bandCount === undefined) {
		notes.push(
			`Band count not given in the guided read: ${bandCount}, ${base ? `from ${base.id}` : 'as many as were read'}.`
		);
	}
	const fallback = (f: 'freq' | 'q' | 'gain'): { domain: Domain; from: string } => {
		const p = base?.band?.[f];
		if (p) return { domain: p, from: base!.id };
		const w = ctx.wire[f];
		if (w)
			return {
				domain: w.step ? { min: w.min, max: w.max, step: w.step } : { min: w.min, max: w.max },
				from: 'the protocol’s wire limits'
			};
		return { domain: DEFAULTS[f], from: 'placeholders' };
	};

	const first = inf.bands.get(1);
	const template = slot(first, first, fallback, wireTypes, base, notes, 'Band 1');
	const bands: BandOverride[] = [];
	const checked = [...inf.bands.keys()]
		.filter((b) => b > 1 && b <= bandCount)
		.sort((a, b) => a - b);
	for (const b of checked) {
		const own = slot(
			inf.bands.get(b),
			first,
			(f) => ({ domain: template[f], from: '' }),
			template.types,
			null,
			[],
			`Band ${b}`
		);
		const override: BandOverride = { index: b - 1 };
		for (const f of ['types', 'freq', 'q', 'gain'] as const) {
			if (JSON.stringify(own[f]) !== JSON.stringify(template[f]))
				Object.assign(override, { [f]: own[f] });
		}
		if (Object.keys(override).length > 1) bands.push(override);
	}
	const unchecked = Array.from({ length: bandCount }, (_, i) => i + 1).filter(
		(b) => !inf.bands.has(b)
	);
	if (first && unchecked.length) {
		notes.push(`${bandList(unchecked)} not checked: assumed to match band 1.`);
	}

	let preamp: Preamp;
	const p = inf.preamp;
	if (p.min !== undefined && p.max !== undefined) {
		preamp = { mode: 'manual', gain: domain(p, 'preamp', notes) };
	} else if (base) {
		preamp = base.preamp;
		if (ctx.readsPreamp) notes.push(`Preamp not checked: from ${base.id}.`);
	} else {
		preamp = { mode: 'unknown' };
		if (ctx.readsPreamp) notes.push('Preamp not checked.');
	}

	return {
		constraints: {
			bandCount,
			band: template,
			...(bands.length ? { bands } : {}),
			preamp
		},
		notes,
		notChecked: [...NOT_CHECKED]
	};
}

function slot(
	own: BandFindings | undefined,
	first: BandFindings | undefined,
	fallback: (f: 'freq' | 'q' | 'gain') => { domain: Domain; from: string },
	types: readonly FilterType[],
	base: Profile | null,
	notes: string[],
	where: string
): GuidedConstraints['band'] {
	const out = {} as GuidedConstraints['band'];
	for (const f of ['freq', 'q', 'gain'] as const) {
		const fb = fallback(f);
		const found: FieldFindings = { ...own?.[f] };
		// Steps are asked on band 1 only and hold for every band.
		if (found.step === undefined && first?.[f].step !== undefined) found.step = first[f].step;
		const missing = (['min', 'max'] as const).filter((k) => found[k] === undefined);
		if (missing.length === 2 && found.step === undefined) {
			out[f] = fb.domain;
			if (fb.from) notes.push(`${where} ${LABEL[f]} not checked: from ${fb.from}.`);
			continue;
		}
		const bounds = domainBounds(fb.domain);
		for (const k of missing) found[k] = bounds[k];
		if (missing.length && fb.from) {
			notes.push(`${where} ${LABEL[f]} ${missing.join(' and ')} not checked: from ${fb.from}.`);
		}
		if (found.step === undefined && 'step' in fb.domain && !own?.[f].step) {
			// No step was read: keep the fallback's grid when the bounds lie on it.
			const s = fb.domain.step;
			if (onGrid(found.min!, s) && onGrid(found.max!, s)) found.step = s;
		}
		out[f] = domain(found, f, notes, where);
	}
	if (own?.types) out.types = sortTypes(own.types);
	else {
		const p = base?.band?.types;
		out.types = p ?? sortTypes(types.filter((t) => !t.startsWith('x-')));
		if (base || types.length) {
			notes.push(`${where} types not listed: from ${p ? base!.id : 'the protocol’s wire codes'}.`);
		}
	}
	return out;
}

/** A domain from findings with both bounds: stepped when both bounds lie on the step's grid. */
function domain(f: FieldFindings, field: string, notes: string[], where = ''): Domain {
	let min = f.min!;
	let max = f.max!;
	if (min > max) [min, max] = [max, min];
	if (f.step === undefined) return { min, max };
	if (onGrid(min, f.step) && onGrid(max, f.step)) return { min, max, step: f.step };
	notes.push(
		`${where ? `${where} ` : ''}${field}: ${min} – ${max} doesn't lie on the ${f.step} step's grid, so no step is given.`
	);
	return { min, max };
}

/** "Band 3", "Bands 2–7", "Bands 2, 4–6". */
function bandList(bands: readonly number[]): string {
	const runs: string[] = [];
	for (let i = 0; i < bands.length;) {
		let j = i;
		while (j + 1 < bands.length && bands[j + 1] === bands[j]! + 1) j++;
		runs.push(i === j ? `${bands[i]}` : `${bands[i]}–${bands[j]}`);
		i = j + 1;
	}
	return `Band${bands.length > 1 ? 's' : ''} ${runs.join(', ')}`;
}

/** PK first, then the order the user listed them in. */
function sortTypes(types: readonly FilterType[]): FilterType[] {
	return [...types].sort((a, b) => Number(b === 'PK') - Number(a === 'PK'));
}
