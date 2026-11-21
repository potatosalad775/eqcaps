import { describe, expect, it } from 'vitest';
import { channelsText, findingLines, readChannels } from './connect.ts';
import { example } from './test-fixtures.ts';

const pk = (freq: number, gain: number) => ({ type: 'PK' as const, freq, q: 1, gain });
const noBandCount = { needsBandCount: true };

describe('readChannels', () => {
	const apo = example('g-equalizer-apo');

	it('gives one channel where the pull returned one set', () => {
		const [only, ...rest] = readChannels({ filters: [pk(1000, 35)], preamp: -2 }, apo, noBandCount);
		expect(rest).toEqual([]);
		expect(only!.channel).toBeUndefined();
		expect(only!.preamp).toBe(-2);
		expect(findingLines(only!.findings!, only!.filters)).toEqual([
			'Slot 1: gain 35 is out of range (allowed: −30 dB to +30 dB)'
		]);
	});

	it('gives the left and the right where the pull returned them apart, each checked on its own', () => {
		const pull = {
			filters: [pk(1000, -3)],
			preamp: -1,
			right: { filters: [pk(2000, 35)], preamp: -4 }
		};
		const [left, right] = readChannels(pull, apo, noBandCount);
		expect(left).toMatchObject({ channel: 'Left', filters: pull.filters, preamp: -1 });
		expect(left!.findings!.violations).toEqual([]);
		expect(right).toMatchObject({ channel: 'Right', filters: pull.right.filters, preamp: -4 });
		expect(findingLines(right!.findings!, right!.filters)).toEqual([
			'Slot 1: gain 35 is out of range (allowed: −30 dB to +30 dB)'
		]);
	});

	it('checks nothing without a profile', () => {
		const pull = { filters: [pk(1000, 35)], right: { filters: [pk(2000, 35)] } };
		expect(readChannels(pull, null, noBandCount).map((c) => c.findings)).toEqual([null, null]);
	});
});

describe('channelsText', () => {
	const apo = example('g-equalizer-apo');

	it('says linked or independent, and whether the read took the channels apart', () => {
		expect(channelsText(apo, false)).toMatch(/^Channels linked/);
		const apart = { ...apo, channels: 'independent' as const };
		expect(channelsText(apart, true)).toMatch(/^Channels independent: .*read and checked apart/);
		expect(channelsText(apart, false)).toMatch(/reads them as one/);
	});
});
