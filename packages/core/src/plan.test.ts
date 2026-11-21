import { describe, expect, it } from 'vitest';
import { complete } from './complete.ts';
import { eqProfile } from './eqs.ts';
import type { Filter } from './filter.ts';
import { fit } from './fit.ts';
import { plan } from './plan.ts';
import type { Profile } from './types/schema.generated.ts';

const pk = (freq: number, gain: number, q = 1): Filter => ({ type: 'PK', freq, q, gain });

const profile = (extra: Partial<Profile> = {}): Profile => ({
	schemaVersion: '1.5',
	id: 'plan-test',
	kind: 'hardware',
	device: { brand: 'Example', model: 'Plan' },
	bandCount: 3,
	band: {
		types: ['PK'],
		freq: { min: 20, max: 20000 },
		q: { min: 0.1, max: 10, step: 0.01 },
		gain: { min: -12, max: 12, step: 0.1 }
	},
	preamp: { mode: 'manual', gain: { min: -12, max: 0, step: 0.5 } },
	meta: { status: 'draft', sources: [] },
	...extra
});

describe('plan (SPEC §13.10)', () => {
	it('is fit, then complete with what the engine holds as hints', () => {
		const p = profile();
		const held = { filters: [pk(60, 4, 0.7), pk(250, -1, 0.7), pk(8000, 2, 0.7)] };
		const wanted = { filters: [pk(1000, 3.04)], preamp: -3.2 };
		const r = plan(p, wanted, { writesPreamp: true, held });
		const fitted = fit(p, wanted.filters, wanted.preamp);
		expect(r.channels).toEqual([{ fit: fitted, warnings: [] }]);
		expect(r.write).toEqual({
			filters: complete(p, fitted.slots, { hints: held.filters }).filters,
			preamp: -3
		});
		// The slots the fit left empty keep the device's own frequencies and Qs, written flat.
		expect(r.write.filters.filter((f) => f.gain === 0).map((f) => f.freq)).toEqual([250, 8000]);
	});

	it('takes a device bridge pull and capabilities as they are, and gives a push request', () => {
		const pull = { filters: [pk(60, 4), null, null], preamp: -2, slot: 1 };
		const capabilities = { writesPreamp: true, perChannel: false, canRead: true };
		const r = plan(profile(), { filters: [pk(1000, 3)] }, { ...capabilities, held: pull });
		expect(Object.keys(r.write)).toEqual(['filters', 'preamp']);
		expect(r.write.filters).toHaveLength(3);
	});

	describe('the preamp', () => {
		const wanted = { filters: [pk(1000, 3)], preamp: -3.2 };
		const sent = (mode: Profile['preamp'], writesPreamp: boolean) =>
			plan(profile({ preamp: mode }), wanted, { writesPreamp });

		it('is sent fitted in manual mode, where the write carries one', () => {
			const r = sent({ mode: 'manual', gain: { min: -12, max: 0, step: 0.5 } }, true);
			expect(r.sendsPreamp).toBe(true);
			expect(r.write.preamp).toBe(-3);
		});

		it('is sent as wanted in unknown mode, where the write carries one', () => {
			const r = sent({ mode: 'unknown' }, true);
			expect(r.sendsPreamp).toBe(true);
			expect(r.write.preamp).toBe(-3.2);
		});

		it('is never sent in auto or none mode', () => {
			for (const mode of ['auto', 'none'] as const) {
				const r = sent({ mode }, true);
				expect(r.sendsPreamp).toBe(false);
				expect(r.write).not.toHaveProperty('preamp');
			}
		});

		it('is not sent where the write carries none, and the plan says so', () => {
			for (const writesPreamp of [false, undefined]) {
				const r = plan(profile(), wanted, { writesPreamp });
				expect(r.sendsPreamp).toBe(false);
				expect(r.write).not.toHaveProperty('preamp');
				// What the fit made of it is still there for the app to show.
				expect(r.channels[0]!.fit.preamp).toBe(-3);
			}
		});
	});

	describe('the right channel', () => {
		const independent = profile({ channels: 'independent' });
		const wanted = {
			filters: [pk(1000, 3)],
			preamp: -3,
			right: { filters: [pk(4000, -2), pk(100, 20)] }
		};

		it('is written apart where the EQ holds it apart and the write drives it apart', () => {
			const r = plan(independent, wanted, { writesPreamp: true, perChannel: true });
			expect(r.channels).toHaveLength(2);
			expect(r.write.filters.find((f) => f.gain !== 0)).toEqual(pk(1000, 3));
			expect(r.write.right!.filters.filter((f) => f.gain !== 0)).toEqual([
				pk(4000, -2),
				pk(100, 12)
			]);
			// Its preamp left out is the left's; its changes are its own.
			expect(r.write.right!.preamp).toBe(-3);
			expect(r.channels[0]!.fit.changes).toEqual([]);
			expect(r.channels[1]!.fit.changes.map((c) => c.field)).toEqual(['gain']);
		});

		it('takes its own hints, or the left`s where it was not read apart', () => {
			const left = [pk(60, 1), pk(250, 1), pk(8000, 1)];
			const right = [pk(80, 1), pk(300, 1), pk(9000, 1)];
			const flat = (held: { filters: Filter[]; right?: { filters: Filter[] } }) =>
				plan(independent, wanted, { perChannel: true, held })
					.write.right!.filters.filter((f) => f.gain === 0)
					.map((f) => f.freq);
			expect(flat({ filters: left, right: { filters: right } })).toEqual([9000]);
			expect(flat({ filters: left })).toEqual([8000]);
		});

		it('goes unwritten where the write drives both channels alike: the left is both`s', () => {
			const r = plan(independent, wanted, { writesPreamp: true });
			expect(r.channels).toHaveLength(1);
			expect(r.write).not.toHaveProperty('right');
		});

		it('goes unwritten on a linked EQ, whatever the write can do', () => {
			const r = plan(profile(), wanted, { perChannel: true });
			expect(r.channels).toHaveLength(1);
			expect(r.write).not.toHaveProperty('right');
		});

		it('is left out when both channels are wanted alike', () => {
			const r = plan(independent, { filters: wanted.filters }, { perChannel: true });
			expect(r.channels).toHaveLength(1);
			expect(r.write).not.toHaveProperty('right');
		});
	});

	it('plans a listed EQ on its own profile (SPEC §9.2)', () => {
		const device = profile({
			protocol: {
				handler: 'example',
				eqs: [{ id: 'spk', name: 'SPK EQ', bandCount: 5, channels: 'independent' }]
			}
		});
		const spk = eqProfile(device, 'spk')!;
		const r = plan(
			spk,
			{ filters: [pk(1000, 3)], right: { filters: [pk(2000, 1)] } },
			{ perChannel: true }
		);
		expect(r.write.filters).toHaveLength(5);
		expect(r.write.right!.filters).toHaveLength(5);
		expect(plan(device, { filters: [pk(1000, 3)] }).write.filters).toHaveLength(3);
	});

	it('gives only the filters for an unbounded EQ', () => {
		const r = plan(profile({ kind: 'software', bandCount: null }), {
			filters: [pk(1000, 3), pk(100, 0)]
		});
		expect(r.write.filters).toEqual([pk(1000, 3)]);
	});
});
