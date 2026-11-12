import { describe, expect, it } from 'vitest';
import { validate, validateList } from '@potatosalad775/eqcaps-core';
import { violationText } from './violations.ts';
import { example } from './test-fixtures.ts';

describe('violationText', () => {
	it('names the filter, the slot, the value and what was allowed', () => {
		const jds = example('b-jds-labs-element-iv');
		const filters = [{ type: 'PK' as const, freq: 1000, q: 1, gain: 15 }];
		const [v] = validateList(jds, filters);
		expect(violationText(v!, filters)).toBe(
			'Filter 1, slot 3: gain 15 is out of range (allowed: −12 dB to +12 dB)'
		);
	});

	it('words types, set values, band count and preamp', () => {
		const edifier = example('a-edifier-w830nb');
		const slots = [{ type: 'LSC' as const, freq: 1234, q: 1, gain: 0 }];
		const texts = validate(edifier, slots, 3).map((v) => violationText(v, slots));
		expect(texts[0]).toMatch(/^Slot 1: type LSC is not allowed \(allowed: PK\)$/);
		expect(texts.some((t) => /freq 1234 is not one of the listed values/.test(t))).toBe(true);
		expect(texts.at(-1)).toMatch(/^Preamp is fixed to another value/);
		const many = Array.from({ length: 6 }, (_, i) => ({
			type: 'PK' as const,
			freq: 100 * (i + 1),
			q: 1,
			gain: 1
		}));
		expect(
			validateList(edifier, many).some(
				(v) => violationText(v) === 'Filter 5: no slot left for this filter'
			)
		).toBe(true);
	});
});
