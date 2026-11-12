import { describe, expect, it } from 'vitest';
import { example, pk, profile } from '../test/fixtures.ts';
import type { Profile } from './types/schema.generated.ts';
import { validate, validateList } from './validate.ts';

describe('validate (SPEC §13.4)', () => {
	it('reports per slot: type, then freq, q, gain', () => {
		const base = profile();
		expect(
			validate(base, [
				pk(1000, 3),
				null,
				{ type: 'LSC', freq: 100, q: 0.7, gain: 3 },
				{ type: 'PK', freq: 30000, q: 0.105, gain: 0.15 }
			])
		).toEqual([
			{ slot: 2, field: 'type', code: 'type-not-allowed', allowed: ['PK'] },
			{ slot: 3, field: 'freq', code: 'out-of-range', allowed: { min: 20, max: 20000 } },
			{ slot: 3, field: 'q', code: 'off-grid', allowed: { min: 0.1, max: 10, step: 0.01 } },
			{ slot: 3, field: 'gain', code: 'off-grid', allowed: { min: -12, max: 12, step: 0.1 } }
		]);
	});

	it('ignores the gain of gainless types', () => {
		const p = profile({ band: { types: ['PK', 'LPQ'] } });
		expect(validate(p, [{ type: 'LPQ', freq: 5000, q: 0.7, gain: 99 }])).toEqual([]);
	});

	it('resolves variants against the filter itself', () => {
		const d = example('d-gain-dependent-window');
		expect(validate(d, [pk(100, -3)])).toEqual([]);
		expect(validate(d, [pk(100, 3)])).toEqual([
			{ slot: 0, field: 'freq', code: 'out-of-range', allowed: { min: 200, max: 8000 } }
		]);
	});

	it('flags slots beyond bandCount once, and the preamp', () => {
		const base = profile();
		const five = [pk(100, 1), pk(200, 1), pk(400, 1), pk(800, 1), pk(1600, 1)];
		expect(validate(base, five, -3)).toEqual([
			{ slot: null, field: null, code: 'too-many-bands' },
			{ slot: null, field: 'preamp', code: 'locked', allowed: { value: 0 } }
		]);
		const manual = profile({ preamp: { mode: 'manual', gain: { min: -12, max: 0, step: 0.1 } } });
		expect(validate(manual, [], 0.5)).toEqual([
			{
				slot: null,
				field: 'preamp',
				code: 'out-of-range',
				allowed: { min: -12, max: 0, step: 0.1 }
			}
		]);
		expect(validate(example('d-gain-dependent-window'), [], 5)).toEqual([]);
	});

	it('checks ascendingFrequency on the completed array, fillers included', () => {
		// Slot 1 is locked at 1 kHz, so it can't be filled between 2 kHz and 5 kHz.
		const p = profile({
			bandCount: 3,
			bands: [{ index: 1, freq: { value: 1000 } }],
			rules: [{ type: 'ascendingFrequency' }]
		});
		const violation = { slot: 1, field: 'freq', code: 'rule-violated', rule: 'ascendingFrequency' };
		expect(validate(p, [pk(2000, 1), null, pk(5000, 1)])).toEqual([violation]);
		expect(validate(p, [pk(500, 1), null, pk(5000, 1)])).toEqual([]);
		expect(validate(p, [pk(500, 1), pk(1000, 1), pk(1000, 1)])).toEqual([
			{ ...violation, slot: 2 }
		]);
		const loose = profile({
			bandCount: 3,
			bands: [{ index: 1, freq: { value: 1000 } }],
			rules: [{ type: 'ascendingFrequency', strict: false }]
		});
		expect(validate(loose, [pk(500, 1), pk(1000, 1), pk(1000, 1)])).toEqual([]);
	});

	it('leaves room for fillers in a continuous range only when there is some', () => {
		const c = example('c-partitioned-windows');
		// Slot 2 is 1–4 kHz: a filler fits strictly between 1 kHz and 3 kHz…
		expect(validate(c, [pk(100, 1), pk(1000, 1), null, pk(5000, 1)])).toEqual([]);
		// …but not when slot 1 already sits at the top of slot 2's window.
		const p = profile({
			bandCount: 3,
			bands: [{ index: 1, freq: { min: 1000, max: 4000 } }],
			rules: [{ type: 'ascendingFrequency' }]
		});
		expect(validate(p, [pk(4000, 1), null, pk(5000, 1)])).toEqual([
			{ slot: 1, field: 'freq', code: 'rule-violated', rule: 'ascendingFrequency' }
		]);
	});

	it('checks minSpacing between active filters only', () => {
		const p = profile({ rules: [{ type: 'minSpacing', octaves: 1 }] });
		expect(validate(p, [pk(100, 1), pk(150, 1), pk(400, 1), pk(160, 0)])).toEqual([
			{ slot: 1, field: 'freq', code: 'rule-violated', rule: 'minSpacing' }
		]);
	});

	it('reports unknown rules and allowed unknown types', () => {
		const p = profile({
			band: { types: ['PK', 'x-tilt'] },
			rules: [{ type: 'maxResponse', db: 6 }]
		}) as Profile;
		expect(validate(p, [{ type: 'x-tilt', freq: 1000, q: 1, gain: 2 }])).toEqual([
			{ slot: 0, field: 'type', code: 'unknown-type' },
			{ slot: null, field: null, code: 'unknown-rule', rule: 'maxResponse' }
		]);
	});
});

describe('validateList (SPEC §13.4)', () => {
	it('assigns first and names the input filter', () => {
		const jds = example('b-jds-labs-element-iv');
		const filters = [pk(1000, 3), { type: 'HSC' as const, freq: 30000, q: 0.7, gain: 2 }];
		expect(validateList(jds, filters)).toEqual([
			{ slot: 10, field: 'freq', code: 'out-of-range', allowed: { min: 20, max: 20000 }, filter: 1 }
		]);
	});

	it('reports filters that found no slot', () => {
		const filters = [pk(100, 3), pk(200, 0.5), pk(400, -6), pk(800, 2), pk(1600, 1)];
		expect(validateList(profile(), filters)).toEqual([
			{ slot: null, field: null, code: 'too-many-bands', filter: 1 }
		]);
	});

	it('ignores inactive filters', () => {
		expect(validateList(profile(), [pk(30000, 0)])).toEqual([]);
	});
});
