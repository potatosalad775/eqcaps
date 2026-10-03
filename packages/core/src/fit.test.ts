import { describe, expect, it } from 'vitest';
import { present } from '../test/checks.ts';
import { example, pk, profile } from '../test/fixtures.ts';
import { fit } from './fit.ts';

describe('fit (SPEC §13.6)', () => {
	it('returns valid input unchanged', () => {
		const jds = example('b-jds-labs-element-iv');
		const filters = [pk(1000, 3, 2), { type: 'LSC' as const, freq: 105, q: 0.7, gain: 4 }];
		const r = fit(jds, filters);
		expect(r.feasible).toBe(true);
		expect(r.changes).toEqual([]);
		expect(r.slots[0]).toEqual(filters[1]);
		expect(r.slots[2]).toEqual(filters[0]);
	});

	it('projects each field and reports what changed', () => {
		const r = fit(profile(), [pk(30000, 15, 0.123)]);
		expect(r.slots[0]).toEqual(pk(20000, 12, 0.12));
		expect(r.changes).toEqual([
			{ filter: 0, slot: 0, field: 'freq', wanted: 30000, written: 20000 },
			{ filter: 0, slot: 0, field: 'q', wanted: 0.123, written: 0.12 },
			{ filter: 0, slot: 0, field: 'gain', wanted: 15, written: 12 }
		]);
		expect(r.feasible).toBe(true);
	});

	it('projects the preamp', () => {
		const manual = profile({ preamp: { mode: 'manual', gain: { min: -12, max: 0, step: 0.1 } } });
		expect(fit(manual, [], 3)).toMatchObject({
			preamp: 0,
			changes: [{ field: 'preamp', wanted: 3, written: 0 }]
		});
		expect(fit(profile(), [], -4).preamp).toBe(0); // mode none
		expect(fit(example('d-gain-dependent-window'), [], -4).preamp).toBe(-4); // mode auto
	});

	it('moves filters apart for minSpacing', () => {
		const p = profile({ rules: [{ type: 'minSpacing', octaves: 1 }] });
		const r = fit(p, [pk(100, 3), pk(150, 2)]);
		expect(r.slots.map((s) => s?.freq ?? null)).toEqual([100, 200, null, null]);
		expect(r.changes).toEqual([{ filter: 1, slot: 1, field: 'freq', wanted: 150, written: 200 }]);
		expect(r.feasible).toBe(true);
	});

	it('spreads a cluster for minSpacing in one pass, so the result is a fixpoint', () => {
		// A filter left below one that just moved is still too close to the one before.
		const p = profile({ bandCount: 8, rules: [{ type: 'minSpacing', octaves: 1 }] });
		const cluster = Array.from({ length: 8 }, () => pk(20, 1));
		const r = fit(p, cluster);
		expect(r.slots.map((s) => s?.freq)).toEqual([20, 40, 80, 160, 320, 640, 1280, 2560]);
		expect(r.feasible).toBe(true);
		const again = fit(p, present(r.slots));
		expect(again.slots).toEqual(r.slots);
	});

	it('marks a minSpacing it cannot fix as infeasible and leaves the filter', () => {
		const p = profile({
			band: { freq: { min: 20, max: 160 } },
			rules: [{ type: 'minSpacing', octaves: 1 }]
		});
		const r = fit(p, [pk(100, 3), pk(150, 2)]);
		expect(r.slots[1]?.freq).toBe(150);
		expect(r.feasible).toBe(false);
	});

	it('settles a cycle of passes on the result closest to the wanted filters', () => {
		// ascendingFrequency can't hold: slot 0 is 1000–4000 Hz, slots 2 and 3 sit at 100 and
		// 250 Hz. Each frequency-ordered pass shifts the filters one slot along that chain.
		const p = profile({
			bandCount: 6,
			band: { freq: { min: 1000, max: 4000 }, q: { values: [4] }, gain: { min: 1, max: 6 } },
			bands: [
				{ index: 0, gain: { min: -6, max: 6, step: 0.1 } },
				{ index: 2, freq: { value: 100 } },
				{ index: 3, freq: { values: [250] }, gain: { min: -6, max: 6, step: 0.1 } }
			],
			rules: [{ type: 'ascendingFrequency' }]
		});
		const r = fit(p, [
			pk(1000, 0.1, 4),
			pk(1000, 1, 4),
			pk(100, 1, 4),
			pk(4000, 1, 4),
			pk(250, 1.1, 4)
		]);
		expect(r.slots.map((s) => s && [s.freq, s.gain])).toEqual([
			[1000, 1],
			null,
			[100, 1],
			[250, 1.1],
			[1000, 1],
			[4000, 1]
		]);
		expect(r.feasible).toBe(false);
		const again = fit(p, present(r.slots));
		expect(again.slots).toEqual(r.slots);
	});

	it('orders a partitioned engine by frequency (SPEC §12 C)', () => {
		const c = example('c-partitioned-windows');
		const r = fit(c, [pk(5000, 1), pk(2000, 1), pk(500, 1), pk(100, 1)]);
		expect(r.slots.map((s) => s?.freq)).toEqual([100, 500, 2000, 5000]);
		expect(r.feasible).toBe(true);
	});

	it('never adds filters, and lists the ones left out', () => {
		const filters = [pk(100, 3), pk(200, 0.5), pk(400, -6), pk(800, 2), pk(1600, 1), pk(3200, 0)];
		const r = fit(profile(), filters);
		expect(r.unassigned).toEqual([pk(200, 0.5)]);
		expect(r.slots.filter(Boolean)).toHaveLength(4);
	});
});
