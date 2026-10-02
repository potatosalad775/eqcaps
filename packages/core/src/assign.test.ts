import { describe, expect, it } from 'vitest';
import { example, pk, profile } from '../test/fixtures.ts';
import { assign } from './assign.ts';

describe('assign (SPEC §13.5)', () => {
	it('fills type-partitioned slots by type (SPEC §12 B)', () => {
		const jds = example('b-jds-labs-element-iv');
		const filters = [
			pk(1000, 3),
			{ type: 'HSC' as const, freq: 8000, q: 0.7, gain: 2 },
			pk(2000, -1),
			{ type: 'LSC' as const, freq: 100, q: 0.7, gain: 4 },
			pk(500, 0)
		];
		const r = assign(jds, filters);
		expect(r.slotOf).toEqual([2, 10, 3, 0, null]);
		expect(r.unassigned).toEqual([]);
		expect(r.slots).toHaveLength(12);
	});

	it('fills frequency-partitioned slots by frequency (SPEC §12 C)', () => {
		const c = example('c-partitioned-windows');
		const r = assign(c, [
			pk(5000, 1),
			pk(2000, 1),
			pk(500, 1),
			{ type: 'LSC', freq: 100, q: 1, gain: 1 }
		]);
		expect(r.slotOf).toEqual([3, 2, 1, 0]);
	});

	it('keeps list order on a homogeneous engine, frequency order under ascendingFrequency', () => {
		const filters = [pk(1000, 1), pk(100, 1), pk(500, 1)];
		expect(assign(profile(), filters).slotOf).toEqual([0, 1, 2]);
		const asc = profile({ rules: [{ type: 'ascendingFrequency' }] });
		expect(assign(asc, filters).slotOf).toEqual([2, 0, 1]);
	});

	it('leaves out the least significant filters when there are too many', () => {
		const filters = [pk(100, 3), pk(200, 0.5), pk(400, -6), pk(800, 2), pk(1600, 1)];
		const r = assign(profile(), filters);
		expect(r.slotOf).toEqual([0, null, 1, 2, 3]);
		expect(r.unassigned).toEqual([pk(200, 0.5)]);
	});

	it('finds the valid assignment where the first fit would block it', () => {
		// Slot 0 takes 20 Hz – 20 kHz, slot 1 only 1–2 kHz. Filling in list order puts 1.5 kHz in
		// slot 0 and leaves 8 kHz nowhere to go.
		const p = profile({
			bandCount: 2,
			bands: [{ index: 1, freq: { min: 1000, max: 2000 } }]
		});
		expect(assign(p, [pk(1500, 1), pk(8000, 1)]).slotOf).toEqual([1, 0]);
	});

	it('serves an unbounded engine one slot per active filter', () => {
		const r = assign(example('g-equalizer-apo'), [pk(100, 1), pk(200, 0), pk(300, 1)]);
		expect(r.slots).toEqual([pk(100, 1), pk(300, 1)]);
		expect(r.slotOf).toEqual([0, null, 1]);
	});
});
