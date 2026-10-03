// Whether two profiles accept the same filters, slot by slot (PLAN Phase 5 exit: derived profiles
// match the hand-authored ones, or the difference is explained). Representation doesn't matter:
// `{ value: 5 }`, `{ values: [5] }` and `{ min: 5, max: 5 }` are the same domain.

import {
	describeDomain,
	mergeSlotFields,
	near,
	slotOverrides,
	type Domain,
	type Profile,
	type Rule,
	type SlotFields
} from '@potatosalad775/eqcaps-core';

/** The constraint part of a profile: what `constraintDiff` compares. */
export type Constraints = Pick<Profile, 'bandCount' | 'band' | 'bands' | 'rules' | 'preamp'>;

type Canon = { values: number[] } | { min: number; max: number; step?: number };

function canon(d: Domain): Canon {
	if ('value' in d) return { values: [d.value] };
	if ('values' in d) return { values: [...d.values].sort((a, b) => a - b) };
	if (near(d.min, d.max)) return { values: [d.min] };
	return 'step' in d ? { min: d.min, max: d.max, step: d.step } : { min: d.min, max: d.max };
}

const nearOrBoth = (a: number | undefined, b: number | undefined) =>
	a === undefined || b === undefined ? a === b : near(a, b);

export function sameDomain(a: Domain, b: Domain): boolean {
	const x = canon(a);
	const y = canon(b);
	if ('values' in x || 'values' in y) {
		return (
			'values' in x &&
			'values' in y &&
			x.values.length === y.values.length &&
			x.values.every((v, i) => near(v, y.values[i]!))
		);
	}
	return near(x.min, y.min) && near(x.max, y.max) && nearOrBoth(x.step, y.step);
}

function slotOf(c: Constraints, i: number): SlotFields {
	return mergeSlotFields(c.band, slotOverrides(c).get(i)?.entry);
}

function rulesText(rules: readonly Rule[] | undefined): string {
	return JSON.stringify(
		[...(rules ?? [])]
			.map((r) =>
				r.type === 'ascendingFrequency' ? { type: r.type, strict: r.strict !== false } : r
			)
			.sort((a, b) => a.type.localeCompare(b.type))
	);
}

/**
 * Where `b` accepts different filters from `a`, as sentences ("band 3: gain −12 to 12 dB in 0.1 dB
 * steps, not −15 to 15 dB…"). Empty when they accept the same.
 */
export function constraintDiff(a: Constraints, b: Constraints): string[] {
	const out: string[] = [];
	if (a.bandCount !== b.bandCount) out.push(`band count: ${b.bandCount}, not ${a.bandCount}`);
	const n = Math.min(a.bandCount ?? 1, b.bandCount ?? 1);
	for (let i = 0; i < n; i++) {
		const x = slotOf(a, i);
		const y = slotOf(b, i);
		const where = `band ${i + 1}`;
		const tx = [...(x.types ?? [])].sort().join(', ');
		const ty = [...(y.types ?? [])].sort().join(', ');
		if (tx !== ty) out.push(`${where}: types ${ty}, not ${tx}`);
		for (const field of ['freq', 'q', 'gain'] as const) {
			const dx = x[field];
			const dy = y[field];
			if (!dx || !dy) continue;
			if (!sameDomain(dx, dy)) {
				out.push(
					`${where}: ${field} ${describeDomain(dy, field)}, not ${describeDomain(dx, field)}`
				);
			}
		}
		const vx = x.variants ?? [];
		const vy = y.variants ?? [];
		const variantKey = (v: SlotFields['variants']) =>
			JSON.stringify(
				(v ?? []).map((w) => ({
					when: w.when,
					...Object.fromEntries(
						(['freq', 'q', 'gain'] as const).filter((f) => w[f]).map((f) => [f, canon(w[f]!)])
					)
				}))
			);
		if (variantKey(vx) !== variantKey(vy)) {
			out.push(`${where}: conditional domains differ (${vy.length} against ${vx.length})`);
		}
	}
	if (rulesText(a.rules) !== rulesText(b.rules)) {
		out.push(`rules: ${rulesText(b.rules)}, not ${rulesText(a.rules)}`);
	}
	const px = a.preamp;
	const py = b.preamp;
	if (px.mode !== py.mode) out.push(`preamp: ${py.mode}, not ${px.mode}`);
	else if (px.mode === 'manual' && py.mode === 'manual' && !sameDomain(px.gain, py.gain)) {
		out.push(
			`preamp: ${describeDomain(py.gain, 'preamp')}, not ${describeDomain(px.gain, 'preamp')}`
		);
	}
	return out;
}
