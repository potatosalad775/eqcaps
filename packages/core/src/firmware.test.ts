import { describe, expect, it } from 'vitest';
import { compareFirmware, firmwareRangesOverlap } from './firmware.ts';

describe('compareFirmware (SPEC §3)', () => {
	it('compares dotted-numeric, missing components = 0', () => {
		expect(compareFirmware('1.10', '1.9')).toBeGreaterThan(0);
		expect(compareFirmware('2', '2.0.0')).toBe(0);
		expect(compareFirmware('v1.2b3', '1.2.3')).toBe(0);
		expect(compareFirmware('1.2', '1.2.1')).toBeLessThan(0);
	});

	it('overlaps half-open ranges, missing bounds unbounded', () => {
		expect(firmwareRangesOverlap({ max: '2.0' }, { min: '2' })).toBe(false);
		expect(firmwareRangesOverlap({ max: '2.0.1' }, { min: '2' })).toBe(true);
		expect(firmwareRangesOverlap(undefined, { min: '9' })).toBe(true);
		expect(firmwareRangesOverlap({ min: '1', max: '2' }, { min: '1.5', max: '1.6' })).toBe(true);
	});
});
