// The probe engine (T3, INSPECTOR §3): push → pull experiments that learn what a device accepts
// from its own behaviour. It backs up the EQ, runs the experiments, and always tries to restore
// the backup and confirm it by reading back, whatever happened in between.
//
// Writes are kept few by testing every slot at once: each push carries one test value per slot.
// Each slot also toggles a "canary" field (gain or Q) between two values it is known to accept,
// so a push that changed nothing at all is told apart from one whose test values were all
// refused: a device that rejects the whole write for one bad band is then probed slot by slot
// (INSPECTOR §3.5). Untested fields that change unasked are reported as possible silent resets.

import {
	resolveSlot,
	usesGain,
	type Filter,
	type FilterType,
	type Profile,
	type When
} from '@potatosalad775/eqcaps-core';
import {
	isBridgeError,
	type CodecAnalysis,
	type DeviceCapabilities,
	type PullResult,
	type WireField
} from '@potatosalad775/eqcaps-device-bridge';
import { inferStep, isLog, LIMITS, midpoint, NICE, snap, type Pair } from './infer.ts';
import { bandsToTry, estimateWrites, experimentsFor } from './plan.ts';
import type {
	Backup,
	Bound,
	ExperimentId,
	ExperimentRecord,
	FieldFinding,
	Findings,
	ProbeIO,
	ProbeMode,
	ProbeProgress,
	ProbeResult,
	PushRecord,
	RestoreResult
} from './types.ts';

export interface ProbeOptions {
	mode: ProbeMode;
	/** The protocol's codec analysis (`analyzeCodec`): wire grids, types, band counts. */
	analysis: CodecAnalysis;
	/**
	 * The profile the device matched, if any. Its band count bounds the band-count experiment, and
	 * its bounds are tried first, so a right profile is confirmed in a few writes.
	 */
	profile?: Profile;
	/** Preset slot to probe, where the protocol reads and writes a chosen one (`targetSlot`). */
	slot?: number;
	/** Most bands the band-count experiment writes. Default 64. */
	maxBands?: number;
	/** Least time between two writes, in ms (INSPECTOR §3.4). Default 100. */
	interval?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** Aborting stops the experiments; the backup is still restored. */
	signal?: AbortSignal;
	onProgress?: (progress: ProbeProgress) => void;
	/** Called with the backup as soon as it is read, before the first write. */
	onBackup?: (backup: Backup) => void;
}

type Field = 'type' | 'freq' | 'q' | 'gain';
type NumField = 'freq' | 'q' | 'gain';

/** What one slot writes in a trial: a whole filter, and the fields the test sets. */
interface Test {
	filter: Filter;
	fixed: readonly Field[];
}

interface Outcome {
	sent: Filter;
	stored: Filter | null;
	prev: Filter | null;
	/** An untested field changed, or the band went off. */
	anomaly?: string;
	/** The write looked like a silent reset: treat the test value as not kept. */
	reset?: boolean;
	/**
	 * Whether the band's canary landed, i.e. the device took the band (with whatever it made of
	 * the test value). Undefined when the band had no canary to tell.
	 */
	landed?: boolean;
}

interface TrialResult {
	outcomes: Map<number, Outcome>;
	preamp?: { sent: number; stored: number | undefined; prev: number | undefined };
	/** Nothing in the write landed: the device refused it whole (or said so). */
	refusedWhole: boolean;
	/** The write looked like a silent reset. */
	reset?: boolean;
}

/** A bound search for one field of one slot (or the preamp), one direction. */
interface Search {
	dir: 1 | -1;
	/** Furthest value known to be kept. */
	inner: number;
	/** Nearest value known to be refused. */
	outer?: number;
	hint?: number;
	phase: 'hint' | 'hint-next' | 'limit' | 'nice' | 'grid';
	steppedOnce: boolean;
	rounds: number;
	/** Wire values already sent: one the device snapped back onto `inner` says nothing twice. */
	tried: number[];
	done?: Bound;
	/** The value sent in the current round. */
	pending?: number;
}

export class ProbeError extends Error {}
class Aborted extends Error {}

const BASE_GAIN = -2;
const ALT_GAIN = -3;
const MAX_ROUNDS = 40;
const CODE_GAINS = [-1, -2, -3, -4];
/** Off any grid a device might use, with enough decimals that a float field shows as one. */
const GAIN_STEP_VALUES = [
	0.1337, -0.3719, 0.4913, -1.1371, 0.2609, -2.3743, 1.7111, -0.6229, 0.0131, -3.1416
];
/** Around a band's base: close for frequency (windows may be partitioned), wider for Q. */
const RELATIVE_STEP_VALUES = {
	freq: [1.0037, 1.0213, 0.9871, 1.0291, 0.9717, 1.0143, 0.9913, 1.0061],
	q: [1.0137, 1.1213, 0.9071, 1.2291, 0.8317, 1.0643, 0.9513, 1.3061]
};
/** Where in each window (log scale for Q and frequency) `verifyGrid` tests. */
const SPREAD = [0.2317, 0.7123];
const PREAMP_STEP_VALUES = [-0.1337, -0.3719, -1.1371, -0.4913, -2.3743, -0.2609];

const same = (a: number | undefined, b: number | undefined) =>
	a !== undefined &&
	b !== undefined &&
	Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tidy = (x: number) => Number(x.toPrecision(12));

export function runProbe(io: ProbeIO, options: ProbeOptions): Promise<ProbeResult> {
	return new Probe(io, options).run();
}

class Probe {
	private readonly caps: DeviceCapabilities;
	private readonly experiments: ExperimentRecord[] = [];
	private current: ExperimentRecord | null = null;
	private readonly anomalies: string[] = [];
	private readonly findings: Findings = { steps: {}, slots: [], wholeSet: false, resets: 0 };
	private writes = 0;
	private planned = 0;
	private lastWrite = -Infinity;
	/** Bands every write carries, once known. */
	private K = 0;
	/** What each slot writes when it isn't tested: values it is known to keep. */
	private base: Filter[] = [];
	/** What each slot held at the last read. */
	private state: (Filter | null)[] = [];
	private preampState: number | undefined;
	/** Two values each slot keeps, per canary field. */
	private canary: { gain?: [number, number]; q?: [number, number] }[] = [];
	/** Slot by slot: the device refuses a write whole for one bad band. */
	private serial = false;
	/** The device was seen to refuse bands one by one: no need to check again. */
	private perBand = false;
	/** Device grid per field, once inferred. */
	private readonly steps: Partial<Record<NumField | 'preamp', number>> = {};
	/** What the step experiments saw, kept for re-checking the grid later. */
	private readonly pairs: Partial<Record<NumField, Pair[]>> = {};
	private backup: Backup | null = null;
	/** The band count is exact as far as reads go: the device reports it, or reads past it fail. */
	private readBounded = false;

	constructor(
		private readonly io: ProbeIO,
		private readonly o: ProbeOptions
	) {
		this.caps = io.capabilities;
	}

	private get sleep() {
		return this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	}
	private now() {
		return this.o.now?.() ?? Date.now();
	}

	async run(): Promise<ProbeResult> {
		const ids = experimentsFor(this.o.mode, this.caps, this.o.analysis);
		let aborted: string | undefined;
		let restore: RestoreResult = { attempted: false, verified: false, mismatches: [] };
		try {
			await this.experiment('backup', () => this.readBackup());
			this.planned = estimateWrites(ids, this.backup?.filters.length ?? 10, this.o.analysis);
			for (const id of ids) await this.experiment(id, () => this.dispatch(id));
		} catch (e) {
			aborted = e instanceof Aborted ? 'stopped by the user' : message(e);
			if (this.current) this.current.conclusion.error = aborted;
		} finally {
			if (this.backup && this.writes > 0) {
				restore = await this.experiment('restore', () => this.restore()).catch(
					(e): RestoreResult => ({
						attempted: true,
						verified: false,
						mismatches: [],
						error: message(e)
					})
				);
			} else if (this.backup) {
				restore = { attempted: false, verified: true, mismatches: [] };
			}
		}
		return {
			mode: this.o.mode,
			backup: this.backup,
			restore,
			experiments: this.experiments,
			findings: this.findings,
			writes: this.writes,
			...(aborted ? { aborted } : {}),
			anomalies: this.anomalies
		};
	}

	private async experiment<T>(id: ExperimentId, body: () => Promise<T>): Promise<T> {
		const record: ExperimentRecord = { id, pushes: [], conclusion: {} };
		this.experiments.push(record);
		this.current = record;
		this.progress(`Running ${id}`);
		return body();
	}

	private async dispatch(id: ExperimentId): Promise<void> {
		if (id !== 'band-count' && id !== 'settle') await this.resettle();
		switch (id) {
			case 'band-count':
				return this.bandCount();
			case 'settle':
				return this.settle();
			case 'gain-step':
			case 'q-step':
			case 'freq-step':
				return this.stepExperiment(id.slice(0, -5) as NumField);
			case 'gain-range':
			case 'q-range':
			case 'freq-range':
				return this.rangeExperiment(id.slice(0, -6) as NumField);
			case 'types':
				return this.typesExperiment();
			case 'conditions':
				return this.conditionsExperiment();
			case 'order':
				return this.orderExperiment();
			case 'preamp':
				return this.preampExperiment();
			default:
				return;
		}
	}

	private progress(text: string) {
		this.o.onProgress?.({
			experiment: this.current?.id ?? 'backup',
			writes: this.writes,
			planned: Math.max(this.planned, this.writes),
			message: text
		});
	}

	private conclude(values: Record<string, unknown>) {
		if (this.current) Object.assign(this.current.conclusion, values);
	}

	private note(text: string) {
		this.anomalies.push(text);
		const last = this.current?.pushes.at(-1);
		if (last) last.note = last.note ? `${last.note}; ${text}` : text;
	}

	// --- I/O -------------------------------------------------------------------------------------

	private checkAbort() {
		if (this.o.signal?.aborted) throw new Aborted();
	}

	private slotRequest() {
		return this.o.slot !== undefined ? { slot: this.o.slot } : {};
	}

	private async pull(bands: number, retry = true): Promise<PullResult> {
		const request = {
			...(this.caps.needsBandCount ? { bands } : {}),
			...(this.caps.readsSlot ? this.slotRequest() : {})
		};
		try {
			return await this.io.pull(request);
		} catch (e) {
			// One retry for a slow answer; a gone device fails again at once.
			if (!retry || !isBridgeError(e, 'timeout')) throw e;
			await this.sleep(500);
			return this.io.pull(request);
		}
	}

	/**
	 * Pushes `filters` (and `preamp`), waiting out the write interval, then reads back. A device
	 * that refuses the write with an error still gets read back. Values the codec refuses are
	 * never sent: the read-back is then the state before.
	 */
	private async write(
		filters: Filter[],
		preamp?: number
	): Promise<{ back: PullResult; refused: boolean }> {
		this.checkAbort();
		const wait = this.lastWrite + (this.o.interval ?? 100) - this.now();
		if (wait > 0) await this.sleep(wait);
		this.checkAbort();
		const started = this.now();
		const record: PushRecord = {
			sent: {
				filters: filters.map((f) => ({ ...f })),
				...(preamp !== undefined ? { preamp } : {})
			},
			ms: 0
		};
		this.current?.pushes.push(record);
		let refused = false;
		try {
			await this.io.push({
				filters,
				...(preamp !== undefined ? { preamp } : {}),
				...(this.caps.writesSlot ? this.slotRequest() : {})
			});
			this.writes++;
		} catch (e) {
			if (isBridgeError(e, 'rejected')) {
				this.writes++;
				refused = true;
				record.note = 'refused by the device';
			} else if (
				isBridgeError(e, 'unrepresentable') ||
				isBridgeError(e, 'unsupported-type') ||
				isBridgeError(e, 'invalid-request')
			) {
				record.note = `not sent: ${message(e)}`;
				const back: PullResult = {
					filters: [...this.state],
					...(this.preampState !== undefined ? { preamp: this.preampState } : {})
				};
				return { back, refused: true };
			} else {
				record.note = `failed: ${message(e)}`;
				throw e;
			}
		} finally {
			this.lastWrite = this.now();
			this.progress(`Write ${this.writes}`);
		}
		const back = await this.pull(this.K);
		record.readBack = {
			filters: back.filters.map((f) => (f ? { ...f } : null)),
			...(back.preamp !== undefined ? { preamp: back.preamp } : {})
		};
		record.ms = this.now() - started;
		return { back, refused };
	}

	// --- Wire values -----------------------------------------------------------------------------

	private wireOf(
		field: NumField | 'preamp'
	): WireField | { values: readonly number[] } | undefined {
		const w = this.o.analysis.wire;
		return field === 'preamp' ? w.preamp : w[field];
	}

	/** What the wire carries for `v`: its grid point, or the nearest listed value. */
	private onWire(field: NumField | 'preamp', v: number): number {
		const w = this.wireOf(field);
		if (!w) return v;
		if ('values' in w) {
			return w.values.reduce((best, x) =>
				Math.abs(Math.log(x / v)) < Math.abs(Math.log(best / v)) ? x : best
			);
		}
		const c = Math.min(Math.max(v, w.min), w.max);
		return w.step ? Math.min(Math.max(snap(c, w.step), w.min), w.max) : c;
	}

	private wireStep(field: NumField | 'preamp'): number | undefined {
		const w = this.wireOf(field);
		return w && !('values' in w) ? w.step : undefined;
	}

	/** The finest difference that means something for `field`: the device's grid, else the wire's. */
	private resolution(field: NumField | 'preamp'): number | undefined {
		return this.steps[field] ?? this.wireStep(field);
	}

	/** `stored` is `sent`, give or take the device's own rounding. */
	private kept(field: NumField | 'preamp', sent: number, stored: number): boolean {
		const r = this.resolution(field);
		if (same(sent, stored)) return true;
		return r !== undefined && Math.abs(sent - stored) <= r / 2 + 1e-9 * Math.max(1, Math.abs(sent));
	}

	private limit(field: NumField | 'preamp', dir: 1 | -1): number {
		const l = LIMITS[field];
		const w = this.wireOf(field);
		if (!w) return dir > 0 ? l.max : l.min;
		const { min, max } =
			'values' in w ? { min: w.values[0]!, max: w.values.at(-1)! } : { min: w.min, max: w.max };
		return dir > 0 ? Math.min(l.max, max) : Math.max(l.min, min);
	}

	// --- Trials ----------------------------------------------------------------------------------

	private canaryField(s: number, f: Filter, fixed: readonly Field[]): 'gain' | 'q' | null {
		const c = this.canary[s];
		if (!c) return null;
		if (c.gain && usesGain(f.type) && !fixed.includes('gain')) return 'gain';
		if (c.q && !fixed.includes('q')) return 'q';
		return null;
	}

	/** Fields of `stored` that differ from `sent`, other than `skip`. */
	private unexpected(sent: Filter, stored: Filter | null, skip: readonly (Field | null)[]) {
		if (!stored)
			return sent.gain !== 0 || !usesGain(sent.type) ? 'the band read back as off' : undefined;
		const changed: string[] = [];
		if (!skip.includes('type') && stored.type !== sent.type) changed.push(`type ${stored.type}`);
		for (const f of ['freq', 'q', 'gain'] as const) {
			if (skip.includes(f)) continue;
			if (f === 'gain' && !usesGain(sent.type)) continue;
			if (!this.kept(f, sent[f], stored[f])) changed.push(`${f} ${stored[f]}`);
		}
		return changed.length ? `read back ${changed.join(', ')}` : undefined;
	}

	/**
	 * One push testing `tests` (slot → test) in parallel, with every other slot at its base. When
	 * nothing in it landed, one more push leaves a slot out: if that slot's canary lands, the
	 * device refuses bands one by one and the first push stands; if not, it refuses whole writes,
	 * and this and every later trial runs slot by slot.
	 */
	private async trial(tests: Map<number, Test>, preamp?: number): Promise<TrialResult> {
		if (this.serial && tests.size > 1) return this.oneByOne(tests);
		const result = await this.trialOnce(tests, preamp);
		// A reset wipes every band: test them one by one to find which value caused it.
		if (result.reset && tests.size > 1) return this.oneByOne(tests);
		if (!result.refusedWhole || result.reset || tests.size < 2 || this.serial || this.perBand) {
			return result;
		}
		const rest = new Map(tests);
		rest.delete(tests.keys().next().value as number);
		const check = await this.trialOnce(rest, preamp);
		if (!check.refusedWhole) {
			this.perBand = true;
			return result;
		}
		this.serial = true;
		this.findings.wholeSet = true;
		this.note('the device refuses a whole write for one bad band: probing slot by slot');
		return this.oneByOne(tests);
	}

	private async oneByOne(tests: Map<number, Test>): Promise<TrialResult> {
		const outcomes = new Map<number, Outcome>();
		for (const [s, t] of tests) {
			const r = await this.trialOnce(new Map([[s, t]]));
			outcomes.set(s, r.outcomes.get(s)!);
		}
		return { outcomes, refusedWhole: false };
	}

	private async trialOnce(tests: Map<number, Test>, preamp?: number): Promise<TrialResult> {
		const filters: Filter[] = [];
		const canaries: ('gain' | 'q' | null)[] = [];
		for (let s = 0; s < this.K; s++) {
			const t = tests.get(s);
			const f = { ...(t?.filter ?? this.base[s]!) };
			const cf = this.canaryField(s, f, t?.fixed ?? []);
			if (cf) {
				// Whichever of the two values the band doesn't hold now, so it always shows.
				const [a, b] = this.canary[s]![cf]!;
				f[cf] = this.kept(cf, a, this.state[s]?.[cf] ?? NaN) ? b : a;
			}
			filters.push(f);
			canaries.push(cf);
		}
		const prevState = [...this.state];
		const prevPreamp = this.preampState;
		const { back, refused } = await this.write(filters, preamp);
		const outcomes = new Map<number, Outcome>();
		let informative = 0;
		let landed = 0;
		let odd = 0;
		for (let s = 0; s < this.K; s++) {
			const sent = filters[s]!;
			const stored = back.filters[s] ?? null;
			const prev = prevState[s] ?? null;
			const cf = canaries[s] ?? null;
			let took: boolean | undefined;
			if (cf && !same(prev?.[cf], sent[cf])) {
				informative++;
				took = !!stored && this.kept(cf, sent[cf], stored[cf]);
				if (took) landed++;
			}
			const t = tests.get(s);
			// A band that didn't change was refused, not tampered with.
			const unchanged = !!stored && !!prev && sameFilter(stored, prev);
			let anomaly = unchanged
				? undefined
				: this.unexpected(sent, stored, [...(t?.fixed ?? []), cf]);
			if (!unchanged && cf && stored && !took && !this.kept(cf, prev?.[cf] ?? NaN, stored[cf])) {
				anomaly = `${anomaly ? `${anomaly}, ` : 'read back '}${cf} ${stored[cf]}`;
			}
			// A field nobody asked to change did: on many bands at once, that's a reset.
			if (anomaly) odd++;
			outcomes.set(s, {
				sent,
				stored,
				prev,
				...(anomaly ? { anomaly } : {}),
				...(took !== undefined ? { landed: took } : {})
			});
		}
		this.state = back.filters.slice(0, this.K);
		if (back.preamp !== undefined) this.preampState = back.preamp;
		const reset = odd >= Math.min(2, this.K) && odd * 2 >= this.K;
		if (reset) {
			this.findings.resets++;
			this.note(`${odd} bands changed fields that weren't under test: possibly a silent reset`);
			for (const [s, o] of outcomes) if (tests.has(s)) o.reset = true;
		}
		const refusedWhole = refused || (informative > 0 && landed === 0 && tests.size > 0);
		return {
			outcomes,
			refusedWhole,
			...(reset ? { reset } : {}),
			...(preamp !== undefined
				? { preamp: { sent: this.onWire('preamp', preamp), stored: back.preamp, prev: prevPreamp } }
				: {})
		};
	}

	// --- Backup and restore ----------------------------------------------------------------------

	private async readBackup() {
		this.checkAbort();
		let back: PullResult;
		if (this.caps.needsBandCount) {
			const wanted = bandsToTry(this.o.analysis, this.o.profile, this.o.maxBands);
			back = await this.readable(wanted);
			this.readBounded = back.filters.length < wanted;
		} else {
			back = await this.pull(0);
			this.readBounded = true;
		}
		this.backup = {
			filters: back.filters.map((f) => (f ? { ...f } : null)),
			...(back.preamp !== undefined ? { preamp: back.preamp } : {}),
			...(back.slot !== undefined
				? { slot: back.slot }
				: this.o.slot !== undefined
					? { slot: this.o.slot }
					: {})
		};
		this.state = [...back.filters];
		this.preampState = back.preamp;
		this.o.onBackup?.(this.backup);
		this.conclude({
			bands: back.filters.length,
			...(back.preamp !== undefined ? { preamp: back.preamp } : {})
		});
	}

	/** The most bands (up to `wanted`) a band-by-band read answers. Reads only. */
	private async readable(wanted: number): Promise<PullResult> {
		// No retries here: a band that doesn't answer is how the search learns where reads end.
		try {
			return await this.pull(wanted, false);
		} catch (e) {
			if (!isBridgeError(e, 'timeout') && !isBridgeError(e, 'bad-response')) throw e;
		}
		let lo = 0;
		let hi = wanted;
		let best: PullResult | null = null;
		while (hi - lo > 1) {
			const mid = Math.floor((lo + hi) / 2);
			try {
				best = await this.pull(mid, false);
				lo = mid;
			} catch (e) {
				if (!isBridgeError(e, 'timeout') && !isBridgeError(e, 'bad-response')) throw e;
				hi = mid;
			}
		}
		if (!best) throw new ProbeError('the device answers no band read');
		return best;
	}

	private async restore(): Promise<RestoreResult> {
		const backup = this.backup!;
		const count = this.K || this.o.profile?.bandCount || this.caps.bands || backup.filters.length;
		const n = Math.min(count, backup.filters.length);
		const flat = (i: number): Filter => {
			const b = this.base[i];
			return b ? { ...b, gain: 0 } : { type: 'PK', freq: this.onWire('freq', 1000), q: 1, gain: 0 };
		};
		const filters = backup.filters.slice(0, n).map((f, i) => (f ? { ...f } : flat(i)));
		const preamp =
			this.caps.writesPreamp && backup.preamp !== undefined ? backup.preamp : undefined;
		const request = {
			filters,
			...(preamp !== undefined ? { preamp } : {}),
			...(this.caps.writesSlot ? this.slotRequest() : {})
		};
		this.current?.pushes.push({
			sent: { filters, ...(preamp !== undefined ? { preamp } : {}) },
			ms: 0
		});
		const started = this.now();
		try {
			await this.io.push(request);
		} catch {
			// One more try after a pause: a busy device may take the second.
			await this.sleep(500);
			await this.io.push(request);
		}
		this.writes++;
		const back = await this.pull(n);
		const record = this.current?.pushes.at(-1);
		if (record) {
			record.readBack = {
				filters: back.filters,
				...(back.preamp !== undefined ? { preamp: back.preamp } : {})
			};
			record.ms = this.now() - started;
		}
		const mismatches: string[] = [];
		for (let i = 0; i < n; i++) {
			const want = backup.filters[i] ?? null;
			const got = back.filters[i] ?? null;
			if (want === null) {
				if (got && usesGain(got.type) && !same(got.gain, 0))
					mismatches.push(`band ${i + 1}: was off, now ${filterText(got)}`);
				continue;
			}
			if (!got || !sameFilter(want, got)) {
				mismatches.push(
					`band ${i + 1}: was ${filterText(want)}, now ${got ? filterText(got) : 'off'}`
				);
			}
		}
		if (
			backup.preamp !== undefined &&
			back.preamp !== undefined &&
			!same(backup.preamp, back.preamp)
		) {
			mismatches.push(`preamp: was ${backup.preamp} dB, now ${back.preamp} dB`);
		}
		this.conclude({ verified: mismatches.length === 0, mismatches });
		return { attempted: true, verified: mismatches.length === 0, mismatches };
	}

	// --- Band count ------------------------------------------------------------------------------

	/** A band to mark slot `j` with: the backup's band where it has gain, else peaking at a spot of its own. */
	private markerBand(j: number, of: number): Filter {
		const b = this.backup?.filters[j];
		if (b && usesGain(b.type)) return { type: b.type, freq: b.freq, q: b.q, gain: b.gain };
		const freq = 100 * Math.pow(100, of > 1 ? j / (of - 1) : 0.5);
		const type = this.o.analysis.types.includes('PK')
			? 'PK'
			: (this.o.analysis.types[0] as FilterType);
		return { type, freq: this.onWire('freq', freq), q: this.onWire('q', 1.2), gain: 0 };
	}

	/**
	 * Pushes a code to every band (INSPECTOR §3.2 "slot count"): gains from −1 to −4 dB, one digit
	 * of the band's index per push, then one more push that changes every band. A band is there if
	 * it read back its own code every time; the count is the run of such bands from the first.
	 */
	private async bandCount() {
		const readable = this.backup!.filters.length;
		const codecMax = this.o.analysis.bands.max;
		const tries = [Math.min(readable, codecMax)];
		const hinted = this.o.profile?.bandCount ?? this.caps.bands;
		if (hinted && hinted < tries[0]!) tries.push(hinted);
		for (const n of tries) {
			if (n < this.o.analysis.bands.min) continue;
			const count = await this.countWith(n);
			if (count > 0) {
				const atLeast =
					count === n && n < codecMax && this.caps.bands === undefined && !this.readBounded;
				this.findings.bandCount = { value: count, atLeast };
				this.K = count;
				this.base = Array.from({ length: count }, (_, j) => ({
					...this.markerBand(j, count),
					gain: BASE_GAIN
				}));
				this.findings.slots = Array.from({ length: count }, () => ({}));
				this.state = this.state.slice(0, count);
				this.conclude({ bands: count, atLeast, written: n });
				return;
			}
		}
		throw new ProbeError('the device kept none of the test values, so its band count is unknown');
	}

	private async countWith(n: number): Promise<number> {
		this.K = n;
		const digits = Math.max(1, Math.ceil(Math.log(n) / Math.log(4)));
		const digit = (j: number, d: number) => Math.floor(j / Math.pow(4, d)) % 4;
		const codes: number[][] = Array.from({ length: n }, (_, j) => [
			...Array.from({ length: digits }, (_, d) => CODE_GAINS[digit(j, d)]!),
			CODE_GAINS[(digit(j, 0) + 1) % 4]!
		]);
		const ok = Array.from({ length: n }, () => true);
		for (let round = 0; round <= digits; round++) {
			const filters = Array.from({ length: n }, (_, j) => ({
				...this.markerBand(j, n),
				gain: this.onWire('gain', codes[j]![round]!)
			}));
			const { back } = await this.write(filters);
			this.state = back.filters.slice(0, n);
			filters.forEach((f, j) => {
				const got = back.filters[j];
				if (!got || !this.kept('gain', f.gain, got.gain)) ok[j] = false;
			});
		}
		const count = ok.indexOf(false) === -1 ? n : ok.indexOf(false);
		return count;
	}

	/**
	 * Two pushes that settle every slot on values it keeps: the base (−2 dB) and the canary's
	 * other values (−3 dB, a Q a fifth higher). What reads back becomes the base, so later trials
	 * compare against the device's own rounding.
	 */
	private async settle() {
		const a = await this.trialOnce(new Map(), undefined);
		for (let s = 0; s < this.K; s++) {
			const got = a.outcomes.get(s)?.stored;
			if (got && got.type === this.base[s]!.type) this.base[s] = { ...got };
		}
		const alt = new Map<number, Test>();
		for (let s = 0; s < this.K; s++) {
			const b = this.base[s]!;
			alt.set(s, {
				filter: { ...b, gain: this.onWire('gain', ALT_GAIN), q: this.onWire('q', b.q * 1.2) },
				fixed: ['gain', 'q']
			});
		}
		const r = await this.trialOnce(alt);
		this.canary = Array.from({ length: this.K }, (_, s) => {
			const b = this.base[s]!;
			const got = r.outcomes.get(s)?.stored;
			const c: { gain?: [number, number]; q?: [number, number] } = {};
			if (got && usesGain(b.type) && !same(got.gain, b.gain)) c.gain = [b.gain, got.gain];
			if (got && !same(got.q, b.q)) c.q = [b.q, got.q];
			return c;
		});
		const usable = this.canary.filter((c) => c.gain || c.q).length;
		this.conclude({ base: this.base, canaries: usable });
		if (usable === 0)
			this.note('no slot took a second value: whole-write rejections can’t be detected');
	}

	/**
	 * Puts every band back on its base when some band holds something else (the last test value
	 * of the experiment before): a band an experiment then refuses keeps a known value, and a
	 * device that sorts bands has nothing to sort.
	 */
	private async resettle() {
		const off = this.base.some((b, s) => {
			const got = this.state[s];
			if (!got || got.type !== b.type || !same(got.freq, b.freq)) return true;
			// Q may sit on its canary's other value; anything else is a leftover.
			const qs = this.canary[s]?.q ?? [b.q, b.q];
			return !qs.some((q) => same(got.q, q));
		});
		if (off) await this.trialOnce(new Map());
	}

	// --- Steps -----------------------------------------------------------------------------------

	/**
	 * Test values for slot `s`: fixed ones for gain; for Q and frequency, values just off the
	 * slot's base, which lie inside its window even where windows are partitioned. The grid they
	 * suggest is checked across the whole window once it is known (`verifyGrid`).
	 */
	private stepValues(field: NumField, s: number): number[] {
		if (field === 'gain') return GAIN_STEP_VALUES;
		return RELATIVE_STEP_VALUES[field].map((r) => this.base[s]![field] * r);
	}

	/** Non-grid values in every slot, rotated over pushes; the grid that explains what came back. */
	private async stepExperiment(field: NumField) {
		const w = this.wireOf(field);
		if (w && 'values' in w) {
			// The wire itself only carries a list: no grid to find.
			this.findings.steps[field] = { kind: 'irregular' };
			this.conclude({ step: this.findings.steps[field], why: 'the wire carries a list of values' });
			return;
		}
		const count = this.stepValues(field, 0).length;
		const rounds = Math.max(2, Math.ceil(count / this.K));
		const pairs: Pair[] = [];
		for (let r = 0; r < rounds; r++) {
			const values = Array.from({ length: this.K }, (_, s) =>
				this.onWire(field, this.stepValues(field, s)[(r * this.K + s) % count]!)
			);
			// Frequencies ascend with the band index, so a device that sorts bands or wants them
			// ascending takes them as they are.
			if (field === 'freq') values.sort((a, b) => a - b);
			const tests = new Map<number, Test>();
			for (let s = 0; s < this.K; s++) {
				tests.set(s, { filter: { ...this.base[s]!, [field]: values[s]! }, fixed: [field] });
			}
			const { outcomes } = await this.trial(tests);
			for (const [slot, o] of outcomes) {
				if (!o.stored || o.anomaly || o.reset || refusedBand(o, field)) continue;
				pairs.push({ sent: o.sent[field], stored: o.stored[field], slot });
			}
		}
		this.pairs[field] = pairs;
		// Before the windows are known, a value stored at the edge of what its band returned and
		// moved further than rounding would may be a clamp; `verifyGrid` settles it.
		const result = inferStep(pairs, this.wireStep(field), clampLike(pairs));
		this.findings.steps[field] = result;
		if (result.kind === 'grid') this.steps[field] = result.step;
		this.conclude({ step: result, observations: pairs.length });
	}

	// --- Bounds ----------------------------------------------------------------------------------

	private candidates(field: NumField | 'preamp'): number[] {
		const nice = field === 'preamp' ? NICE.gain : NICE[field];
		const all =
			field === 'gain' || field === 'preamp' ? [...nice, 0, ...nice.map((x) => -x)] : [...nice];
		return [...new Set(all)].sort((a, b) => a - b);
	}

	private newSearch(dir: 1 | -1, inner: number, hint?: number): Search {
		const useHint = hint !== undefined && dir * (hint - inner) > 0;
		return {
			dir,
			inner,
			...(useHint ? { hint } : {}),
			phase: useHint ? 'hint' : 'limit',
			steppedOnce: false,
			rounds: 0,
			tried: []
		};
	}

	/** The value a search tests next, or undefined once it is done. */
	private next(field: NumField | 'preamp', s: Search): number | undefined {
		if (s.done) return undefined;
		if (++s.rounds > MAX_ROUNDS) {
			s.done = { value: s.inner, how: 'inconclusive' };
			return undefined;
		}
		const log = isLog(field);
		const step = this.resolution(field);
		const beyond = (a: number, b: number) => s.dir * (a - b) > 0; // a is further out than b
		if (s.phase === 'hint') return this.onWire(field, s.hint!);
		if (s.phase === 'hint-next') {
			if (step) return this.onWire(field, s.inner + s.dir * step);
			s.phase = 'limit';
		}
		if (s.phase === 'limit') {
			const l = this.limit(field, s.dir);
			if (!beyond(l, s.inner) || same(l, s.inner)) {
				s.done = { value: s.inner, how: 'limit' };
				return undefined;
			}
			return this.onWire(field, l);
		}
		const outer = s.outer!;
		if (s.phase === 'nice') {
			// Compared as the wire carries them: a candidate the wire rounds onto a value already
			// tested would be tested again.
			const between = [...new Set(this.candidates(field).map((c) => this.onWire(field, c)))].filter(
				(w) =>
					beyond(w, s.inner) &&
					beyond(outer, w) &&
					!same(w, s.inner) &&
					!same(w, outer) &&
					!s.tried.some((t) => same(t, w))
			);
			if (s.dir < 0) between.reverse();
			if (between.length) return between[Math.floor((between.length - 1) / 2)];
			s.phase = 'grid';
		}
		if (step) {
			// Grid points strictly between what is kept and what was refused (which may be off
			// the grid, where the wire's resolution is finer than the device's).
			const k0 = Math.abs(outer - s.inner) / step;
			const between = (Math.abs(k0 - Math.round(k0)) < 1e-6 ? Math.round(k0) : Math.ceil(k0)) - 1;
			if (between <= 0) {
				s.done = { value: s.inner, how: 'rejected' };
				return undefined;
			}
			const k = s.steppedOnce ? Math.ceil(between / 2) : 1;
			s.steppedOnce = true;
			const v = this.onWire(field, tidy(s.inner + s.dir * step * k));
			if (same(v, s.inner) || same(v, outer) || s.tried.some((t) => same(t, v))) {
				s.done = { value: s.inner, how: 'rejected' };
				return undefined;
			}
			return v;
		}
		const close = log
			? Math.abs(Math.log(outer / s.inner)) < 1e-3
			: Math.abs(outer - s.inner) < 0.01;
		if (close) {
			s.done = { value: s.inner, how: 'rejected' };
			return undefined;
		}
		return midpoint(s.inner, outer, log);
	}

	/** Folds one observation into a search. */
	private update(
		field: NumField | 'preamp',
		s: Search,
		sent: number,
		stored: number | undefined,
		prev: number | undefined,
		trouble?: string,
		landed?: boolean
	) {
		const beyond = (a: number, b: number) => s.dir * (a - b) > 0;
		const atLimit = s.phase === 'limit';
		s.tried.push(sent);
		if (stored === undefined || (trouble && trouble !== 'reset')) {
			s.done = { value: s.inner, how: 'inconclusive' };
			return;
		}
		const refused =
			trouble === 'reset' ||
			landed === false ||
			(landed === undefined && same(stored, prev) && !this.kept(field, sent, stored));
		if (!refused && this.kept(field, sent, stored)) {
			s.inner = beyond(stored, s.inner) ? stored : s.inner;
			if (atLimit) s.done = { value: stored, how: 'limit' };
			else if (s.phase === 'hint') s.phase = 'hint-next';
			else if (s.phase === 'hint-next') s.phase = 'limit';
			return;
		}
		if (refused) {
			if (s.phase === 'hint-next') {
				s.done = { value: s.inner, how: 'rejected' };
				return;
			}
			s.outer = sent;
			if (s.phase === 'hint' || s.phase === 'limit') s.phase = 'nice';
			return;
		}
		// Stored something else: a clamp if it lies between what is kept and what was sent.
		if (!beyond(s.inner, stored) && beyond(sent, stored)) {
			s.done = { value: stored, how: 'clamped' };
			return;
		}
		s.done = { value: s.inner, how: 'inconclusive' };
		this.note(`${field}: sent ${sent}, read back ${stored}, which is neither kept nor a clamp`);
	}

	/**
	 * The bounds of `field` in `slots`, all slots in lockstep: each push carries every slot's next
	 * test value (`make`). `hint(s, dir)` is tried first, e.g. the profile's bound. `directions`
	 * limits a slot to one bound.
	 */
	private async searchBounds(
		field: NumField,
		slots: readonly number[],
		make: (s: number, v: number) => Test,
		inner: (s: number) => number,
		hint?: (s: number, dir: 1 | -1) => number | undefined,
		directions: (s: number) => readonly (1 | -1)[] = () => [1, -1]
	): Promise<Map<number, FieldFinding>> {
		const searches = new Map<number, Search[]>();
		for (const s of slots) {
			searches.set(
				s,
				directions(s).map((d) => this.newSearch(d, inner(s), hint?.(s, d)))
			);
		}
		let finished: FieldFinding | undefined;
		const concluded = new Set<number>();
		for (;;) {
			const tests = new Map<number, Test>();
			const active = new Map<number, Search>();
			for (const [slot, list] of searches) {
				// Band by band, a band yet to start begins at the bounds the last one ended on:
				// two writes per bound when the bands agree.
				if (this.serial && finished) {
					for (const x of list) {
						if (x.done || x.hint !== undefined || x.steppedOnce || x.phase === 'grid') continue;
						const h = x.dir > 0 ? finished.max?.value : finished.min?.value;
						const inside =
							h !== undefined &&
							x.dir * (h - x.inner) > 0 &&
							(x.outer === undefined || x.dir * (x.outer - h) > 0);
						if (inside) {
							x.hint = h;
							x.phase = 'hint';
						}
					}
				}
				for (const search of list) {
					const v = this.next(field, search);
					if (v === undefined) continue;
					search.pending = v;
					tests.set(slot, make(slot, v));
					active.set(slot, search);
					break;
				}
				if (!active.has(slot) && !concluded.has(slot)) {
					concluded.add(slot);
					finished = Object.fromEntries(list.map((x) => [x.dir > 0 ? 'max' : 'min', x.done!]));
				}
				// Band by band: one band per write.
				if (this.serial && tests.size > 0) break;
			}
			if (tests.size === 0) break;
			const { outcomes } = await this.trial(tests);
			for (const [slot, search] of active) {
				const o = outcomes.get(slot)!;
				const trouble = o.reset ? 'reset' : o.anomaly;
				this.update(
					field,
					search,
					o.sent[field],
					o.stored?.[field],
					o.prev?.[field],
					trouble,
					o.landed
				);
			}
		}
		const out = new Map<number, FieldFinding>();
		for (const [slot, list] of searches) {
			const f: FieldFinding = {};
			for (const search of list) f[search.dir > 0 ? 'max' : 'min'] = search.done!;
			out.set(slot, f);
		}
		return out;
	}

	/**
	 * Values spread across each slot's window, off the grid the step experiment found: the grid
	 * holds if they land as it predicts. A finer grid replaces it; none at all (a set of values
	 * the device snaps to) returns false, and the field is swept instead.
	 */
	private async verifyGrid(field: NumField, found: Map<number, FieldFinding>): Promise<boolean> {
		const before = this.findings.steps[field];
		if (!before) return true;
		const log = isLog(field);
		const pairs: Pair[] = [];
		for (const frac of SPREAD) {
			const tests = new Map<number, Test>();
			for (const [s, f] of found) {
				const lo = f.min?.value;
				const hi = f.max?.value;
				if (lo === undefined || hi === undefined || same(lo, hi)) continue;
				const v = log ? lo * Math.pow(hi / lo, frac) : lo + (hi - lo) * frac;
				tests.set(s, this.testFor(field, s, this.onWire(field, v * 1.000137)));
			}
			if (tests.size === 0) return true;
			const { outcomes } = await this.trial(tests);
			for (const [s, o] of outcomes) {
				if (!tests.has(s) || !o.stored || o.anomaly || o.reset || refusedBand(o, field)) continue;
				pairs.push({ sent: o.sent[field], stored: o.stored[field], slot: s });
			}
		}
		// Now the windows are known, clamps are exactly the values stored at a bound, sent past it.
		const clamped = (p: Pair) => {
			const f = found.get(p.slot ?? -1);
			const lo = f?.min?.value;
			const hi = f?.max?.value;
			return (
				(hi !== undefined && same(p.stored, hi) && p.sent > hi) ||
				(lo !== undefined && same(p.stored, lo) && p.sent < lo)
			);
		};
		const after = inferStep(
			[...(this.pairs[field] ?? []).filter((p) => !clamped(p)), ...pairs],
			this.wireStep(field)
		);
		this.conclude({ verified: after });
		if (after.kind === 'irregular') {
			this.findings.steps[field] = after;
			return false;
		}
		if (after.kind === 'insufficient') return before.kind !== 'irregular';
		this.findings.steps[field] = after;
		if (after.kind === 'grid') this.steps[field] = after.step;
		else delete this.steps[field];
		return true;
	}

	/** A field without a uniform grid: sweep it and collect what each slot stored. */
	private async sweep(
		field: NumField,
		slots: readonly number[],
		make: (s: number, v: number) => Test
	) {
		const w = this.wireOf(field);
		let points: number[];
		if (w && 'values' in w) points = [...w.values];
		else if (field === 'gain') {
			const lo = this.limit('gain', -1);
			const hi = this.limit('gain', 1);
			points = Array.from({ length: Math.round((hi - lo) / 0.25) + 1 }, (_, i) => lo + i * 0.25);
		} else {
			const lo = Math.max(this.limit(field, -1), field === 'freq' ? 10 : 0.01);
			const hi = Math.min(this.limit(field, 1), field === 'freq' ? 24000 : 100);
			const n = Math.ceil(Math.log2(hi / lo) * 12);
			points = Array.from({ length: n + 1 }, (_, i) => lo * Math.pow(hi / lo, i / n));
		}
		points = [...new Set(points.map((p) => this.onWire(field, p)))];
		const seen = new Map<number, Set<number>>(slots.map((s) => [s, new Set<number>()]));
		const rounds = Math.ceil(points.length / Math.max(1, slots.length));
		for (let r = 0; r < rounds; r++) {
			const tests = new Map<number, Test>();
			slots.forEach((s, i) =>
				tests.set(s, make(s, points[(r * slots.length + i) % points.length]!))
			);
			const { outcomes } = await this.trial(tests);
			for (const [s, o] of outcomes) {
				if (!tests.has(s) || !o.stored || o.anomaly || o.reset || refusedBand(o, field)) continue;
				seen.get(s)!.add(tidy(o.stored[field]));
			}
		}
		const out = new Map<number, FieldFinding>();
		for (const [s, set] of seen) out.set(s, { values: [...set].sort((a, b) => a - b) });
		return out;
	}

	private profileBound(field: NumField, s: number, dir: 1 | -1): number | undefined {
		const p = this.o.profile;
		if (!p || (p.bandCount !== null && s >= p.bandCount)) return undefined;
		try {
			const d = resolveSlot(p, s)[field];
			if ('values' in d || 'value' in d) return undefined;
			return dir > 0 ? d.max : d.min;
		} catch {
			return undefined;
		}
	}

	private testFor(field: NumField, s: number, v: number): Test {
		return { filter: { ...this.base[s]!, [field]: v }, fixed: [field] };
	}

	private orderRule(): boolean {
		const o = this.findings.order;
		return !!o && 'rule' in o && o.rule !== 'none';
	}

	/** Both bounds of `field` in every slot (or its set, without a uniform grid). */
	private async rangeExperiment(field: NumField) {
		const all = Array.from({ length: this.K }, (_, s) => s);
		const wire = this.wireOf(field);
		const make = (s: number, v: number) => this.testFor(field, s, v);
		let found: Map<number, FieldFinding>;
		if (wire && 'values' in wire) {
			found = await this.sweep(field, all, make);
		} else {
			found = await this.searchBounds(
				field,
				all,
				make,
				(s) => this.base[s]![field],
				(s, d) => this.profileBound(field, s, d)
			);
			const before = this.resolution(field);
			if (!(await this.verifyGrid(field, found))) {
				found = await this.sweep(field, all, make);
			} else if (this.resolution(field) !== before) {
				// A finer grid: the bounds may lie between the old grid's points. Start from them.
				const prior = found;
				found = await this.searchBounds(
					field,
					all,
					make,
					(s) => this.base[s]![field],
					(s, d) => (d > 0 ? prior.get(s)?.max?.value : prior.get(s)?.min?.value)
				);
			}
		}
		for (const [s, f] of found) this.findings.slots[s]![field] = f;
		this.conclude({ slots: Object.fromEntries(found) });
	}

	// --- Types -----------------------------------------------------------------------------------

	/**
	 * Every coded type in every slot (INSPECTOR §3.2 "types per slot"): kept, coerced, gain zeroed
	 * or refused. One band sits each round out, so a silent reset still shows on a band that
	 * wasn't asked to change.
	 */
	private async typesExperiment() {
		const coded = this.o.analysis.types.filter((t) => !t.startsWith('x-'));
		const kept = Array.from({ length: this.K }, () => new Set<FilterType>());
		const notes = Array.from({ length: this.K }, () => [] as string[]);
		const done = Array.from({ length: this.K }, () => 0);
		for (let r = 0; done.some((n) => n < coded.length); r++) {
			const tests = new Map<number, Test>();
			for (let s = 0; s < this.K; s++) {
				if ((this.K > 2 && s === r % this.K) || done[s]! >= coded.length) continue;
				const type = coded[(s + done[s]!) % coded.length]!;
				done[s]!++;
				const b = this.base[s]!;
				tests.set(s, {
					filter: { ...b, type, gain: usesGain(type) ? b.gain : 0 },
					fixed: ['type', 'gain', 'freq']
				});
			}
			const { outcomes } = await this.trial(tests);
			for (const [s, o] of outcomes) {
				if (!tests.has(s)) continue;
				const type = o.sent.type;
				if (!o.stored || o.reset) {
					notes[s]!.push(`${type}: no answer`);
				} else if (
					o.landed === false ||
					(o.landed === undefined &&
						o.prev &&
						sameFilter(o.stored, o.prev) &&
						o.stored.type !== type)
				) {
					notes[s]!.push(`${type}: refused`);
				} else if (o.stored.type === type) {
					if (usesGain(type) && same(o.stored.gain, 0) && !same(o.sent.gain, 0)) {
						notes[s]!.push(`${type}: kept, but its gain read back as 0`);
					} else kept[s]!.add(type);
				} else {
					notes[s]!.push(`${type}: became ${o.stored.type}`);
				}
			}
		}
		const order = (t: FilterType) => {
			const i = coded.indexOf(t);
			return i < 0 ? coded.length : i;
		};
		for (let s = 0; s < this.K; s++) {
			const types = [...kept[s]!].sort((a, b) => order(a) - order(b));
			const baseType = this.base[s]!.type;
			// The base type first: it is the one the slot was found to keep everything else with.
			types.sort((a, b) => Number(b === baseType) - Number(a === baseType));
			this.findings.slots[s]!.types = types.length ? types : [baseType];
			if (notes[s]!.length) this.findings.slots[s]!.typeNotes = notes[s]!;
		}
		this.conclude({
			slots: this.findings.slots.map((x) => ({ types: x.types, notes: x.typeNotes }))
		});
	}

	// --- Conditional windows ---------------------------------------------------------------------

	/**
	 * The frequency window again, with a boost instead of a cut and with each other kept type
	 * (INSPECTOR §3.2 "conditional domains"). The plain window's bounds are tried first, so an
	 * unchanged window costs two writes per bound.
	 */
	private async conditionsExperiment() {
		if (this.findings.steps.freq?.kind === 'irregular') {
			this.conclude({ skipped: 'the frequency has no uniform grid' });
			return;
		}
		type Condition = { label: string; when: When; test: (s: number, v: number) => Test };
		const perSlot: Condition[][] = Array.from({ length: this.K }, (_, s) => {
			const b = this.base[s]!;
			const list: Condition[] = [];
			if (usesGain(b.type)) {
				list.push({
					label: 'gain > 0',
					when: { gain: { gt: 0 } },
					test: (_s, v) => ({
						filter: { ...b, freq: v, gain: this.onWire('gain', 2) },
						fixed: ['freq', 'gain']
					})
				});
			}
			for (const type of this.findings.slots[s]?.types ?? []) {
				if (type === b.type) continue;
				list.push({
					label: `type ${type}`,
					when: { type: { eq: type } },
					test: (_s, v) => ({
						filter: { ...b, type, freq: v, gain: usesGain(type) ? b.gain : 0 },
						fixed: ['type', 'freq', 'gain']
					})
				});
			}
			return list;
		});
		const rounds = Math.max(0, ...perSlot.map((l) => l.length));
		const plain = (s: number) => this.findings.slots[s]?.freq;
		const ordered = this.orderRule() && this.K > 1;
		// Bands that agree on everything so far likely agree here too: the first and last band
		// stand for them, and the rest are probed only if those two differ.
		const key = (s: number) =>
			JSON.stringify([this.findings.slots[s]?.types, plain(s), perSlot[s]!.map((c) => c.label)]);
		const alike = this.K > 2 && this.findings.slots.every((_, s) => key(s) === key(0));
		for (let i = 0; i < rounds; i++) {
			let slots = perSlot.map((l, s) => (l[i] ? s : -1)).filter((s) => s >= 0);
			// Bands must ascend: only the first band reaches the minimum and the last the maximum.
			if (ordered || alike) slots = slots.filter((s) => s === 0 || s === this.K - 1);
			if (!slots.length) continue;
			const search = (list: number[]) =>
				this.searchBounds(
					'freq',
					list,
					(s, v) => perSlot[s]![i]!.test(s, v),
					(s) => this.base[s]!.freq,
					(s, d) => (d > 0 ? plain(s)?.max?.value : plain(s)?.min?.value),
					(s) => (!ordered ? [1, -1] : s === 0 ? [-1] : [1])
				);
			let found = await search(slots);
			if (alike && !ordered) {
				const [a, b] = [found.get(0), found.get(this.K - 1)];
				const agree =
					!!a && !!b && same(a.min?.value, b.min?.value) && same(a.max?.value, b.max?.value);
				if (agree) {
					found = new Map(perSlot.map((_, s) => [s, { ...a! }]));
				} else {
					const rest = await search(
						perSlot.map((_, s) => s).filter((s) => s !== 0 && s !== this.K - 1)
					);
					found = new Map([...found, ...rest]);
				}
			}
			if (ordered) {
				const first = found.get(0);
				const last = found.get(this.K - 1);
				if (!first || !last) continue;
				const window = { min: first.min!, max: last.max! };
				found = new Map(
					perSlot.flatMap((l, s) =>
						l[i]?.label === perSlot[0]![i]?.label ? [[s, { ...window }]] : []
					)
				);
			}
			for (const [s, f] of found) {
				const p = plain(s);
				const differs =
					!p || !same(p.max?.value, f.max?.value) || !same(p.min?.value, f.min?.value);
				if (!differs) continue;
				const c = perSlot[s]![i]!;
				(this.findings.slots[s]!.conditions ??= []).push({ label: c.label, when: c.when, freq: f });
			}
		}
		this.conclude({
			slots: this.findings.slots.map(
				(x) => x.conditions?.map((c) => ({ label: c.label, freq: c.freq })) ?? []
			)
		});
	}

	// --- Order -----------------------------------------------------------------------------------

	/**
	 * Band order (INSPECTOR §3.2 "ordering"), once the frequency windows are known. Windows that
	 * stop exactly at the neighbouring bands' frequencies are the mark of a device that wants
	 * ascending bands: then the first band's minimum and the last one's maximum stand for every
	 * band. Otherwise, descending frequencies inside the window all bands share: kept as sent, no
	 * rule; read back sorted, the device reorders; refused, a rule, and two equal frequencies tell
	 * whether it is strict.
	 */
	private async orderExperiment() {
		const skip = (why: string) => {
			this.findings.order = { skipped: why };
			this.conclude(this.findings.order);
		};
		if (this.K < 2) return skip('one band');
		if (this.findings.steps.freq?.kind === 'irregular')
			return skip('the frequency has no uniform grid');
		const windows = this.findings.slots.map((f) => f.freq);
		if (windows.some((w) => !w?.min || !w.max)) return skip('the frequency windows are unknown');
		const chained = this.chained();
		if (chained) {
			const all = { min: windows[0]!.min!, max: windows[this.K - 1]!.max! };
			for (const f of this.findings.slots) f.freq = { ...all };
			this.findings.order = { rule: 'rejects', strict: chained.strict };
			this.conclude({
				...this.findings.order,
				why: 'each band’s window ended at its neighbours’ frequencies'
			});
			return;
		}
		const lo = Math.max(...windows.map((w) => w!.min!.value));
		const hi = Math.min(...windows.map((w) => w!.max!.value));
		if (!(hi / lo > 1.5)) {
			return skip('the bands’ windows don’t overlap, so the windows fix their order');
		}
		const step = this.resolution('freq');
		const freqs = Array.from({ length: this.K }, (_, i) =>
			snap(lo * 1.1 * Math.pow(hi / 1.1 / (lo * 1.1), i / (this.K - 1)), step)
		);
		if (new Set(freqs).size < this.K) return skip('the shared window is too narrow');
		const descending = [...freqs].reverse();
		const tests = new Map<number, Test>();
		descending.forEach((f, s) =>
			tests.set(s, { filter: { ...this.base[s]!, freq: f }, fixed: ['freq'] })
		);
		const { outcomes, refusedWhole } = await this.trialOnce(tests);
		const got = [...outcomes.values()].map((o) => o.stored?.freq);
		let rule: 'none' | 'reorders' | 'rejects';
		if (got.every((f, s) => this.kept('freq', descending[s]!, f ?? NaN))) rule = 'none';
		else if (!refusedWhole && got.every((f, s) => this.kept('freq', freqs[s]!, f ?? NaN)))
			rule = 'reorders';
		else rule = 'rejects';
		let strict: boolean | undefined;
		if (rule !== 'none') {
			const equal = [...freqs];
			equal[1] = equal[0]!;
			const t2 = new Map<number, Test>();
			equal.forEach((f, s) =>
				t2.set(s, { filter: { ...this.base[s]!, freq: f }, fixed: ['freq'] })
			);
			const r2 = await this.trialOnce(t2);
			strict = !equal.every((f, s) =>
				this.kept('freq', f, r2.outcomes.get(s)?.stored?.freq ?? NaN)
			);
			// Bases ascend from here on, so later trials don't trip the rule.
			const sorted = this.base.map((b) => b.freq).sort((a, b) => a - b);
			this.base = this.base.map((b, s) => ({ ...b, freq: sorted[s]! }));
		}
		this.findings.order = { rule, ...(strict !== undefined ? { strict } : {}) };
		this.conclude(this.findings.order);
	}

	/**
	 * Whether every band's window ends where its neighbours sit: max of band s at band s+1's base
	 * frequency (or one step below it, strictly), min of band s+1 at band s's. Null if not.
	 */
	private chained(): { strict: boolean } | null {
		const step = this.resolution('freq') ?? 0;
		const tol = (a: number, b: number) => Math.abs(a - b) <= step * 0.5 + 1e-9 * Math.max(1, b);
		let strict: boolean | null = null;
		for (let s = 0; s + 1 < this.K; s++) {
			const max = this.findings.slots[s]!.freq!.max!;
			const min = this.findings.slots[s + 1]!.freq!.min!;
			const above = this.base[s + 1]!.freq;
			const below = this.base[s]!.freq;
			if (!(above > below) || max.how === 'limit' || min.how === 'limit') return null;
			const gap = step ? (above - max.value) / step : above - max.value;
			const gapMin = step ? (min.value - below) / step : min.value - below;
			const s1 = tol(max.value, above) && tol(min.value, below);
			const s2 = step > 0 && tol(gap, 1) && tol(gapMin, 1);
			if (!s1 && !s2) return null;
			const thisStrict = !s1;
			if (strict !== null && strict !== thisStrict) return null;
			strict = thisStrict;
		}
		return strict === null ? null : { strict };
	}

	// --- Preamp ----------------------------------------------------------------------------------

	private async preampExperiment() {
		const pairs: Pair[] = [];
		for (const v of PREAMP_STEP_VALUES) {
			const r = await this.trial(new Map(), v);
			const p = r.preamp;
			if (p && p.stored !== undefined && !(same(p.stored, p.prev) && !same(p.sent, p.stored))) {
				pairs.push({ sent: p.sent, stored: p.stored });
			}
		}
		if (pairs.length === 0 && this.preampState === undefined) {
			this.conclude({ skipped: 'the device reads back no preamp' });
			return;
		}
		const step = inferStep(pairs, this.wireStep('preamp'));
		this.findings.steps.preamp = step;
		if (step.kind === 'grid') this.steps.preamp = step.step;
		const finding: FieldFinding = {};
		for (const dir of [1, -1] as const) {
			const s = this.newSearch(dir, this.preampState ?? 0);
			for (;;) {
				const v = this.next('preamp', s);
				if (v === undefined) break;
				const r = await this.trial(new Map(), v);
				this.update('preamp', s, r.preamp!.sent, r.preamp!.stored, r.preamp!.prev);
			}
			finding[dir > 0 ? 'max' : 'min'] = s.done!;
		}
		this.findings.preamp = finding;
		this.conclude({ step, ...finding });
	}
}

/**
 * Which pairs may be clamps, for `inferStep`: stored at the edge of what its band returned, sent
 * beyond it, and moved further than rounding onto the candidate grid could.
 */
function clampLike(pairs: readonly Pair[]): (p: Pair, step: number) => boolean {
	const edges = new Map<number | undefined, { lo: number; hi: number }>();
	for (const p of pairs) {
		const e = edges.get(p.slot);
		edges.set(p.slot, {
			lo: Math.min(e?.lo ?? Infinity, p.stored),
			hi: Math.max(e?.hi ?? -Infinity, p.stored)
		});
	}
	return (p, step) => {
		const { lo, hi } = edges.get(p.slot)!;
		const edge = (p.stored === hi && p.sent > hi) || (p.stored === lo && p.sent < lo);
		return edge && Math.abs(p.sent - p.stored) > step / 2 + 1e-9 * Math.max(1, Math.abs(p.sent));
	};
}

/** The band was refused: its canary didn't land, or (without one) nothing changed. */
function refusedBand(o: Outcome, field: NumField): boolean {
	if (o.landed !== undefined) return !o.landed;
	return (
		!!o.prev &&
		!!o.stored &&
		same(o.stored[field], o.prev[field]) &&
		!same(o.sent[field], o.stored[field])
	);
}

function sameFilter(a: Filter, b: Filter): boolean {
	return (
		a.type === b.type &&
		same(a.freq, b.freq) &&
		same(a.q, b.q) &&
		(same(a.gain, b.gain) || (!usesGain(a.type) && !usesGain(b.type)))
	);
}

function filterText(f: Filter): string {
	return `${f.type} ${f.freq} Hz ${f.gain} dB Q ${f.q}`;
}
