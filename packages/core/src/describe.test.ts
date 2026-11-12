import { describe as group, expect, it } from 'vitest';
import { example, profile } from '../test/fixtures.ts';
import { describe, describeDomain, isGraphic, unsupported } from './describe.ts';
import type { Profile } from './types/schema.generated.ts';

group('isGraphic (SPEC §5.4)', () => {
	it('holds when every slot is freq-locked', () => {
		expect(isGraphic(example('e-graphic-10'))).toBe(true);
		expect(isGraphic(example('b-jds-labs-element-iv'))).toBe(false);
		expect(isGraphic(profile({ band: { freq: { values: [1000] } }, bandCount: 1 }))).toBe(true);
	});
});

group('describe', () => {
	it('groups identical slots', () => {
		const d = describe(example('b-jds-labs-element-iv'));
		expect(d.bands).toBe('12 bands');
		expect(d.groups.map((g) => [g.slots, g.label, g.types])).toEqual([
			[[0, 1], 'Lowshelf', 'low shelf'],
			[[2, 3, 4, 5, 6, 7, 8, 9], undefined, 'peaking'],
			[[10, 11], 'Highshelf', 'high shelf']
		]);
		expect(d.groups[0]?.freq).toBe('20 Hz – 20 kHz');
		expect(d.groups[0]?.gain).toBe('−12 dB to +12 dB');
		expect(d.preamp).toBe('Preamp unknown');
	});

	it('describes variants and rules', () => {
		expect(describe(example('d-gain-dependent-window')).groups[0]?.conditions).toEqual([
			'when gain > 0 dB: freq 200 Hz – 8 kHz'
		]);
		expect(describe(example('c-partitioned-windows')).rules).toEqual([
			'Band frequencies must increase from slot to slot'
		]);
		expect(describe(example('g-equalizer-apo')).bands).toBe('Unlimited bands');
	});

	it('formats each domain form', () => {
		expect(describeDomain({ min: -6, max: 6, step: 0.25 }, 'gain')).toBe(
			'−6 dB to +6 dB in 0.25 dB steps'
		);
		expect(describeDomain({ value: 1.41 }, 'q')).toBe('1.41 (fixed)');
		expect(describeDomain({ values: [31, 62, 125] }, 'freq')).toBe(
			'31 Hz, 62 Hz, 125 Hz (3 values)'
		);
		expect(describeDomain({ min: 20, max: 20000, step: 1 }, 'freq')).toBe(
			'20 Hz – 20 kHz in 1 Hz steps'
		);
	});
});

group('unsupported', () => {
	it('lists rules and types this engine does not know', () => {
		const p = profile({
			band: { types: ['PK', 'x-tilt'] },
			rules: [{ type: 'maxResponse' }, { type: 'ascendingFrequency' }]
		}) as Profile;
		expect(unsupported(p)).toEqual({ rules: ['maxResponse'], types: ['x-tilt'] });
	});
});
