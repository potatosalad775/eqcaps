// The step planner (INSPECTOR §3.2): each step names one band and one field, chosen from what is
// still unknown. The first band always; the last band too; the bands between only for a field
// where the first and last disagree. Then the preamp, the grid checks and "put your EQ back".

import { conclude, effective, infer, LABEL, type BandFindings, type Inference } from './infer.ts';
import type { Entry, GuidedContext, NumField, Step, StepAsk, StepField } from './types.ts';

export function step(field: StepField, ask: StepAsk, band?: number): Step {
	const id =
		field === 'bands' || field === 'restore'
			? field
			: `${field}-${ask}${band === undefined ? '' : `-${band}`}`;
	return { id, field, ask, ...(band === undefined ? {} : { band }) };
}

/** Where a step stands: not answered yet, answered, or skipped by the user. */
export type StepState = 'open' | 'done' | 'skipped';

export function stepState(s: Step, entries: readonly Entry[], ctx: GuidedContext): StepState {
	const list = effective(entries).get(s.id);
	const last = list?.[list.length - 1];
	if (!last) return 'open';
	if (last.kind === 'skip') return 'skipped';
	if (last.kind === 'done') return 'done';
	if (s.ask === 'each') return 'open';
	return conclude(last, ctx).conclusion ? 'done' : 'open';
}

/** The numeric fields a band step asks about: Q only when the protocol carries one. */
const bandFields = (ctx: GuidedContext): ('gain' | 'freq' | 'q')[] =>
	ctx.hasQ ? ['gain', 'freq', 'q'] : ['gain', 'freq'];

function boundSteps(ctx: GuidedContext, band: number, withSteps: boolean): Step[] {
	const out: Step[] = [];
	for (const f of bandFields(ctx)) {
		const [lo, hi] = f === 'gain' ? (['max', 'min'] as const) : (['min', 'max'] as const);
		out.push(step(f, lo, band), step(f, hi, band));
		if (withSteps) out.push(step(f, 'step', band));
	}
	out.push(step('type', 'each', band));
	return out;
}

/** The fields where two bands' findings differ: a bound or the list of types. */
export function disagreements(a: BandFindings | undefined, b: BandFindings | undefined) {
	const out: ('gain' | 'freq' | 'q' | 'type')[] = [];
	if (!a || !b) return out;
	for (const f of ['gain', 'freq', 'q'] as const) {
		if (a[f].min !== b[f].min || a[f].max !== b[f].max) out.push(f);
	}
	if (a.types && b.types && [...a.types].sort().join() !== [...b.types].sort().join()) {
		out.push('type');
	}
	return out;
}

/**
 * Every step of this guided read, in order, as far as it can be planned from what's known: only
 * the band count before it's known, the bands between the first and last once they disagree.
 */
export function plannedSteps(ctx: GuidedContext, entries: readonly Entry[]): Step[] {
	const inf: Inference = infer(ctx, entries);
	const steps: Step[] = [step('bands', 'count')];
	const n = inf.bandCount;
	if (n === undefined) return steps;
	steps.push(...boundSteps(ctx, 1, true));
	if (n > 1) {
		const lastSteps = boundSteps(ctx, n, false);
		steps.push(...lastSteps);
		const firstSettled = boundSteps(ctx, 1, false).every(
			(s) => stepState(s, entries, ctx) !== 'open'
		);
		const lastSettled = lastSteps.every((s) => stepState(s, entries, ctx) !== 'open');
		if (firstSettled && lastSettled) {
			const differ = disagreements(inf.bands.get(1), inf.bands.get(n));
			for (let b = 2; b < n; b++) {
				for (const f of differ) {
					if (f === 'type') steps.push(step('type', 'each', b));
					else if (f === 'gain') steps.push(step(f, 'max', b), step(f, 'min', b));
					else steps.push(step(f, 'min', b), step(f, 'max', b));
				}
			}
		}
	}
	if (ctx.readsPreamp) {
		steps.push(step('preamp', 'max'), step('preamp', 'min'), step('preamp', 'step'));
	}
	for (const f of bandFields(ctx)) steps.push(step(f, 'value', 1));
	steps.push(step('restore', 'restore'));
	return steps;
}

/** The first step not yet answered or skipped, or undefined when the guided read is complete. */
export function nextStep(ctx: GuidedContext, entries: readonly Entry[]): Step | undefined {
	return plannedSteps(ctx, entries).find((s) => stepState(s, entries, ctx) === 'open');
}

/** What the page tells the user to do for a step. */
export function instruction(s: Step): string {
	const where = (f: NumField) => (f === 'preamp' ? 'the preamp' : `band ${s.band}'s ${LABEL[f]}`);
	switch (s.ask) {
		case 'count':
			return 'Count the bands the vendor app shows, and enter the number.';
		case 'restore':
			return 'Put your EQ back in the vendor app as it was before the first step. The read is compared with the first one.';
		case 'each':
			return `In the vendor app, set band ${s.band} to a filter type not listed yet, then read. When every type the app offers is listed, choose Done.`;
		case 'max':
			return `In the vendor app, set ${where(s.field as NumField)} as high as it goes.`;
		case 'min':
			return `In the vendor app, set ${where(s.field as NumField)} as low as it goes.`;
		case 'step':
			return `In the vendor app, change ${where(s.field as NumField)} by the smallest step it allows: one click of its arrow, or one notch.`;
		case 'value':
			return `If the vendor app lets you type values: type one into ${where(s.field as NumField)}, with as many decimals as the app takes, and enter the same number here. Skip this if the app only has sliders.`;
	}
}

/** A step's name in the list of steps: "Band 1 gain: highest", "Preamp: one step", "Types". */
export function stepLabel(s: Step): string {
	if (s.ask === 'count') return 'Number of bands';
	if (s.ask === 'restore') return 'Put your EQ back';
	const where = s.band === undefined ? '' : `Band ${s.band} `;
	if (s.ask === 'each') return `${where}types`;
	const what = { max: 'highest', min: 'lowest', step: 'one step', value: 'a typed value' }[s.ask];
	const field = LABEL[s.field as NumField];
	return `${where}${where ? field : field.charAt(0).toUpperCase() + field.slice(1)}: ${what}`;
}
