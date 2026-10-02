import { describe, expect, it } from 'vitest';
import { domainViolation, project, projectType } from './project.ts';

describe('project (SPEC §13.2)', () => {
	it('clamps a range', () => {
		const d = { min: 20, max: 20000 };
		expect(project(10, d, 'freq')).toBe(20);
		expect(project(25000, d, 'freq')).toBe(20000);
		expect(project(1000, d, 'freq')).toBe(1000);
	});

	it('rounds a stepped range half up, with floor(x + 0.5)', () => {
		const d = { min: -12, max: 12, step: 0.5 };
		expect(project(0.25, d, 'gain')).toBe(0.5);
		expect(project(-0.25, d, 'gain')).toBe(0);
		expect(project(-0.75, d, 'gain')).toBe(-0.5);
		expect(project(0.74, d, 'gain')).toBe(0.5);
		expect(project(12.3, d, 'gain')).toBe(12);
	});

	it('keeps non-decimal grids on their bounds', () => {
		const d = { min: 0.5, max: 5, step: 0.07142857142857142 }; // 1/14
		expect(project(0.5, d, 'q')).toBe(0.5);
		expect(project(0.4, d, 'q')).toBe(0.5);
		expect(project(0.53, d, 'q')).toBe(0.5);
		expect(project(0.54, d, 'q')).toBe(0.5714285714);
		expect(project(5, d, 'q')).toBe(5);
	});

	it('picks the nearest set value: log distance for freq, linear for gain, ties low', () => {
		const freqs = { values: [31, 62, 125, 250] };
		expect(project(88, freqs, 'freq')).toBe(62);
		expect(project(89, freqs, 'freq')).toBe(125);
		expect(project(1, freqs, 'freq')).toBe(31);
		expect(project(-5, freqs, 'freq')).toBe(31);
		expect(project(1e6, freqs, 'freq')).toBe(250);
		expect(project(0, { values: [-1, 1] }, 'gain')).toBe(-1);
		expect(project(94, { values: [90, 100] }, 'gain')).toBe(90);
		expect(project(96, { values: [90, 100] }, 'gain')).toBe(100);
	});

	it('returns a locked value', () => {
		expect(project(3, { value: 1.41 }, 'q')).toBe(1.41);
	});

	it('maps NaN to the neutral value and infinities to the bounds', () => {
		expect(project(NaN, { min: -12, max: 12 }, 'gain')).toBe(0);
		expect(project(NaN, { min: 0.1, max: 10, step: 0.01 }, 'q')).toBe(1);
		expect(project(NaN, { min: 20, max: 20000 }, 'freq')).toBeCloseTo(632.4555, 4);
		expect(project(Infinity, { min: -12, max: 12, step: 0.5 }, 'gain')).toBe(12);
		expect(project(-Infinity, { values: [1, 2] }, 'gain')).toBe(1);
	});

	it('keeps an allowed type, otherwise takes the first', () => {
		expect(projectType('HSC', ['PK', 'HSC'])).toBe('HSC');
		expect(projectType('LSC', ['PK', 'HSC'])).toBe('PK');
	});
});

describe('domainViolation', () => {
	it('names the reason', () => {
		expect(domainViolation(0.3, { min: -6, max: 6, step: 0.25 })).toBe('off-grid');
		expect(domainViolation(7, { min: -6, max: 6, step: 0.25 })).toBe('out-of-range');
		expect(domainViolation(80, { values: [31, 62] })).toBe('not-in-set');
		expect(domainViolation(1.4, { value: 1.41 })).toBe('locked');
		expect(domainViolation(NaN, { min: 0, max: 1 })).toBe('out-of-range');
		expect(domainViolation(Infinity, { min: 0, max: 1 })).toBe('out-of-range');
		expect(domainViolation(6 + 1e-12, { min: -6, max: 6, step: 0.25 })).toBeNull();
		expect(domainViolation(62.00000000001, { values: [31, 62] })).toBeNull();
	});
});
