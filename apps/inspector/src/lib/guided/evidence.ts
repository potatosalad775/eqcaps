// A guided read's evidence file (INSPECTOR §6, DECISIONS D41): the T2 file of the first read, plus
// the vendor app, one experiment per step with its full read-back, and the constraints found.

import type { EvidenceReport, GuidedExperiment } from '../evidence.ts';
import type { Derived } from './constraints.ts';
import { conclude, type Inference } from './infer.ts';
import { instruction } from './plan.ts';
import type { Entry, GuidedContext } from './types.ts';

export const GUIDED_CAVEATS = [
	'Guided read: the user set every value in the vendor app, and the inspector only read the device back. The limits found are the vendor app’s, which may be narrower than what the firmware accepts.',
	'Each conclusion relies on the user setting what its step asked; its read-back and changes show what the device held.',
	'Read-back shows the values the device was told, not how they sound.'
];

export function guidedEvidence(input: {
	/** The evidence of the first read (`readEvidence`), which the guided read extends. */
	first: EvidenceReport;
	vendorApp: NonNullable<EvidenceReport['vendorApp']>;
	ctx: GuidedContext;
	entries: readonly Entry[];
	inference: Inference;
	derived: Derived;
}): EvidenceReport {
	const { first, vendorApp, ctx, entries, inference, derived } = input;
	const experiments: GuidedExperiment[] = entries.map((e) => {
		const s = e.step;
		if (e.kind === 'skip') return { id: s.id, skipped: true };
		if (e.kind === 'done') return { id: s.id, done: true };
		const outcome = conclude(e, ctx);
		const readBack: NonNullable<GuidedExperiment['readBack']> = { filters: [...e.read.filters] };
		if (e.read.preamp !== undefined) readBack.preamp = e.read.preamp;
		if (e.read.slot !== undefined) readBack.slot = e.read.slot;
		return {
			id: s.id,
			instruction: instruction(s),
			...(s.band !== undefined ? { band: s.band } : {}),
			field: s.field,
			ask: s.ask,
			...(e.typed !== undefined ? { typed: e.typed } : {}),
			...(e.already ? { already: true as const } : {}),
			readBack,
			changed: e.changed,
			...(outcome.conclusion ? { conclusion: outcome.conclusion } : {}),
			...(outcome.problem ? { problem: outcome.problem } : {})
		};
	});
	const notes = [...inference.notes, ...derived.notes];
	const { experiments: read, caveats: _, ...head } = first;
	return {
		...head,
		vendorApp,
		experiments: [...read, ...experiments],
		constraints: derived.constraints,
		...(notes.length ? { notes } : {}),
		notChecked: derived.notChecked,
		caveats: [...GUIDED_CAVEATS]
	};
}
