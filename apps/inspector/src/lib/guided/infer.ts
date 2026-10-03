// Inference from reads only (INSPECTOR §3.3): a bound is the value read at the extreme step; a step
// is the difference of two reads one step apart, cross-checked by the GCD of every value the app
// set for that field; a type is the code read after the user chose it. A typed value the device
// holds as the wire's rounding of it shows the app passes typed values through: the field's step
// is then the wire's, however coarse the app's buttons are.

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

/**
 * What one read entry establishes for its step, or why it doesn't. Values are as the device holds
 * them: `infer` decides what the app sent.
 */
export function conclude(entry: Extract<Entry, { kind: 'read' }>): Outcome {
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
	const at = valueAt(read, field, band);
	if (at === undefined) {
		return { problem: field === 'preamp' ? 'The read has no preamp.' : `Band ${band} is off.` };
	}
	const own = changed.find((c) => c.field === field && c.band === band);
	const where = band === undefined ? {} : { band };
	if (step.ask === 'value') {
		if (entry.typed === undefined) return { problem: 'Enter the value you typed into the app.' };
		return { conclusion: { ...where, field, typed: entry.typed, read: at } };
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
		return { conclusion: { ...where, field, step: d } };
	}
	return { conclusion: { ...where, field, [step.ask]: at } };
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
	/** As the device holds it. */
	read: number;
	ok: boolean;
}

export interface Inference {
	bandCount?: number;
	/** The bands steps asked about, 1-based. */
	bands: Map<number, BandFindings>;
	preamp: FieldFindings;
	checks: GridCheck[];
	/**
	 * Fields whose typed values the app passes to the device as they are (§3.3): their step is the
	 * wire's and their bounds are the values the device holds.
	 */
	passThrough: Set<NumField>;
	/** Whether the last read matched the first; undefined until the restore step. */
	restored?: boolean;
	/** What the reads didn't settle or disagreed on, for the screen and `meta.notes`. */
	notes: string[];
}

const emptyBand = (): BandFindings => ({ gain: {}, freq: {}, q: {} });
const NUM_FIELDS = ['gain', 'freq', 'q', 'preamp'] as const;

/** Everything the entries establish, steps cross-checked against every value the app set. */
export function infer(ctx: GuidedContext, entries: readonly Entry[]): Inference {
	const inf: Inference = {
		bands: new Map(),
		preamp: {},
		checks: [],
		passThrough: new Set(),
		notes: []
	};
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
				const t = e.kind === 'read' ? conclude(e).conclusion?.type : undefined;
				if (t && !types.includes(t)) types.push(t);
			}
			if (done && types.length > 0) band(step.band!).types = types;
			continue;
		}
		const e = list[0]!;
		if (e.kind !== 'read') continue;
		const c = conclude(e).conclusion;
		if (!c) continue;
		if (c.field === 'bands') inf.bandCount = c.bands!;
		else if (c.field === 'restore') inf.restored = c.matchesFirst!;
		else if (c.typed !== undefined && c.read !== undefined) {
			const where = c.band !== undefined ? { band: c.band } : {};
			inf.checks.push({
				...where,
				field: c.field as NumField,
				typed: c.typed,
				read: c.read,
				ok: true
			});
		} else {
			const target =
				c.field === 'preamp' ? inf.preamp : band(c.band!)[c.field as 'gain' | 'freq' | 'q'];
			for (const k of ['min', 'max', 'step'] as const) if (c[k] !== undefined) target[k] = c[k];
		}
	}
	for (const field of NUM_FIELDS) interpret(ctx, entries, inf, field);
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

/** More decimals than an app's own grid would have: 1.111111, not 1.1 or 1.25. */
const decimals = (x: number) => {
	const s = String(x);
	const i = s.indexOf('.');
	return i < 0 || s.includes('e') ? 0 : s.length - i - 1;
};

/**
 * Turns one field's raw findings into the app's values. The step read is cross-checked first:
 * every value the app set must lie on it, or the step read was a multiple of the real one (a
 * slider moved two notches), so it becomes the GCD of the values, or is dropped if none fits.
 * Then a grid check showing the app passes typed values through makes the step the wire's and
 * keeps the bounds as read; otherwise the values are the app's, the wire's rounding undone.
 */
function interpret(ctx: GuidedContext, entries: readonly Entry[], inf: Inference, field: NumField) {
	const wire = ctx.wire[field]?.step;
	const owners = field === 'preamp' ? [inf.preamp] : [...inf.bands.values()].map((b) => b[field]);
	const asked = field === 'preamp' ? inf.preamp : inf.bands.get(1)?.[field];
	const read = asked?.step === undefined ? undefined : appValue(asked.step, wire, wire);
	const { step: appStep, note } = crossCheck(entries, field, wire, read);

	const checks = inf.checks.filter((c) => c.field === field);
	const held = (c: GridCheck) =>
		wire ? Math.abs(c.read - c.typed) <= wire / 2 + 1e-9 : near(c.read, c.typed);
	const offAppGrid = (c: GridCheck) =>
		appStep !== undefined ? !onGrid(c.typed, appStep) : decimals(c.typed) > 3;
	// When the app's step is the wire's, passing through and rounding look (and work) the same.
	const finer = wire === undefined || appStep === undefined || appStep > wire * 1.5;
	const through = finer ? checks.find((c) => held(c) && offAppGrid(c)) : undefined;
	if (through) {
		inf.passThrough.add(field);
		for (const o of owners) {
			if (wire === undefined) delete o.step;
			else o.step = wire;
		}
		for (const c of checks) c.ok = held(c);
		const app = appStep === undefined ? '' : `, finer than the app's ${appStep} buttons`;
		inf.notes.push(
			`${cap(LABEL[field])}: the app passes typed values through (typed ${through.typed}, the device holds ${through.read}), so the step is ${wire === undefined ? 'not limited' : `the wire's ${wire}`}${app}.`
		);
		return;
	}

	for (const o of owners) {
		if (o.min !== undefined) o.min = appValue(o.min, wire);
		if (o.max !== undefined) o.max = appValue(o.max, wire);
	}
	if (asked) {
		if (appStep === undefined) delete asked.step;
		else asked.step = appStep;
	}
	if (note) inf.notes.push(note);
	for (const c of checks) {
		// On the app's grid, or rounded by the app onto it: both agree with the step.
		const rounded = appStep === undefined ? c.typed : Math.round(c.typed / appStep) * appStep;
		c.ok = held(c) || held({ ...c, typed: rounded });
	}
}

/** The step read, checked against every value the app set during the steps (not defaults). */
function crossCheck(
	entries: readonly Entry[],
	field: NumField,
	wire: number | undefined,
	step: number | undefined
): { step?: number; note?: string } {
	if (step === undefined) return {};
	const values = new Set<number>([step]);
	for (const e of entries) {
		if (e.kind !== 'read' || e.step.ask === 'value' || e.step.ask === 'restore') continue;
		for (const ch of e.changed) {
			if (ch.field === field && typeof ch.to === 'number') values.add(appValue(ch.to, wire));
		}
	}
	const off = [...values].filter((v) => !onGrid(v, step));
	if (off.length === 0) return { step };
	const g = gcdOf([...values]);
	const name = cap(LABEL[field]);
	if (g >= Math.max(wire ?? 0, 1e-3) && [...values].every((v) => onGrid(v, g))) {
		return {
			step: g,
			note: `${name} step: one step read as ${step}, but ${off[0]} was set too, so the step is ${g}.`
		};
	}
	return {
		note: `${name} step: ${step} was read, but ${off[0]} isn't on that grid, so no step is given.`
	};
}

/** GCD of numbers with up to 6 decimals, computed on integers so 0.3 and 0.1 give 0.1. */
export function gcdOf(values: readonly number[]): number {
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
