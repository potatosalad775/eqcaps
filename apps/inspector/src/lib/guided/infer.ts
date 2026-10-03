// Inference from reads only (INSPECTOR §3.3): a bound is the value read at the extreme step; a step
// is the difference of two reads one step apart, cross-checked by the GCD of every value read for
// that field; a type is the code read after the user chose it.

import { near, onGrid, type FilterType } from '@potatosalad775/eqcaps-core';
import { changeText, valueAt } from './changes.ts';
import type { Conclusion, Entry, GuidedContext, NumField, Step } from './types.ts';

export const LABEL: Record<NumField, string> = {
	gain: 'gain',
	freq: 'frequency',
	q: 'Q',
	preamp: 'preamp'
};

/**
 * The value the app most likely sent, from the value the device holds: the shortest decimal (up
 * to 3 places) within `tolerance` of it, else the value itself. A wire with 1/256 dB steps holds
 * 0.1015625 for the app's 0.1. Without a wire step the value is taken as it is.
 */
export function appValue(x: number, wireStep?: number, tolerance = (wireStep ?? 0) / 2): number {
	if (!wireStep) return x;
	for (let digits = 0; digits <= 3; digits++) {
		const r = Number(x.toFixed(digits));
		if (Math.abs(r - x) <= tolerance + 1e-9) return r;
	}
	return x;
}

export interface Outcome {
	conclusion?: Conclusion;
	/** Why the read didn't settle the step: shown to the user, who reads again or skips. */
	problem?: string;
}

const whose = (step: Step) =>
	step.field === 'preamp' ? 'the preamp' : `band ${step.band}'s ${LABEL[step.field as NumField]}`;

/** What one read entry establishes for its step, or why it doesn't. */
export function conclude(entry: Extract<Entry, { kind: 'read' }>, ctx: GuidedContext): Outcome {
	const { step, read, changed } = entry;
	const band = step.band;
	switch (step.ask) {
		case 'count': {
			const n = entry.typed;
			if (n === undefined || !Number.isInteger(n) || n < 1) {
				return { problem: 'Enter the number of bands the vendor app shows.' };
			}
			if (read.filters.length < n) {
				return { problem: `The device returned ${read.filters.length} bands, not ${n}.` };
			}
			return { conclusion: { field: 'bands', bands: n } };
		}
		case 'restore':
			return { conclusion: { field: 'restore', matchesFirst: changed.length === 0 } };
		case 'each': {
			const f = band === undefined ? undefined : read.filters[band - 1];
			if (!f || band === undefined) return { problem: `Band ${band} is off.` };
			return { conclusion: { band, field: 'type', type: f.type } };
		}
	}
	const field = step.field as NumField;
	const wire = ctx.wire[field]?.step;
	const at = valueAt(read, field, band);
	if (at === undefined) {
		return { problem: field === 'preamp' ? 'The read has no preamp.' : `Band ${band} is off.` };
	}
	const own = changed.find((c) => c.field === field && c.band === band);
	const where = band === undefined ? {} : { band };
	if (step.ask === 'value') {
		if (entry.typed === undefined) return { problem: 'Enter the value you typed into the app.' };
		return { conclusion: { ...where, field, typed: entry.typed, read: appValue(at, wire) } };
	}
	if (!own && !(entry.already && step.ask !== 'step')) {
		if (changed.length === 0) {
			return {
				problem:
					'Nothing changed since the last read. Change it in the vendor app (and save there, if the app has a save button), then read again.'
			};
		}
		return {
			problem: `Changed: ${changed.map(changeText).join(', ')}. This step asks for ${whose(step)}.`
		};
	}
	if (step.ask === 'step') {
		const d = Math.abs((own!.to as number) - (own!.from as number));
		return { conclusion: { ...where, field, step: appValue(d, wire, wire) } };
	}
	return { conclusion: { ...where, field, [step.ask]: appValue(at, wire) } };
}

/** The entries that count for each step id: the last one, or every read of an `each` step. */
export function effective(entries: readonly Entry[]): Map<string, Entry[]> {
	const out = new Map<string, Entry[]>();
	for (const e of entries) {
		const list = out.get(e.step.id) ?? [];
		if (e.step.ask === 'each' && e.kind !== 'skip') {
			out.set(e.step.id, [...list, e]);
		} else {
			out.set(e.step.id, [e]);
		}
	}
	return out;
}

export interface FieldFindings {
	min?: number;
	max?: number;
	step?: number;
}

export interface BandFindings {
	gain: FieldFindings;
	freq: FieldFindings;
	q: FieldFindings;
	/** Every type read, in the order read; set once the user said there were no more. */
	types?: FilterType[];
}

export interface GridCheck {
	band?: number;
	field: NumField;
	typed: number;
	read: number;
	ok: boolean;
}

export interface Inference {
	bandCount?: number;
	/** The bands steps asked about, 1-based. */
	bands: Map<number, BandFindings>;
	preamp: FieldFindings;
	checks: GridCheck[];
	/** Whether the last read matched the first; undefined until the restore step. */
	restored?: boolean;
	/** What the reads didn't settle or disagreed on, for the screen and `meta.notes`. */
	notes: string[];
}

const emptyBand = (): BandFindings => ({ gain: {}, freq: {}, q: {} });

/** Everything the entries establish, steps cross-checked against every value read. */
export function infer(ctx: GuidedContext, entries: readonly Entry[]): Inference {
	const inf: Inference = { bands: new Map(), preamp: {}, checks: [], notes: [] };
	const band = (b: number) => {
		let f = inf.bands.get(b);
		if (!f) inf.bands.set(b, (f = emptyBand()));
		return f;
	};
	for (const list of effective(entries).values()) {
		const step = list[list.length - 1]!.step;
		if (step.ask === 'each') {
			const done = list.some((e) => e.kind === 'done');
			const types: FilterType[] = [];
			for (const e of list) {
				const t = e.kind === 'read' ? conclude(e, ctx).conclusion?.type : undefined;
				if (t && !types.includes(t)) types.push(t);
			}
			if (done && types.length > 0) band(step.band!).types = types;
			continue;
		}
		const e = list[0]!;
		if (e.kind !== 'read') continue;
		const c = conclude(e, ctx).conclusion;
		if (!c) continue;
		if (c.field === 'bands') inf.bandCount = c.bands!;
		else if (c.field === 'restore') inf.restored = c.matchesFirst!;
		else if (c.typed !== undefined && c.read !== undefined) {
			const field = c.field as NumField;
			const tol = (ctx.wire[field]?.step ?? 0) / 2;
			const ok = Math.abs(c.read - c.typed) <= tol + 1e-9 || near(c.read, c.typed);
			inf.checks.push({
				...(c.band !== undefined ? { band: c.band } : {}),
				field,
				typed: c.typed,
				read: c.read,
				ok
			});
		} else {
			const target =
				c.field === 'preamp' ? inf.preamp : band(c.band!)[c.field as 'gain' | 'freq' | 'q'];
			for (const k of ['min', 'max', 'step'] as const) if (c[k] !== undefined) target[k] = c[k];
		}
	}
	crossCheckSteps(ctx, entries, inf);
	for (const c of inf.checks) {
		if (!c.ok) {
			inf.notes.push(
				`Typed ${c.typed} into the app's ${c.band === undefined ? '' : `band ${c.band} `}${LABEL[c.field]}; the device holds ${c.read}.`
			);
		}
	}
	if (inf.restored === false) {
		inf.notes.push('The EQ at the end differs from the EQ at the start.');
	}
	return inf;
}

/**
 * Every value read for a field must lie on the step found for it (asked on band 1, or the
 * preamp). A value that doesn't means the step read was a multiple of the real one (a slider
 * moved two notches), so the step becomes the GCD of the values, or is dropped if none fits.
 */
function crossCheckSteps(ctx: GuidedContext, entries: readonly Entry[], inf: Inference) {
	const reads = [ctx.first, ...entries.flatMap((e) => (e.kind === 'read' ? [e.read] : []))];
	for (const field of ['gain', 'freq', 'q', 'preamp'] as const) {
		const owner = field === 'preamp' ? inf.preamp : inf.bands.get(1)?.[field];
		const step = owner?.step;
		if (!owner || step === undefined) continue;
		const wire = ctx.wire[field]?.step;
		const values = new Set<number>();
		for (const r of reads) {
			if (field === 'preamp') {
				if (r.preamp !== undefined) values.add(appValue(r.preamp, wire));
			} else {
				for (const f of r.filters) if (f) values.add(appValue(f[field], wire));
			}
		}
		const off = [...values].filter((v) => !onGrid(v, step));
		if (off.length === 0) continue;
		const g = gcdOf([step, ...values]);
		const floor = Math.max(wire ?? 0, 1e-3);
		if (g >= floor && [...values].every((v) => onGrid(v, g))) {
			owner.step = g;
			inf.notes.push(
				`${cap(LABEL[field])} step: one step read as ${step}, but ${off[0]} was read too, so the step is ${g}.`
			);
		} else {
			delete owner.step;
			inf.notes.push(
				`${cap(LABEL[field])} step: ${step} was read, but ${off[0]} isn't on that grid, so no step is given.`
			);
		}
	}
}

/** GCD of numbers with up to 6 decimals, computed on integers so 0.3 and 0.1 give 0.1. */
export function gcdOf(values: readonly number[]): number {
	const decimals = (x: number) => {
		const s = String(x);
		const i = s.indexOf('.');
		return i < 0 || s.includes('e') ? 0 : s.length - i - 1;
	};
	const scale = 10 ** Math.min(6, Math.max(0, ...values.map(decimals)));
	let g = 0;
	for (const v of values) {
		let a = g;
		let b = Math.round(Math.abs(v) * scale);
		while (b) [a, b] = [b, a % b];
		g = a;
	}
	return g / scale;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
