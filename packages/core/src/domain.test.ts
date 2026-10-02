import { describe, expect, it } from 'vitest';
import { domainBounds, domainForm, isLockedDomain, near, onGrid } from './domain.ts';

describe('tolerance (SPEC §4)', () => {
	it('is relative for large values and absolute below 1', () => {
		expect(near(20000, 20000 + 1e-6)).toBe(true);
		expect(near(20000, 20000.001)).toBe(false);
		expect(near(0, 1e-10)).toBe(true);
		expect(near(0, 1e-8)).toBe(false);
	});

	it('accepts non-decimal steps written as decimals', () => {
		const step = 0.07142857142857142; // 1/14
		expect(onGrid(0.5, step)).toBe(true);
		expect(onGrid(5, step)).toBe(true);
		expect(onGrid(0.55, step)).toBe(false);
		expect(onGrid(-12, 0.1)).toBe(true);
		expect(onGrid(-12.05, 0.1)).toBe(false);
	});
});

describe('domain helpers', () => {
	it('classifies and bounds every form', () => {
		expect(domainForm({ min: 1, max: 2 })).toBe('range');
		expect(domainForm({ min: 1, max: 2, step: 1 })).toBe('stepped');
		expect(domainForm({ values: [3, 1] })).toBe('set');
		expect(domainForm({ value: 4 })).toBe('locked');
		expect(domainBounds({ values: [31, 62, 125] })).toEqual({ min: 31, max: 125 });
		expect(domainBounds({ value: 4 })).toEqual({ min: 4, max: 4 });
	});

	it('treats a single-element set as locked (SPEC §5.4)', () => {
		expect(isLockedDomain({ values: [1000] })).toBe(true);
		expect(isLockedDomain({ values: [1000, 2000] })).toBe(false);
		expect(isLockedDomain({ value: 1000 })).toBe(true);
		expect(isLockedDomain({ min: 1000, max: 1000 })).toBe(false);
	});
});
