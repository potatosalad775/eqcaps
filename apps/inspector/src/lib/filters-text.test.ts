import { describe, expect, it } from 'vitest';
import { bandwidthToQ, formatApo, parseApo, parseFilters, parseJson } from './filters-text.ts';

describe('parseApo', () => {
	it('reads AutoEQ ParametricEQ.txt', () => {
		const r = parseApo(
			[
				'Preamp: -6.4 dB',
				'Filter 1: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70',
				'Filter 2: ON PK Fc 31 Hz Gain -1.2 dB Q 0.58',
				'Filter 3: ON HSC Fc 10000 Hz Gain -1.8 dB Q 0.70'
			].join('\n')
		);
		expect(r.problems).toEqual([]);
		expect(r.preamp).toBe(-6.4);
		expect(r.filters).toEqual([
			{ type: 'LSC', freq: 105, q: 0.7, gain: 5.5 },
			{ type: 'PK', freq: 31, q: 0.58, gain: -1.2 },
			{ type: 'HSC', freq: 10000, q: 0.7, gain: -1.8 }
		]);
	});

	it('maps Equalizer APO and modernGraphTool codes to SPEC types (D22)', () => {
		const r = parseApo(
			[
				'Filter: ON LSQ Fc 100 Hz Gain 3 dB Q 0.7',
				'Filter: ON HP Fc 20 Hz',
				'Filter: ON NO Fc 1000 Hz Q 30',
				'Filter: ON PK Fc 1000 Hz Gain 2 dB BW Oct 1'
			].join('\n')
		);
		expect(r.problems).toEqual([]);
		expect(r.filters.map((f) => f.type)).toEqual(['LSC', 'HPQ', 'NO', 'PK']);
		expect(r.filters[1]?.q).toBeCloseTo(Math.SQRT1_2);
		expect(r.filters[2]?.gain).toBe(0);
		expect(r.filters[3]?.q).toBeCloseTo(bandwidthToQ(1));
		expect(bandwidthToQ(1)).toBeCloseTo(1.4142, 4);
	});

	it('skips OFF filters, comments and other commands; adds up preamps', () => {
		const r = parseApo(
			[
				'# comment',
				'Device: all',
				'Preamp: -3 dB',
				'Preamp: -1.5 dB',
				'Filter 1: OFF PK Fc 100 Hz Gain 3 dB Q 1',
				'Filter 2: ON PK Fc 200 Hz Gain 3 dB Q 1 # trailing'
			].join('\r\n')
		);
		expect(r).toMatchObject({ preamp: -4.5, skipped: 1, problems: [] });
		expect(r.filters).toHaveLength(1);
	});

	it('reports each line it cannot read, by number, and keeps the rest', () => {
		const r = parseApo(
			[
				'Filter 1: ON PK Fc 100 Hz Gain 3 dB Q 1',
				'Filter 2: ON XX Fc 100 Hz Gain 3 dB Q 1',
				'Filter 3: ON LS Fc 100 Hz Gain 3 dB',
				'Filter 4: ON PK Gain 3 dB Q 1',
				'Filter 5: ON PK Fc 100 Hz Gain 3 dB',
				'Filter 6: garbage',
				'GraphicEQ: 20 1; 40 2'
			].join('\n')
		);
		expect(r.filters).toHaveLength(1);
		expect(r.problems.map((p) => p.line)).toEqual([2, 3, 4, 5, 6, 7]);
		expect(r.problems[1]?.message).toMatch(/slope/);
	});
});

describe('parseJson', () => {
	it('reads a list or { preamp, filters }', () => {
		expect(parseJson('[{"type":"PK","freq":100,"q":1,"gain":2}]').filters).toEqual([
			{ type: 'PK', freq: 100, q: 1, gain: 2 }
		]);
		const r = parseJson(
			'{"preamp":-2,"filters":[{"type":"HSQ","fc":8000,"q":0.7,"gain":-1},{"type":"PK","freq":1,"q":1,"gain":1,"disabled":true}]}'
		);
		expect(r).toMatchObject({
			preamp: -2,
			skipped: 1,
			filters: [{ type: 'HSC', freq: 8000, q: 0.7, gain: -1 }]
		});
	});

	it('keeps vendor types and reports bad entries', () => {
		const r = parseJson('[{"type":"x-foo","freq":1,"q":1,"gain":0},{"type":"ZZ"},{"freq":"1"},3]');
		expect(r.filters).toEqual([{ type: 'x-foo', freq: 1, q: 1, gain: 0 }]);
		expect(r.problems.map((p) => p.line)).toEqual([2, 3, 4]);
		expect(parseJson('{').problems[0]?.line).toBe(0);
	});
});

describe('parseFilters and formatApo', () => {
	it('round-trip through Equalizer APO text', () => {
		const filters = [
			{ type: 'LSC' as const, freq: 105.25, q: 0.707, gain: 5.5 },
			{ type: 'PK' as const, freq: 1000, q: 1.414, gain: -3 }
		];
		const r = parseFilters(formatApo(filters, -4));
		expect(r).toMatchObject({ filters, preamp: -4, problems: [] });
		expect(parseFilters(' [{"freq":100,"q":1,"gain":1}]').filters[0]?.type).toBe('PK');
	});
});
