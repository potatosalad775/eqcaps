import { describe, expect, it } from 'vitest';
import { example, pk } from '../test/fixtures.ts';
import { resolveSlot } from './resolve.ts';

describe('resolveSlot (SPEC §13.1)', () => {
	it('merges the template with the override', () => {
		const jds = example('b-jds-labs-element-iv');
		expect(resolveSlot(jds, 0)).toEqual({
			label: 'Lowshelf',
			types: ['LSC'],
			freq: { min: 20, max: 20000 },
			q: { min: 0.1, max: 10 },
			gain: { min: -12, max: 12 },
			locked: { type: true, freq: false, q: false, gain: false }
		});
		expect(resolveSlot(jds, 5).types).toEqual(['PK']);
		expect(() => resolveSlot(jds, 12)).toThrow(RangeError);
	});

	it('selects variants against the filter', () => {
		const d = example('d-gain-dependent-window');
		expect(resolveSlot(d, 0).freq).toEqual({ min: 20, max: 20000 });
		expect(resolveSlot(d, 0, pk(1000, 3)).freq).toEqual({ min: 200, max: 8000 });
		expect(resolveSlot(d, 0, pk(1000, 0)).freq).toEqual({ min: 20, max: 20000 });
		expect(resolveSlot(d, 0, pk(1000, 1e-12)).freq).toEqual({ min: 20, max: 20000 });
		expect(resolveSlot(d, 0, pk(1000, -3)).freq).toEqual({ min: 20, max: 20000 });
	});

	it('flags locked fields', () => {
		const e = example('e-graphic-10');
		expect(resolveSlot(e, 0).locked).toEqual({ type: true, freq: true, q: true, gain: false });
	});

	it('serves any slot of an unbounded profile from the template', () => {
		expect(resolveSlot(example('g-equalizer-apo'), 500).types).toContain('AP');
	});
});
