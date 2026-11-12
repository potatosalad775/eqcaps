import { describe, expect, it } from 'vitest';
import { freqAxis, gridPoints, slotRows, span, whenLabel } from './slots.ts';
import { example } from './test-fixtures.ts';

describe('slotRows', () => {
	it('merges overrides into one row per slot', () => {
		const rows = slotRows(example('b-jds-labs-element-iv'));
		expect(rows).toHaveLength(12);
		expect(rows.map((r) => r.types[0])).toEqual([
			...['LSC', 'LSC'],
			...Array(8).fill('PK'),
			...['HSC', 'HSC']
		]);
		expect(rows[0]).toMatchObject({ index: 0, label: 'Lowshelf' });
	});

	it('gives an unbounded profile one template row', () => {
		const rows = slotRows(example('g-equalizer-apo'));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.index).toBeNull();
	});

	it('keeps variants', () => {
		const [row] = slotRows(example('d-gain-dependent-window'));
		expect(row?.variants).toHaveLength(1);
		expect(whenLabel(row!.variants[0]!.when)).toBe('gain > 0 dB');
	});
});

describe('chart geometry', () => {
	it('spans and grids domains', () => {
		expect(span({ value: 3 })).toEqual([3, 3]);
		expect(span({ values: [1, 5, 9] })).toEqual([1, 9]);
		expect(gridPoints({ min: -1, max: 1, step: 0.5 })).toEqual([-1, -0.5, 0, 0.5, 1]);
		expect(gridPoints({ min: 20, max: 20000, step: 1 })).toBeNull();
		expect(gridPoints({ min: 20, max: 20000 })).toBeNull();
	});

	it('puts every window on a log axis that covers it', () => {
		const axis = freqAxis(slotRows(example('e-graphic-10')));
		expect(axis.min).toBeLessThan(20);
		expect(axis.max).toBeGreaterThan(20000);
		expect(axis.x(axis.min)).toBe(0);
		expect(axis.x(axis.max)).toBeCloseTo(1);
		expect(axis.x(1000) - axis.x(100)).toBeCloseTo(axis.x(10000) - axis.x(1000));
		expect(whenLabel({ freq: { gte: 1000 }, type: { in: ['LSC', 'HSC'] } })).toBe(
			'type LSC/HSC and freq ≥ 1 kHz'
		);
	});
});
