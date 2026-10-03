import { describe, expect, it } from 'vitest';
import {
	validateProfile,
	type Filter,
	type FilterType,
	type Profile
} from '@potatosalad775/eqcaps-core';
import { readEvidence, guidedSource, stringFields } from '../evidence.ts';
import { changes } from './changes.ts';
import { deriveConstraints } from './constraints.ts';
import { guidedEvidence } from './evidence.ts';
import { appValue, conclude, gcdOf, infer } from './infer.ts';
import { nextStep, plannedSteps, stepState } from './plan.ts';
import { readEntry } from './session.ts';
import type { Entry, GuidedContext, NumField, Snapshot, Step } from './types.ts';

// A Walkplay-like device: 8 bands; the wire carries gain and Q in 1/256 steps, freq in 1 Hz and
// the preamp in 1 dB. Its vendor app allows gain ±10 in 0.1 dB, freq 20–20000 Hz, Q 0.1–10 in
// 0.01, the types PK, LSC and HSC, and a preamp of −12–0 dB.
const WIRE = {
	gain: { min: -128, max: 127.99609375, step: 1 / 256 },
	q: { min: 1 / 256, max: 255.99609375, step: 1 / 256 },
	freq: { min: 1, max: 65534, step: 1 },
	preamp: { min: -128, max: 127, step: 1 }
};
const APP = {
	gain: { min: -10, max: 10, step: 0.1 },
	freq: { min: 20, max: 20000, step: 1 },
	q: { min: 0.1, max: 10, step: 0.01 },
	preamp: { min: -12, max: 0, step: 1 },
	types: ['PK', 'LSC', 'HSC'] as FilterType[]
};
const FREQS = [50, 200, 500, 1000, 2500, 5000, 10000, 15000];
const flat = (): Snapshot => ({
	filters: FREQS.map((freq) => ({ type: 'PK', freq, q: 0.75, gain: 0 })),
	preamp: -1
});

const ctx = (over: Partial<GuidedContext> = {}): GuidedContext => ({
	first: flat(),
	readsPreamp: true,
	hasQ: true,
	wire: WIRE,
	...over
});

/** What the device holds for what the app sends: rounded onto the wire grid. */
function wired(s: Snapshot): Snapshot {
	const r = (x: number, step: number) => Math.round(x / step) * step;
	return {
		filters: s.filters.map((f) =>
			f
				? { ...f, gain: r(f.gain, WIRE.gain.step), q: r(f.q, WIRE.q.step), freq: r(f.freq, 1) }
				: null
		),
		...(s.preamp !== undefined ? { preamp: r(s.preamp, 1) } : {})
	};
}

/** A user going through the steps against a simulated device. */
class User {
	entries: Entry[] = [];
	device: Snapshot;
	constructor(readonly ctx: GuidedContext) {
		this.device = structuredClone(ctx.first);
	}
	get step(): Step | undefined {
		return nextStep(this.ctx, this.entries);
	}
	set(band: number | undefined, field: NumField | 'type', value: number | string) {
		if (field === 'preamp') this.device.preamp = value as number;
		else Object.assign(this.device.filters[band! - 1]!, { [field]: value });
	}
	read(opts: { typed?: number; already?: boolean } = {}, step = this.step!) {
		this.entries.push(readEntry(this.ctx, this.entries, step, wired(this.device), opts));
		return this.entries[this.entries.length - 1]!;
	}
	skip(step = this.step!) {
		this.entries.push({ kind: 'skip', step });
	}
	done(step = this.step!) {
		this.entries.push({ kind: 'done', step });
	}
	/** Does what the step asks, as the vendor app allows, then reads. */
	answer(app = APP, bands = 8) {
		const s = this.step!;
		const field = s.field as NumField;
		switch (s.ask) {
			case 'count':
				return this.read({ typed: bands });
			case 'max':
			case 'min':
				this.set(s.band, field, app[field][s.ask]);
				return this.read();
			case 'step': {
				const at =
					field === 'preamp' ? this.device.preamp! : this.device.filters[s.band! - 1]![field];
				const lim = app[field];
				this.set(s.band, field, at + lim.step <= lim.max ? at + lim.step : at - lim.step);
				return this.read();
			}
			case 'each': {
				const band = this.device.filters[s.band! - 1]!;
				const seen = this.entries
					.filter((e) => e.step.id === s.id && e.kind === 'read')
					.map((e) => (e.kind === 'read' ? e.read.filters[s.band! - 1]?.type : undefined));
				if (!seen.includes(band.type)) return this.read();
				const next = app.types.find((t) => !seen.includes(t));
				if (!next) return this.done();
				band.type = next;
				return this.read();
			}
			case 'value': {
				const typed = { gain: 3.3, freq: 1234, q: 2.57 }[field as 'gain' | 'freq' | 'q'];
				this.set(s.band, field, typed);
				return this.read({ typed });
			}
			case 'restore':
				this.device = structuredClone(this.ctx.first);
				return this.read();
		}
	}
	/** Answers every step; returns how many entries it took. */
	finish(app = APP, bands = 8) {
		for (let i = 0; this.step && i < 200; i++) this.answer(app, bands);
		expect(this.step).toBeUndefined();
	}
}

const base: Profile = {
	schemaVersion: '1.0',
	id: 'walkplay-like',
	kind: 'hardware',
	device: { brand: 'Example', model: 'Walkplay-like' },
	match: { usb: [{ vendorId: '0x3302', productId: '0xc20f' }] },
	bandCount: 8,
	band: {
		types: ['PK', 'LSC', 'HSC'],
		freq: { min: 20, max: 20000, step: 1 },
		q: { min: 0.1, max: 10, step: 0.01 },
		gain: { min: -12, max: 12, step: 0.5 }
	},
	preamp: { mode: 'manual', gain: { min: -12, max: 0, step: 1 } },
	meta: {
		status: 'draft',
		sources: [{ kind: 'community', ref: 'test profile', date: '2026-10-03' }]
	}
};

describe('changes', () => {
	it('reports every field that changed, bands turning off, and the preamp', () => {
		const a = flat();
		const b = flat();
		b.filters[0] = { ...b.filters[0]!, gain: 3 };
		b.filters[3] = null;
		b.preamp = 0;
		expect(changes(a, b)).toEqual([
			{ band: 1, field: 'gain', from: 0, to: 3 },
			{ band: 4, field: 'filter', from: 'on', to: 'off' },
			{ field: 'preamp', from: -1, to: 0 }
		]);
		expect(changes(a, flat())).toEqual([]);
	});
});

describe('appValue and gcdOf', () => {
	it('recovers the value the app sent from the wire’s rounding of it', () => {
		expect(appValue(0.1015625, 1 / 256)).toBe(0.1);
		expect(appValue(-9.8984375, 1 / 256)).toBe(-9.9);
		expect(appValue(3, 1 / 256)).toBe(3);
		expect(appValue(0.123456)).toBe(0.123456);
	});

	it('computes a GCD of decimals exactly', () => {
		expect(gcdOf([0.3, 0.1])).toBe(0.1);
		expect(gcdOf([0.2, 0.1, 10])).toBe(0.1);
		expect(gcdOf([2, 3])).toBe(1);
	});
});

describe('the planner', () => {
	it('asks for the band count first, and nothing else until it knows it', () => {
		expect(plannedSteps(ctx(), []).map((s) => s.id)).toEqual(['bands']);
	});

	it('asks about band 1 with steps, then the last band, then the preamp, grid checks and restore', () => {
		const u = new User(ctx());
		u.answer();
		const ids = plannedSteps(u.ctx, u.entries).map((s) => s.id);
		expect(ids.slice(0, 11)).toEqual([
			'bands',
			'gain-max-1',
			'gain-min-1',
			'gain-step-1',
			'freq-min-1',
			'freq-max-1',
			'freq-step-1',
			'q-min-1',
			'q-max-1',
			'q-step-1',
			'type-each-1'
		]);
		expect(ids).toContain('gain-max-8');
		expect(ids).not.toContain('gain-step-8');
		expect(ids.some((id) => id.endsWith('-4'))).toBe(false);
		expect(ids.slice(-7)).toEqual([
			'preamp-max',
			'preamp-min',
			'preamp-step',
			'gain-value-1',
			'freq-value-1',
			'q-value-1',
			'restore'
		]);
	});

	it('leaves out Q without a Q field, and the preamp when the protocol reads none', () => {
		const c = ctx({ hasQ: false, readsPreamp: false });
		const u = new User(c);
		u.answer();
		const ids = plannedSteps(c, u.entries).map((s) => s.id);
		expect(ids.some((id) => id.startsWith('q-') || id.startsWith('preamp-'))).toBe(false);
	});

	it('asks about the bands between only for the field where the first and last disagree', () => {
		// Band 8 is a high shelf whose frequency the app limits to 1–20 kHz.
		const u = new User(ctx());
		for (let i = 0; i < 200 && u.step; i++) {
			const s = u.step;
			if (s.id === 'freq-min-8') {
				u.set(8, 'freq', 1000);
				u.read();
			} else if (s.id.startsWith('freq-min-') && s.band! > 1 && s.band! < 8) {
				u.set(s.band, 'freq', 20);
				u.read();
			} else u.answer();
		}
		const ids = u.entries.map((e) => e.step.id);
		expect(ids).toContain('freq-min-4');
		expect(ids).toContain('freq-max-4');
		expect(ids).not.toContain('gain-max-4');
		const d = deriveConstraints(infer(u.ctx, u.entries), u.ctx, base, []);
		expect(d.constraints.bands).toEqual([{ index: 7, freq: { min: 1000, max: 20000, step: 1 } }]);
	});
});

describe('a guided read', () => {
	it('finds the vendor app’s limits through the wire’s rounding', () => {
		const u = new User(ctx());
		u.finish();
		const inf = infer(u.ctx, u.entries);
		expect(inf.bandCount).toBe(8);
		expect(inf.bands.get(1)).toEqual({
			gain: { min: -10, max: 10, step: 0.1 },
			freq: { min: 20, max: 20000, step: 1 },
			q: { min: 0.1, max: 10, step: 0.01 },
			types: ['PK', 'LSC', 'HSC']
		});
		expect(inf.preamp).toEqual({ min: -12, max: 0, step: 1 });
		expect(inf.checks.every((c) => c.ok)).toBe(true);
		expect(inf.restored).toBe(true);
		expect(inf.notes).toEqual([]);

		const d = deriveConstraints(inf, u.ctx, base, []);
		expect(d.constraints).toEqual({
			bandCount: 8,
			band: {
				types: ['PK', 'LSC', 'HSC'],
				freq: { min: 20, max: 20000, step: 1 },
				q: { min: 0.1, max: 10, step: 0.01 },
				gain: { min: -10, max: 10, step: 0.1 }
			},
			preamp: { mode: 'manual', gain: { min: -12, max: 0, step: 1 } }
		});
		expect(d.notes).toEqual(['Bands 2–7 not checked: assumed to match band 1.']);
		expect(validateProfile({ ...base, ...d.constraints })).toEqual([]);
	});

	it('asks again when nothing changed: the user forgot to save', () => {
		const u = new User(ctx());
		u.answer();
		const e = u.read(); // gain-max-1, but nothing was set
		expect(e.kind === 'read' && conclude(e, u.ctx).problem).toMatch(/Nothing changed/);
		expect(u.step!.id).toBe('gain-max-1');
		u.set(1, 'gain', 10);
		u.read();
		expect(u.step!.id).toBe('gain-min-1');
	});

	it('says so when the user set the wrong band, and keeps the step open', () => {
		const u = new User(ctx());
		u.answer();
		u.set(2, 'gain', 10);
		const e = u.read();
		expect(e.kind === 'read' && conclude(e, u.ctx).problem).toBe(
			"Changed: band 2 gain 0 → 10. This step asks for band 1's gain."
		);
		expect(stepState(e.step, u.entries, u.ctx)).toBe('open');
	});

	it('takes a value that already was at the extreme when the user says so', () => {
		const u = new User(
			ctx({ first: { ...flat(), filters: flat().filters.map((f) => ({ ...f!, q: 10 })) } })
		);
		u.answer();
		u.answer(); // gain max
		u.answer(); // gain min
		u.answer(); // gain step
		u.answer(); // freq min
		u.answer(); // freq max
		u.answer(); // freq step
		u.answer(); // q min
		expect(u.step!.id).toBe('q-max-1');
		u.set(1, 'q', 10); // already 10: no change
		u.read({ already: true });
		expect(u.step!.id).toBe('q-step-1');
	});

	it('fills a skipped field from the matched profile, and says so', () => {
		const u = new User(ctx());
		for (let i = 0; i < 200 && u.step; i++) {
			if (u.step.field === 'gain' && u.step.ask !== 'value') u.skip();
			else u.answer();
		}
		const d = deriveConstraints(infer(u.ctx, u.entries), u.ctx, base, []);
		expect(d.constraints.band.gain).toEqual(base.band!.gain);
		expect(d.notes).toContain('Band 1 gain not checked: from walkplay-like.');
	});

	it('without a profile, fills a skipped field from the wire limits', () => {
		const u = new User(ctx());
		for (let i = 0; i < 200 && u.step; i++) {
			if (u.step.field === 'q' && u.step.ask !== 'value') u.skip();
			else u.answer();
		}
		const d = deriveConstraints(infer(u.ctx, u.entries), u.ctx, null, ['PK', 'LSC', 'HSC']);
		expect(d.constraints.band.q).toEqual(WIRE.q);
		expect(d.notes).toContain('Band 1 Q not checked: from the protocol’s wire limits.');
	});

	it('corrects a step read across two notches by the GCD of the values read', () => {
		const u = new User(ctx());
		for (let i = 0; i < 200 && u.step; i++) {
			if (u.step.id === 'gain-step-1') {
				u.set(1, 'gain', -9.8); // two notches
				u.read();
				u.set(1, 'gain', -9.7); // and the user moves on: a value one notch off
			} else u.answer();
		}
		const inf = infer(u.ctx, u.entries);
		expect(inf.bands.get(1)!.gain.step).toBe(0.1);
		expect(inf.notes[0]).toMatch(/one step read as 0\.2/);
	});

	it('notes an EQ that wasn’t put back, and a typed value the device holds differently', () => {
		const u = new User(ctx());
		for (let i = 0; i < 200 && u.step; i++) {
			if (u.step.id === 'restore') u.read();
			else if (u.step.id === 'gain-value-1') {
				u.set(1, 'gain', 3.5); // the app rounded 3.3 to its 0.5 grid
				u.read({ typed: 3.3 });
			} else u.answer();
		}
		const inf = infer(u.ctx, u.entries);
		expect(inf.restored).toBe(false);
		expect(inf.notes).toContain("Typed 3.3 into the app's band 1 gain; the device holds 3.5.");
		expect(inf.notes).toContain('The EQ at the end differs from the EQ at the start.');
	});

	it('records a redone step as a new experiment, the last one counting', () => {
		const u = new User(ctx());
		u.answer();
		u.set(1, 'gain', 9);
		const max = u.read().step;
		u.set(1, 'gain', 10);
		u.read({}, max);
		expect(infer(u.ctx, u.entries).bands.get(1)!.gain.max).toBe(10);
	});
});

describe('the evidence file', () => {
	it('records every step with its instruction, full read-back, changes and conclusion', () => {
		const u = new User(ctx());
		u.finish();
		const inf = infer(u.ctx, u.entries);
		const derived = deriveConstraints(inf, u.ctx, base, []);
		const first = readEvidence({
			transport: 'hid',
			identity: { usb: { vendorId: '0x3302', productId: '0xc20f', productName: 'Protocol Micro' } },
			handler: 'walkplay-hid',
			experimental: false,
			profile: 'walkplay-like',
			pull: u.ctx.first as { filters: (Filter | null)[]; preamp: number },
			findings: [],
			commit: 'abc1234',
			date: '2026-10-03'
		});
		const report = guidedEvidence({
			first,
			vendorApp: { name: 'Walkplay EQ web app', platform: 'web' },
			ctx: u.ctx,
			entries: u.entries,
			inference: inf,
			derived
		});
		expect(report.experiments[0]!.id).toBe('read');
		const gainMax = report.experiments.find((e) => e.id === 'gain-max-1')!;
		expect(gainMax).toMatchObject({
			instruction: "In the vendor app, set band 1's gain as high as it goes.",
			band: 1,
			field: 'gain',
			ask: 'max',
			changed: [{ band: 1, field: 'gain', from: 0, to: 10 }],
			conclusion: { band: 1, field: 'gain', max: 10 }
		});
		expect(gainMax.readBack!.filters).toHaveLength(8);
		expect(report.experiments.some((e) => 'done' in e && e.done)).toBe(true);
		expect(report.constraints).toEqual(derived.constraints);
		expect(report.notChecked!.length).toBeGreaterThan(0);
		// The review lists what the user or the device wrote, not the app's own text.
		expect(stringFields(report).map((f) => f.pointer)).toEqual([
			'/tool/name',
			'/tool/commit',
			'/device/transport',
			'/device/vendorId',
			'/device/productId',
			'/device/productName',
			'/handler',
			'/profile',
			'/date',
			'/vendorApp/name',
			'/vendorApp/platform',
			...report.experiments.map((_, i) => `/experiments/${i}/id`)
		]);
	});

	it('is cited as vendor-app evidence', () => {
		expect(guidedSource('evidence/x/2026-10-03-abcdef.json', '2026-10-03', 'someone')).toEqual({
			kind: 'vendor-app',
			ref: 'evidence/x/2026-10-03-abcdef.json',
			date: '2026-10-03',
			by: 'someone'
		});
	});
});
