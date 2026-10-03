// Merged slots of a profile, shaped for the per-slot chart (INSPECTOR §2 T0).

import {
	mergeSlotFields,
	slotOverrides,
	type Domain,
	type FilterType,
	type Profile,
	type Variant,
	type When
} from '@potatosalad775/eqcaps-core';
import { formatHz, formatNumber } from './format.ts';

export interface SlotRow {
	/** Slot index; null for an unbounded profile's template, which every band uses. */
	index: number | null;
	label?: string;
	types: FilterType[];
	freq: Domain;
	q: Domain;
	gain: Domain;
	variants: Variant[];
}

/** One row per slot (SPEC §5.2), or the template alone when bandCount is null. */
export function slotRows(profile: Profile): SlotRow[] {
	const overrides = slotOverrides(profile);
	const count = profile.bandCount ?? 1;
	const rows: SlotRow[] = [];
	for (let i = 0; i < count; i++) {
		const m = mergeSlotFields(profile.band, overrides.get(i)?.entry);
		if (!m.types || !m.freq || !m.q || !m.gain) continue; // invalid profile; validation says why
		rows.push({
			index: profile.bandCount === null ? null : i,
			...(m.label !== undefined && { label: m.label }),
			types: m.types,
			freq: m.freq,
			q: m.q,
			gain: m.gain,
			variants: m.variants ?? []
		});
	}
	return rows;
}

/** The values a domain spans: [min, max]. */
export function span(d: Domain): [number, number] {
	if ('value' in d) return [d.value, d.value];
	if ('values' in d) return [d.values[0] as number, d.values[d.values.length - 1] as number];
	return [d.min, d.max];
}

/** Grid points of a stepped domain, when there are few enough to draw; else null. */
export function gridPoints(d: Domain, limit = 48): number[] | null {
	if ('values' in d) return d.values.length <= limit * 4 ? d.values : null;
	if (!('step' in d)) return null;
	const first = Math.ceil(d.min / d.step - 1e-9);
	const last = Math.floor(d.max / d.step + 1e-9);
	if (last - first + 1 > limit) return null;
	const out: number[] = [];
	for (let k = first; k <= last; k++) out.push(Number((k * d.step).toPrecision(12)));
	return out;
}

/** A logarithmic frequency axis covering every slot's window, variants included. */
export interface FreqAxis {
	min: number;
	max: number;
	ticks: number[];
	/** 0..1 */
	x(f: number): number;
}

const TICKS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];

export function freqAxis(rows: readonly SlotRow[]): FreqAxis {
	let lo = 20;
	let hi = 20000;
	for (const r of rows) {
		for (const d of [r.freq, ...r.variants.flatMap((v) => (v.freq ? [v.freq] : []))]) {
			const [a, b] = span(d);
			if (a > 0) lo = Math.min(lo, a);
			hi = Math.max(hi, b);
		}
	}
	const min = lo / 1.25;
	const max = hi * 1.25;
	const span_ = Math.log(max / min);
	return {
		min,
		max,
		ticks: TICKS.filter((t) => t >= min && t <= max),
		x: (f: number) => Math.min(1, Math.max(0, Math.log(Math.max(f, min) / min) / span_))
	};
}

const OPS = { eq: '=', gt: '>', gte: '≥', lt: '<', lte: '≤' } as const;

/** "gain > 0", "type is LSC", "freq ≥ 1 kHz and gain < 0". */
export function whenLabel(w: When): string {
	const parts: string[] = [];
	if (w.type?.eq) parts.push(`type ${w.type.eq}`);
	if (w.type?.in) parts.push(`type ${w.type.in.join('/')}`);
	for (const f of ['freq', 'q', 'gain'] as const) {
		const c = w[f];
		if (!c) continue;
		for (const [op, sym] of Object.entries(OPS)) {
			const x = c[op as keyof typeof OPS];
			if (x === undefined) continue;
			const shown = f === 'freq' ? formatHz(x) : f === 'gain' ? `${formatNumber(x)} dB` : x;
			parts.push(`${f} ${sym} ${shown}`);
		}
	}
	return parts.join(' and ');
}
