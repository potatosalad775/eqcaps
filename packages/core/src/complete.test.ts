import { describe, expect, it } from 'vitest';
import { example, pk, profile } from '../test/fixtures.ts';
import { complete } from './complete.ts';

describe('complete (SPEC §13.7)', () => {
	it('fills empty slots with neutral filters at the log centre of their domain', () => {
		const r = complete(profile(), [pk(1000, 3), null]);
		expect(r.warnings).toEqual([]);
		expect(r.filters).toHaveLength(4);
		expect(r.filters[0]).toEqual(pk(1000, 3));
		expect(r.filters[1]).toEqual({ type: 'PK', freq: Math.sqrt(20 * 20000), q: 1, gain: 0 });
	});

	it('spreads fillers evenly in log frequency between neighbours under ascendingFrequency', () => {
		const p = profile({ rules: [{ type: 'ascendingFrequency' }] });
		const freqs = complete(p, [null, pk(1000, 3), null, null]).filters.map((f) => f.freq);
		expect(freqs[0]).toBeCloseTo(Math.sqrt(20 * 1000), 9);
		expect(freqs[1]).toBe(1000);
		expect(freqs[2]).toBeCloseTo(1000 * 20 ** (1 / 3), 6);
		expect(freqs[3]).toBeCloseTo(1000 * 20 ** (2 / 3), 6);
	});

	it('uses locked frequencies of a graphic EQ', () => {
		const e = example('e-graphic-10');
		const r = complete(e, []);
		expect(r.filters.map((f) => f.freq)).toEqual([
			31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000
		]);
		expect(r.filters.every((f) => f.gain === 0 && f.q === 1.41)).toBe(true);
	});

	it('warns when a slot cannot be neutral', () => {
		const shifted = profile({ bandCount: 2, bands: [{ index: 1, gain: { min: 1, max: 6 } }] });
		expect(complete(shifted, []).warnings).toEqual([{ slot: 1, code: 'not-neutral' }]);
		const gainless = profile({ bandCount: 1, band: { types: ['HPQ', 'AP'] } });
		expect(complete(gainless, [])).toMatchObject({
			filters: [{ type: 'AP', gain: 0 }],
			warnings: [{ slot: 0, code: 'not-neutral' }]
		});
	});

	it('warns when no filler frequency keeps the order', () => {
		const p = profile({
			bandCount: 3,
			bands: [{ index: 1, freq: { value: 1000 } }],
			rules: [{ type: 'ascendingFrequency' }]
		});
		expect(complete(p, [pk(2000, 1), null, pk(5000, 1)]).warnings).toEqual([
			{ slot: 1, code: 'no-room' }
		]);
	});

	it('returns just the filters of an unbounded engine', () => {
		expect(complete(example('g-equalizer-apo'), [pk(100, 1), null, pk(200, 1)]).filters).toEqual([
			pk(100, 1),
			pk(200, 1)
		]);
	});
});
