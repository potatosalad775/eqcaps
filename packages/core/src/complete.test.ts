import { describe, expect, it } from 'vitest';
import { example, pk, profile } from '../test/fixtures.ts';
import { complete } from './complete.ts';

describe('complete (SPEC §13.7)', () => {
	it('spreads neutral fillers between the filled slots at nominal frequencies', () => {
		const r = complete(profile(), [pk(1000, 3), null]);
		expect(r.warnings).toEqual([]);
		expect(r.filters).toEqual([pk(1000, 3), pk(80, 0), pk(250, 0), pk(4000, 0)]);
		const empty = complete(profile({ bandCount: 8 }), []).filters.map((f) => f.freq);
		expect(empty).toEqual([40, 100, 200, 400, 1000, 2000, 4000, 10000]);
	});

	it('spreads fillers evenly in log frequency between neighbours under ascendingFrequency', () => {
		const p = profile({ rules: [{ type: 'ascendingFrequency' }] });
		const freqs = complete(p, [null, pk(1000, 3), null, null]).filters.map((f) => f.freq);
		expect(freqs).toEqual([125, 1000, 2500, 8000]);
		const empty = profile({ bandCount: 8, rules: [{ type: 'ascendingFrequency' }] });
		expect(complete(empty, []).filters.map((f) => f.freq)).toEqual([
			40, 100, 200, 400, 1000, 2000, 4000, 10000
		]);
	});

	it('keeps the order when nominal frequencies are scarce between neighbours', () => {
		const p = profile({ rules: [{ type: 'ascendingFrequency' }] });
		const freqs = complete(p, [pk(100, 3), null, null, null]).filters.map((f) => f.freq);
		const tight = complete(p, [pk(100, 3), null, null, pk(200, 1)]).filters.map((f) => f.freq);
		expect(freqs).toEqual([100, 400, 1250, 5000]);
		expect(tight).toEqual([100, 125, 160, 200]);
	});

	it('projects nominal frequencies onto a stepped domain, or keeps the spread', () => {
		const stepped = profile({ band: { freq: { min: 20, max: 20000, step: 10 } } });
		const freqs = complete(stepped, [pk(1000, 3), null]).filters.map((f) => f.freq);
		expect(freqs).toEqual([1000, 80, 250, 4000]);
		const narrow = profile({ band: { freq: { min: 1010, max: 1100 } } });
		const [, a, b, c] = complete(narrow, [pk(1050, 3), null]).filters.map((f) => f.freq);
		expect(a).toBeCloseTo(Math.sqrt(1010 * 1050), 9);
		expect(b).toBeCloseTo(1050 * (1100 / 1050) ** (1 / 3), 9);
		expect(c).toBeCloseTo(1050 * (1100 / 1050) ** (2 / 3), 9);
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

	it('writes a hint flat in its empty slot instead of the neutral filler', () => {
		const hints = [pk(31, 6, 0.7), pk(62, -2, 0.7), pk(125, 1, 0.7), pk(250, 0, 0.7)];
		const r = complete(profile(), [pk(1000, 3), null, null], { hints });
		expect(r.filters).toEqual([pk(1000, 3), pk(62, 0, 0.7), pk(125, 0, 0.7), pk(250, 0, 0.7)]);
		expect(r.warnings).toEqual([]);
	});

	it('ignores a hint that cannot be flat', () => {
		const shifted = profile({ bandCount: 2, bands: [{ index: 1, gain: { min: 1, max: 6 } }] });
		const r = complete(shifted, [], { hints: [pk(100, 3), pk(200, 3)] });
		expect(r.filters[0]).toEqual(pk(100, 0));
		expect(r.filters[1]?.freq).toBe(1250);
		expect(r.warnings).toEqual([{ slot: 1, code: 'not-neutral' }]);
	});

	it('ignores a hint that would break ascendingFrequency', () => {
		const p = profile({ rules: [{ type: 'ascendingFrequency' }] });
		const r = complete(p, [pk(1000, 3), null, pk(4000, 1), null], {
			hints: [null, pk(500, 2), null, pk(8000, 2)]
		});
		expect(r.filters[1]?.freq).toBeCloseTo(2000, 9);
		expect(r.filters[3]).toEqual(pk(8000, 0));
		expect(r.warnings).toEqual([]);
	});
});
