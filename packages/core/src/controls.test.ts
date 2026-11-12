import { describe, expect, it } from 'vitest';
import { controlPresent, controlTakes, eqDisabledBy } from './controls.ts';
import { firmwareInRange } from './firmware.ts';
import type { Control } from './types/schema.generated.ts';

const uac: Control = {
	id: 'uacMode',
	name: 'USB mode',
	kind: 'choice',
	values: [
		{ value: 0, name: 'UAC 2.0' },
		{ value: 1, name: 'UAC 1.0' }
	]
};
const upsample: Control = {
	id: 'upsample',
	name: 'Upsample',
	kind: 'toggle',
	when: { control: 'uacMode', values: [0] },
	firmware: { min: '1.4.9' },
	disablesEq: [1]
};
const volume: Control = {
	id: 'volume',
	name: 'Volume',
	kind: 'range',
	range: { min: 0, max: 60, step: 1 }
};

describe('controlTakes', () => {
	it('takes 0 and 1 for a toggle, the listed values for a choice', () => {
		expect([0, 1, 2, 0.5].map((v) => controlTakes(upsample, v))).toEqual([
			true,
			true,
			false,
			false
		]);
		expect([0, 1, 2].map((v) => controlTakes(uac, v))).toEqual([true, true, false]);
	});

	it('takes the grid points of a range, its ends included', () => {
		expect([0, 60, 30, -1, 61, 30.5, NaN].map((v) => controlTakes(volume, v))).toEqual([
			true,
			true,
			true,
			false,
			false,
			false,
			false
		]);
		const free: Control = { ...volume, range: { min: -1.5, max: 1.5 } };
		expect([-1.5, 0.123, 1.6].map((v) => controlTakes(free, v))).toEqual([true, true, false]);
	});
});

describe('controlPresent', () => {
	it('needs firmware in range: unknown firmware counts as absent', () => {
		const values = { uacMode: 0 };
		expect(controlPresent(upsample, { firmware: '1.4.9', values })).toBe(true);
		expect(controlPresent(upsample, { firmware: '1.4.8', values })).toBe(false);
		expect(controlPresent(upsample, { firmware: null, values })).toBe(false);
		expect(controlPresent(uac, { values: {} })).toBe(true);
	});

	it('needs the `when` control to hold a listed value', () => {
		expect(controlPresent(upsample, { firmware: '1.5.8', values: { uacMode: 1 } })).toBe(false);
		expect(controlPresent(upsample, { firmware: '1.5.8', values: { uacMode: null } })).toBe(false);
		expect(controlPresent(upsample, { firmware: '1.5.8', values: {} })).toBe(false);
	});
});

describe('eqDisabledBy', () => {
	it('lists the controls whose value turns the EQ off', () => {
		const controls = [uac, upsample, volume];
		expect(eqDisabledBy(controls, { uacMode: 0, upsample: 1 }).map((c) => c.id)).toEqual([
			'upsample'
		]);
		expect(eqDisabledBy(controls, { upsample: 0 })).toEqual([]);
		expect(eqDisabledBy(controls, { upsample: null })).toEqual([]);
	});
});

describe('firmwareInRange', () => {
	it('is min inclusive, max exclusive, and false for unknown firmware', () => {
		const range = { min: '1.4.9', max: '1.4.15' };
		expect(['1.4.9', '1.4.14', '1.4.15', '1.4.8'].map((f) => firmwareInRange(range, f))).toEqual([
			true,
			true,
			false,
			false
		]);
		expect(firmwareInRange({ min: '1.0' }, undefined)).toBe(false);
	});
});
