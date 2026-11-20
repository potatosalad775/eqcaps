import { describe, expect, test } from 'vitest';
import { eqProfile, profileEqs } from './eqs.ts';
import type { Profile } from './types/schema.generated.ts';
import { validateProfile } from './validate-profile.ts';

const profile: Profile = {
	schemaVersion: '1.3',
	id: 'two-eqs',
	kind: 'hardware',
	device: { brand: 'Example', model: 'Two EQs' },
	engine: 'User EQ',
	match: { usb: [{ vendorId: '0x0001', productId: '0x0001' }] },
	bandCount: 10,
	band: {
		types: ['PK'],
		freq: { min: 20, max: 20000 },
		q: { min: 0.1, max: 10 },
		gain: { min: -12, max: 12 }
	},
	bands: [
		{ index: [0, 9], types: ['PK', 'LSC'] },
		{ index: 7, gain: { min: -6, max: 6 } }
	],
	preamp: { mode: 'none' },
	protocol: {
		handler: 'chip-hid',
		options: { reportId: 1 },
		presets: [
			{ id: 0, name: 'Flat' },
			{ id: 1, name: 'Rock' }
		],
		eqs: [
			{ id: 'spk', name: 'Headphone EQ', bandCount: 20, presets: [{ id: 0, name: 'Flat' }] },
			{ id: 'mic', name: 'Microphone EQ', bandCount: 5 }
		]
	},
	meta: { status: 'draft', sources: [{ kind: 'community', ref: 'test', date: '2026-11-20' }] }
};

describe('profileEqs', () => {
	test("lists the profile's own EQ first, then the others with their band count and presets", () => {
		expect(profileEqs(profile)).toEqual([
			{ name: 'User EQ', bandCount: 10, presets: profile.protocol!.presets },
			{ id: 'spk', name: 'Headphone EQ', bandCount: 20, presets: [{ id: 0, name: 'Flat' }] },
			{ id: 'mic', name: 'Microphone EQ', bandCount: 5, presets: [] }
		]);
	});

	test('a profile without a list has its one EQ, unnamed without an engine label', () => {
		const { engine: _engine, protocol: _protocol, ...plain } = profile;
		expect(profileEqs(plain)).toEqual([{ bandCount: 10, presets: [] }]);
	});
});

describe('eqProfile', () => {
	test('no id is the profile itself; an unlisted id is undefined', () => {
		expect(eqProfile(profile)).toBe(profile);
		expect(eqProfile(profile, 'usr')).toBeUndefined();
	});

	test('a listed EQ is the profile with its label, band count and presets, and no list', () => {
		const spk = eqProfile(profile, 'spk')!;
		expect(spk).toMatchObject({ id: 'two-eqs', engine: 'Headphone EQ', bandCount: 20 });
		expect(spk.band).toBe(profile.band);
		expect(spk.bands).toEqual(profile.bands);
		expect(spk.protocol).toEqual({
			handler: 'chip-hid',
			options: { reportId: 1 },
			presets: [{ id: 0, name: 'Flat' }]
		});
		expect(validateProfile(spk)).toEqual([]);
	});

	test('an EQ without presets has none, and loses the overrides of slots it lacks', () => {
		const mic = eqProfile(profile, 'mic')!;
		expect(mic.bandCount).toBe(5);
		expect(mic.protocol).toEqual({ handler: 'chip-hid', options: { reportId: 1 } });
		expect(mic.bands).toEqual([{ index: [0], types: ['PK', 'LSC'] }]);
		expect(validateProfile(mic)).toEqual([]);
	});
});
