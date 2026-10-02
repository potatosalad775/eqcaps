import { describe, expect, it } from 'vitest';
import { example, profile } from '../test/fixtures.ts';
import { toRealized, toWritten } from './realization.ts';

const h = example('h-realization-laws'); // gainScaledQ on PK/LSC/HSC, shelfFrequencyShift at 48 kHz

describe('toRealized / toWritten (SPEC §13.3)', () => {
	it('is the identity without realization', () => {
		const f = { type: 'PK' as const, freq: 1000, q: 4, gain: -12 };
		expect(toRealized(profile(), f)).toEqual(f);
		expect(toWritten(profile(), f)).toEqual(f);
	});

	it('gainScaledQ divides q by A = 10^(|gain|/40)', () => {
		// SPEC §12 H: written q 4 at −12 dB sounds like q ≈ 2; to get 4, write ≈ 8.
		const r = toRealized(h, { type: 'PK', freq: 1000, q: 4, gain: -12 });
		expect(r.q).toBeCloseTo(4 / 10 ** 0.3, 12);
		expect(r.q).toBeCloseTo(2.00475, 5);
		expect(r).toMatchObject({ type: 'PK', freq: 1000, gain: -12 });
		expect(toWritten(h, { type: 'PK', freq: 1000, q: 4, gain: -12 }).q).toBeCloseTo(7.98105, 5);
	});

	it('shelfFrequencyShift moves a low shelf up and a high shelf down with gain', () => {
		const ls = toRealized(h, { type: 'LSC', freq: 100, q: 0.7, gain: 6 });
		const expected =
			(48000 / Math.PI) * Math.atan(Math.tan((Math.PI * 100) / 48000) * 10 ** (6 / 80));
		expect(ls.freq).toBeCloseTo(expected, 9);
		expect(ls.freq).toBeCloseTo(118.85, 2);
		expect(ls.q).toBeCloseTo(0.7 / 10 ** (6 / 40), 12);
		const hs = toRealized(h, { type: 'HSC', freq: 8000, q: 0.7, gain: 6 });
		expect(hs.freq).toBeLessThan(8000);
		const back = toWritten(h, hs);
		expect(back.freq).toBeCloseTo(8000, 9);
		expect(back.q).toBeCloseTo(0.7, 12);
	});

	it('nyquistScaledQ multiplies q by cos(π·f / designRate), evaluated at the written freq', () => {
		const p = profile({
			realization: {
				laws: [{ law: 'nyquistScaledQ', types: ['PK'], designRate: 48000 }],
				sources: [{ kind: 'community', ref: 'test', date: '2026-10-02' }]
			}
		});
		expect(toRealized(p, { type: 'PK', freq: 12000, q: 1, gain: 3 }).q).toBeCloseTo(
			Math.SQRT1_2,
			12
		);
		expect(toWritten(p, { type: 'PK', freq: 12000, q: Math.SQRT1_2, gain: 3 }).q).toBeCloseTo(
			1,
			12
		);
	});

	it('leaves frequencies outside 0 < f < designRate/2 alone', () => {
		const f = { type: 'LSC' as const, freq: 30000, q: 1, gain: 6 };
		expect(toWritten(h, f).freq).toBe(30000);
		expect(toRealized(h, f).freq).toBe(30000);
	});

	it('treats gainless types as gain 0 and applies laws only to their types', () => {
		expect(toRealized(h, { type: 'BP', freq: 1000, q: 2, gain: 9 })).toEqual({
			type: 'BP',
			freq: 1000,
			q: 2,
			gain: 0
		});
	});
});
