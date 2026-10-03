// The probe engine against virtual devices (PLAN Phase 5): real codecs in front of firmware that
// accepts what a profile says. A probe must derive that profile back (or say why it can't), keep
// to its write budget, and restore the backup on every path, including the failure ones.

import {
	project,
	resolveSlot,
	validateProfile,
	type Filter,
	type FilterType,
	type Profile
} from '@potatosalad775/eqcaps-core';
import { analyzeCodec, PROTOCOLS, type Protocol } from '@potatosalad775/eqcaps-device-bridge';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { validateRepository } from '../../../../../packages/build/src/node.ts';
import { constraintDiff } from './compare.ts';
import { deriveConstraints } from './derive.ts';
import { runProbe, type ProbeOptions } from './engine.ts';
import { evidenceText, stringFields } from '../evidence.ts';
import { probeEvidence } from './evidence.ts';
import { FakeDevice, type FakeDeviceOptions } from './fake-device.ts';
import type { ProbeResult } from './types.ts';

const profiles = validateRepository().profiles;
const data = (id: string) => profiles.get(id) as Profile;

const quiet = { sleep: () => Promise.resolve(), interval: 0 };

/** A profile with the given constraints, for firmware no data profile describes. */
function truth(c: Partial<Profile> & Pick<Profile, 'bandCount' | 'band'>): Profile {
	return {
		schemaVersion: '1.0',
		id: 'test-device',
		kind: 'hardware',
		device: { brand: 'Test', model: 'Device' },
		match: { usb: [{ vendorId: '0x0001', productId: '0x0001' }] },
		preamp: { mode: 'unknown' },
		meta: { status: 'draft', sources: [{ kind: 'community', ref: 'test', date: '2026-10-03' }] },
		...c
	} as Profile;
}

async function probe(
	device: FakeDeviceOptions,
	options: Partial<ProbeOptions> = {}
): Promise<{ result: ProbeResult; fake: FakeDevice; diff: string[]; notes: string[] }> {
	const fake = new FakeDevice(device);
	const analysis = analyzeCodec(device.protocol);
	const result = await runProbe(fake, { mode: 'full', analysis, ...quiet, ...options });
	const derived = deriveConstraints(result, {
		analysis,
		...(options.profile ? { profile: options.profile } : {})
	});
	const notes = derived?.notes ?? [];
	const all = derived
		? constraintDiff(device.truth, derived.constraints as Profile)
		: ['nothing derived'];
	return { result, fake, diff: unexplained(all, notes), notes };
}

/** Differences no note accounts for: a bound past the search limit is reported, not an error. */
function unexplained(diff: string[], notes: string[]): string[] {
	const field = (line: string) => /^(preamp)|: (freq|q|gain) /.exec(line)?.slice(1).find(Boolean);
	const label = { preamp: 'preamp', freq: 'frequency', q: 'Q', gain: 'gain' } as Record<
		string,
		string
	>;
	return diff.filter((line) => {
		const f = field(line);
		return !(f && notes.some((n) => n.startsWith(label[f]!) && n.includes('search limit')));
	});
}

const walkplay = PROTOCOLS['walkplay-schemeno16-devices'] as Protocol;

describe('a Walkplay device', () => {
	const t = data('walkplay-schemeno16-devices');

	test('clamping firmware: the probe derives its profile and restores the backup', async () => {
		const initial: Filter[] = Array.from({ length: t.bandCount! }, (_, i) => ({
			type: 'PK',
			freq: 100 * (i + 1),
			q: 1.5,
			gain: i % 2 ? -1 : 1
		}));
		const { result, fake, diff } = await probe({ protocol: walkplay, truth: t, initial });
		expect(result.aborted).toBeUndefined();
		expect(diff).toEqual([]);
		expect(result.restore.verified).toBe(true);
		expect(fake.stored).toEqual(initial);
		expect(result.writes).toBeLessThan(140);
		console.log('walkplay clamp writes', result.writes);
	});

	test('rejecting firmware', async () => {
		const { result, diff } = await probe({ protocol: walkplay, truth: t, outOfRange: 'reject' });
		console.log('walkplay reject writes', result.writes);
		expect(result.aborted).toBeUndefined();
		expect(diff).toEqual([]);
		expect(result.restore.verified).toBe(true);
	});

	test('a quick probe stays near 25 writes', async () => {
		const { result } = await probe(
			{ protocol: walkplay, truth: t, outOfRange: 'reject' },
			{ mode: 'quick', profile: t }
		);
		expect(result.restore.verified).toBe(true);
		console.log('walkplay quick writes', result.writes);
		expect(result.writes).toBeLessThanOrEqual(30);
	});
});

describe('failure paths', () => {
	const t = data('walkplay-schemeno16-devices');

	test('a device that refuses whole writes is probed band by band', async () => {
		const { result, diff } = await probe({
			protocol: walkplay,
			truth: partitioned(),
			outOfRange: 'reject',
			wholeSet: true
		});
		expect(result.findings.wholeSet).toBe(true);
		expect(diff).toEqual([]);
		expect(result.restore.verified).toBe(true);
	});

	test('a device that refuses whole writes with an error', async () => {
		const { result, diff } = await probe({
			protocol: walkplay,
			truth: partitioned(),
			outOfRange: 'reject',
			wholeSet: true,
			nak: true
		});
		expect(result.findings.wholeSet).toBe(true);
		expect(diff).toEqual([]);
		expect(result.restore.verified).toBe(true);
	});

	test('a device that resets itself on bad input: reported, and restored', async () => {
		const { result, diff } = await probe({ protocol: walkplay, truth: t, resetOnInvalid: true });
		expect(result.findings.resets).toBeGreaterThan(0);
		expect(result.anomalies.some((a) => a.includes('silent reset'))).toBe(true);
		expect(diff).toEqual([]);
		expect(result.restore.verified).toBe(true);
	});

	test('a disconnect mid-probe stops it; restoring fails and says so', async () => {
		const backups: unknown[] = [];
		const { result, fake } = await probe(
			{ protocol: walkplay, truth: t, disconnectAtWrite: 20 },
			{ onBackup: (b) => backups.push(b) }
		);
		expect(result.aborted).toMatch(/gone/);
		expect(result.backup).not.toBeNull();
		expect(backups).toHaveLength(1);
		expect(result.restore).toMatchObject({ attempted: true, verified: false });
		expect(result.restore.error).toBeDefined();
		expect(fake.writes).toBeGreaterThanOrEqual(20);
	});

	test('stopping a probe restores the backup', async () => {
		const stop = new AbortController();
		const initial = Array.from({ length: 10 }, (_, i): Filter => ({
			type: 'PK',
			freq: 200 * (i + 1),
			q: 2,
			gain: i === 0 ? 0 : -i
		}));
		const { result, fake } = await probe(
			{ protocol: walkplay, truth: t, initial },
			{ signal: stop.signal, onProgress: (p) => p.writes >= 15 && stop.abort() }
		);
		expect(result.aborted).toBe('stopped by the user');
		expect(result.restore.verified).toBe(true);
		expect(fake.stored).toEqual(initial);
	});

	test('a restore the device doesn’t keep is reported', async () => {
		// The firmware drops gains above 6 dB to 6: the backup was set by something else.
		const initial = Array.from({ length: 10 }, (_, i): Filter => ({
			type: 'PK',
			freq: 200 * (i + 1),
			q: 2,
			gain: i === 3 ? 9 : 0
		}));
		const capped = truth({
			...t,
			band: { ...t.band, gain: { min: -6, max: 6, step: 0.00390625 } }
		});
		const { result } = await probe(
			{ protocol: walkplay, truth: capped, initial },
			{ mode: 'quick' }
		);
		expect(result.restore.verified).toBe(false);
		expect(result.restore.mismatches.join()).toMatch(/band 4/);
	});

	test('a device that keeps nothing is not probed further', async () => {
		const deaf = truth({
			bandCount: 10,
			band: {
				types: ['HPQ'],
				freq: { min: 20, max: 20000 },
				q: { min: 0.5, max: 1 },
				gain: { min: 0, max: 0 }
			}
		});
		const { result } = await probe({ protocol: walkplay, truth: deaf, outOfRange: 'reject' });
		expect(result.aborted).toMatch(/band count/);
		expect(result.restore.attempted).toBe(true);
	});
});

/** Frequency-partitioned: a low shelf at the bottom, a high shelf at the top. */
function partitioned(): Profile {
	return truth({
		bandCount: 8,
		band: {
			types: ['PK'],
			freq: { min: 20, max: 20000, step: 1 },
			q: { min: 0.25, max: 8, step: 0.00390625 },
			gain: { min: -12, max: 12, step: 0.5 }
		},
		bands: [
			{ index: 0, types: ['LSC'], freq: { min: 20, max: 300, step: 1 } },
			{ index: 7, types: ['HSC'], freq: { min: 2000, max: 16000, step: 1 } }
		]
	});
}

describe('hard cases (PLAN Phase 4)', () => {
	test('type- and frequency-partitioned, stepped', async () => {
		const { result, diff } = await probe({
			protocol: walkplay,
			truth: partitioned(),
			outOfRange: 'reject'
		});
		expect(diff).toEqual([]);
		expect(result.restore.verified).toBe(true);
	});

	test('type-partitioned on a float wire (JDS Labs Element IV)', async () => {
		const jds = data('jds-labs-element-iv');
		const { result, diff } = await probe({
			protocol: PROTOCOLS['jds-labs-element-iv']!,
			truth: jds,
			outOfRange: 'reject'
		});
		expect(result.findings.steps.gain).toEqual({ kind: 'continuous' });
		expect(diff).toEqual([]);
		expect(result.restore.verified).toBe(true);
	});

	test('graphic: one fixed frequency per band', async () => {
		const centres = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
		const graphic = truth({
			bandCount: 10,
			band: {
				types: ['PK'],
				freq: { value: 1000 },
				q: { value: 1.4140625 },
				gain: { min: -12, max: 12, step: 1 }
			},
			bands: centres.map((f, i) => ({ index: i, freq: { value: f } }))
		});
		const { result, diff } = await probe({ protocol: walkplay, truth: graphic });
		expect(diff).toEqual([]);
		expect(result.restore.verified).toBe(true);
	});

	test('a value set (Edifier-like frequency table) on a float wire', async () => {
		const table = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 16000];
		const set = truth({
			bandCount: 4,
			band: {
				types: ['PK'],
				freq: { values: table },
				q: { min: 0.5, max: 4 },
				gain: { min: -6, max: 6 }
			}
		});
		const nothing = PROTOCOLS['nothing-headphone-1']!;
		const { result, diff } = await probe({ protocol: nothing, truth: set });
		expect(result.findings.steps.freq).toEqual({ kind: 'irregular' });
		expect(diff).toEqual([]);
		expect(result.restore.verified).toBe(true);
	});

	test('conditional: boosts only between 200 Hz and 8 kHz', async () => {
		const conditional = truth({
			bandCount: 6,
			band: {
				types: ['PK'],
				freq: { min: 20, max: 20000, step: 1 },
				q: { min: 0.5, max: 5, step: 0.00390625 },
				gain: { min: -12, max: 12, step: 0.00390625 },
				variants: [{ when: { gain: { gt: 0 } }, freq: { min: 200, max: 8000, step: 1 } }]
			}
		});
		const { result, diff } = await probe({
			protocol: walkplay,
			truth: conditional,
			outOfRange: 'reject'
		});
		expect(diff).toEqual([]);
		expect(result.restore.verified).toBe(true);
	});

	test('bands must ascend: refused, or sorted by the device', async () => {
		const base = data('walkplay-schemeno16-devices');
		const ascending = Array.from({ length: 10 }, (_, i): Filter => ({
			type: 'PK',
			freq: 100 * (i + 1),
			q: 1,
			gain: 0
		}));
		// A device that sorts takes equal frequencies too: its rule is the non-strict one.
		for (const reorders of [false, true]) {
			const rule = { type: 'ascendingFrequency' as const, ...(reorders ? { strict: false } : {}) };
			const ordered = truth({ ...base, rules: [rule], preamp: { mode: 'unknown' } });
			const { result, diff } = await probe({
				protocol: walkplay,
				truth: ordered,
				initial: ascending,
				reorders
			});
			expect(result.findings.order).toMatchObject({
				rule: reorders ? 'reorders' : 'rejects',
				strict: !reorders
			});
			expect(diff).toEqual([]);
			expect(result.restore.verified).toBe(true);
		}
	});
});

describe('the probe finds the wire on a device that keeps whatever it is sent', () => {
	for (const id of [
		'fiio-k17',
		'ktmicro-chu-2',
		'moondrop-rays',
		'walkplay-schemeno11-devices',
		'tanchjim-rita'
	]) {
		const protocol = PROTOCOLS[id === 'ktmicro-chu-2' ? 'moondrop-chu-2-dsp' : id]!;
		test(`${id} (${protocol.handler})`, async () => {
			const analysis = analyzeCodec(protocol);
			const clip = (d: NonNullable<typeof analysis.gain>, l: { min: number; max: number }) =>
				'step' in d
					? {
							...d,
							min: Math.max(d.min, Math.ceil(l.min / d.step) * d.step),
							max: Math.min(d.max, Math.floor(l.max / d.step) * d.step)
						}
					: d;
			const lossless = truth({
				bandCount: analysis.bands.min === analysis.bands.max ? analysis.bands.max : 8,
				band: {
					types: analysis.types.filter((x) => !x.startsWith('x-')),
					freq: clip(analysis.freq!, { min: 1, max: 40000 }),
					q: clip(analysis.q!, { min: 0.01, max: 100 }),
					gain: clip(analysis.gain!, { min: -30, max: 30 })
				}
			});
			const { result, diff } = await probe({
				protocol: { ...protocol, disconnectOnSave: false },
				truth: lossless
			});
			expect(result.aborted).toBeUndefined();
			expect(diff).toEqual([]);
			expect(result.restore.verified).toBe(true);
		});
	}
});

test('every derived profile is a valid profile', async () => {
	const { result } = await probe({
		protocol: walkplay,
		truth: partitioned(),
		outOfRange: 'reject'
	});
	const derived = deriveConstraints(result, { analysis: analyzeCodec(walkplay) })!;
	const profile = truth(derived.constraints as Partial<Profile> as Profile);
	expect(validateProfile(profile)).toEqual([]);
});

describe('random firmware', () => {
	// Device grids are multiples of the wire's (Walkplay: 1/256 for gain and Q, 1 Hz).
	const steps = {
		gain: [0.00390625, 0.0625, 0.25, 0.5, 1],
		q: [0.00390625, 0.015625, 0.125],
		freq: [1, 2, 5]
	};
	const domain = (lo: number, hi: number, step: number) => ({
		min: Math.ceil(lo / step) * step,
		max: Math.floor(hi / step) * step,
		step
	});
	const firmware = fc.record({
		bands: fc.integer({ min: 1, max: 12 }),
		gainMax: fc.constantFrom(6, 10, 12, 15, 20, 24),
		gainStep: fc.constantFrom(...steps.gain),
		qMin: fc.constantFrom(0.1, 0.2, 0.25, 0.5),
		qMax: fc.constantFrom(5, 8, 10, 16, 20),
		qStep: fc.constantFrom(...steps.q),
		freqMin: fc.constantFrom(10, 20, 25),
		freqMax: fc.constantFrom(16000, 20000, 22000, 24000),
		freqStep: fc.constantFrom(...steps.freq),
		shelves: fc.boolean(),
		partitioned: fc.boolean(),
		boostWindow: fc.boolean(),
		outOfRange: fc.constantFrom('clamp' as const, 'reject' as const),
		failure: fc.constantFrom('none', 'whole', 'nak', 'reset')
	});
	test('a probe derives what the firmware accepts', async () => {
		await fc.assert(
			fc.asyncProperty(firmware, async (f) => {
				const band = {
					types: f.shelves ? (['PK', 'LSC', 'HSC'] as FilterType[]) : (['PK'] as FilterType[]),
					freq: domain(f.freqMin, f.freqMax, f.freqStep),
					q: domain(f.qMin, f.qMax, f.qStep),
					gain: domain(-f.gainMax, f.gainMax, f.gainStep),
					...(f.boostWindow
						? { variants: [{ when: { gain: { gt: 0 } }, freq: domain(100, 10000, f.freqStep) }] }
						: {})
				};
				const bands =
					f.partitioned && f.bands >= 3
						? [
								{
									index: 0,
									types: ['LSC'] as FilterType[],
									freq: domain(f.freqMin, 400, f.freqStep),
									variants: []
								},
								{
									index: f.bands - 1,
									types: ['HSC'] as FilterType[],
									freq: domain(2000, f.freqMax, f.freqStep),
									variants: []
								}
							]
						: undefined;
				const t = truth({ bandCount: f.bands, band, ...(bands ? { bands } : {}) });
				// The user's EQ, not the factory default a reset returns to.
				const initial = Array.from({ length: f.bands }, (_, i): Filter => {
					const slot = resolveSlot(t, i);
					return {
						type: slot.types[0]!,
						freq: project(777, slot.freq, 'freq'),
						q: project(1.7, slot.q, 'q'),
						gain: project(-1, slot.gain, 'gain')
					};
				});
				const { result, diff } = await probe({
					protocol: walkplay,
					truth: t,
					initial,
					outOfRange: f.outOfRange,
					wholeSet: f.failure === 'whole' || f.failure === 'nak',
					nak: f.failure === 'nak',
					resetOnInvalid: f.failure === 'reset'
				});
				expect(result.aborted).toBeUndefined();
				expect(diff).toEqual([]);
				expect(result.restore.verified).toBe(true);
				if (process.env.EQCAPS_PROBE_STATS) {
					console.log('STATS', f.failure, f.outOfRange, f.bands, result.writes);
				}
			}),
			{ numRuns: Number(process.env.EQCAPS_PROBE_RUNS ?? 40) }
		);
	}, 600_000);
});

test('the evidence file: one line per push, and only personal strings up for review', async () => {
	const t = data('walkplay-schemeno16-devices');
	const { result } = await probe({ protocol: walkplay, truth: t }, { mode: 'quick' });
	const analysis = analyzeCodec(walkplay);
	const report = probeEvidence({
		transport: 'hid',
		identity: { usb: { vendorId: '0x0104', productId: '0x011d', productName: "Alex's DAC" } },
		handler: 'walkplay-hid',
		experimental: false,
		profile: t.id,
		result,
		derivation: deriveConstraints(result, { analysis, profile: t }),
		commit: 'abc1234',
		date: '2026-10-03'
	});
	expect(report.backupRestored).toBe(true);
	expect(report.probe).toEqual({ mode: 'quick', writes: result.writes });
	expect(report.derivedProfile).toMatchObject({ bandCount: 10 });
	const text = evidenceText(report);
	expect(text).toMatch(/"filters": \[\["PK",\d+,[\d.]+,-?[\d.]+\],/);
	const fields = stringFields(report).map((f) => f.pointer);
	expect(fields).toContain('/device/productName');
	expect(fields.some((p) => p.includes('/pushes/'))).toBe(false);
	expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(report)));
});

describe('hardening (first runs on real devices)', () => {
	const t = data('walkplay-schemeno16-devices');

	test('a device that stores whatever it is sent: ranges kept from the profile, and said so', async () => {
		const analysis = analyzeCodec(walkplay);
		const clip = (
			d: { min: number; max: number; step: number },
			l: { min: number; max: number }
		) => ({
			min: Math.max(d.min, Math.ceil(l.min / d.step) * d.step),
			max: Math.min(d.max, Math.floor(l.max / d.step) * d.step),
			step: d.step
		});
		const echo = truth({
			bandCount: 10,
			band: {
				types: ['PK', 'LSC', 'HSC', 'LPQ', 'HPQ'],
				freq: clip(analysis.freq as never, { min: 1, max: 40000 }),
				q: clip(analysis.q as never, { min: 0.01, max: 100 }),
				gain: clip(analysis.gain as never, { min: -30, max: 30 })
			}
		});
		const fake = new FakeDevice({ protocol: walkplay, truth: echo });
		const result = await runProbe(fake, { mode: 'full', analysis, profile: t, ...quiet });
		const derived = deriveConstraints(result, { analysis, profile: t })!;
		expect(derived.unchecked).toBe(true);
		expect(derived.notes[0]).toMatch(/without checking it/);
		expect(derived.constraints.band.gain).toEqual(t.band.gain);
		expect(derived.constraints.band.freq).toEqual(t.band.freq);
		// One line per kind of note, not one per band.
		expect(derived.notes.filter((n) => n.includes('frequency in'))).toHaveLength(1);
		expect(derived.notes.join('\n')).toMatch(/in every band/);
		// No conditions made up from two windows that both reach the search limits.
		expect(derived.constraints.band.variants).toBeUndefined();
		expect(result.restore.verified).toBe(true);
	});

	test('writes over 8 bands change nothing: the count is what this protocol can write, and the restore fits', async () => {
		const initial = Array.from({ length: 10 }, (_, i): Filter => ({
			type: 'PK',
			freq: 100 * (i + 1),
			q: 0.75,
			gain: i % 3
		}));
		const { result, fake, notes } = await probe(
			{ protocol: walkplay, truth: t, initial, maxWriteBands: 8, phantomBands: 6 },
			{ mode: 'quick', profile: t }
		);
		expect(result.aborted).toBeUndefined();
		expect(result.findings.bandCount).toEqual({
			value: 8,
			atLeast: false,
			writeLimit: { kept: 8, refused: 9 }
		});
		expect(notes.join('\n')).toMatch(/writes of 9 bands or more changed nothing/);
		expect(result.restore.verified).toBe(true);
		expect(fake.stored).toEqual(initial);
	});

	test('reads that go unanswered now and then are retried, not fatal', async () => {
		const { result, diff } = await probe({ protocol: walkplay, truth: t, timeoutEvery: 9 });
		expect(result.aborted).toBeUndefined();
		expect(result.anomalies.some((a) => a.includes('unanswered'))).toBe(true);
		expect(diff).toEqual([]);
		expect(result.restore.verified).toBe(true);
	});

	test('differences are grouped by band', () => {
		const other = { ...t, band: { ...t.band, gain: { min: -6, max: 6, step: 0.5 } } } as Profile;
		expect(constraintDiff(t, other)).toEqual([
			'every band: gain −6 dB to +6 dB in 0.5 dB steps, not −10 dB to +10 dB in 0.00390625 dB steps'
		]);
	});
});
