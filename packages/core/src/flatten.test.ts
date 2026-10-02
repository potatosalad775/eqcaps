import { describe, expect, it } from 'vitest';
import { flattenProfile, PROFILE_SCHEMA_URL } from './flatten.ts';
import type { AuthoringProfile } from './types/schema.generated.ts';

const src = (ref: string) => ({ kind: 'handler-code' as const, ref, date: '2026-10-02' });

const chip: AuthoringProfile = {
	abstract: true,
	id: 'chip',
	schemaVersion: '1.0',
	kind: 'hardware',
	bandCount: 4,
	band: {
		types: ['PK'],
		freq: { min: 20, max: 20000 },
		q: { min: 0.1, max: 10 },
		gain: { min: -10, max: 10 }
	},
	bands: [
		{ index: [0, 1], types: ['LSC'], label: 'Low' },
		{ index: 3, types: ['HSC'] }
	],
	realization: { laws: [{ law: 'gainScaledQ', types: ['PK'] }], sources: [src('chip laws')] },
	preamp: { mode: 'unknown' },
	meta: { status: 'draft', sources: [src('chip handler')] },
	'x-chip': 'kept'
} as AuthoringProfile;

const family: AuthoringProfile = {
	abstract: true,
	id: 'family',
	extends: 'chip',
	schemaVersion: '1.1',
	band: { gain: { min: -12, max: 6 } },
	meta: { status: 'draft', sources: [src('family handler')] }
};

const device: AuthoringProfile = {
	$schema: '../../../schema/v1/source.schema.json',
	extends: 'family',
	id: 'device',
	device: { brand: 'Brand', model: 'Model' },
	match: { usb: [{ vendorId: '0x0001', productId: '0x0002' }] },
	bands: [{ index: 1, freq: { min: 20, max: 300 } }],
	meta: { status: 'draft', sources: [src('device config')] }
};

const files = new Map([chip, family, device].map((f) => [f.id, f]));
const lookup = (id: string) => files.get(id);

describe('flattenProfile (SPEC §11)', () => {
	const { profile, issues } = flattenProfile(device, lookup);

	it('resolves the chain without issues', () => {
		expect(issues).toEqual([]);
		expect(profile).not.toBeNull();
	});

	it('merges band per key and keeps unrelated base keys', () => {
		expect(profile?.band).toEqual({ ...chip.band, gain: { min: -12, max: 6 } });
		expect(profile?.bandCount).toBe(4);
		expect((profile as unknown as Record<string, unknown>)['x-chip']).toBe('kept');
	});

	it('merges bands by index, per key, keeping untouched slots', () => {
		expect(profile?.bands).toEqual([
			{ types: ['LSC'], label: 'Low', index: [0] },
			{ types: ['LSC'], label: 'Low', freq: { min: 20, max: 300 }, index: 1 },
			{ types: ['HSC'], index: 3 }
		]);
	});

	it('appends base sources with via set to the file that declared them', () => {
		expect(profile?.meta.sources).toEqual([
			src('device config'),
			{ ...src('family handler'), via: 'family' },
			{ ...src('chip handler'), via: 'chip' }
		]);
		expect(profile?.realization?.sources).toEqual([{ ...src('chip laws'), via: 'chip' }]);
	});

	it('takes the highest schemaVersion in the chain', () => {
		expect(profile?.schemaVersion).toBe('1.1');
	});

	it('never inherits abstract or extends, and writes the published $schema first', () => {
		expect(Object.keys(profile ?? {})).toEqual([
			'$schema',
			'schemaVersion',
			'id',
			'kind',
			'device',
			'match',
			'bandCount',
			'band',
			'bands',
			'realization',
			'preamp',
			'meta',
			'x-chip'
		]);
		expect(profile?.$schema).toBe(PROFILE_SCHEMA_URL);
	});

	it('does not modify its input', () => {
		expect(chip.meta.sources).toEqual([src('chip handler')]);
		expect(chip.bands).toHaveLength(2);
	});
});
