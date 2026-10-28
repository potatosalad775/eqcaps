// What NICEHCK's web app (app.nicehck.cn) decoded from a device (a `nicehck-app` snapshot), checked
// against what the walkplay-hid handler and the device's profile say about the same bytes. Each
// check returns disagreements as sentences; none means the handler, the data and the vendor app
// agree.

import { controlTakes, type Filter, type Profile } from '@potatosalad775/eqcaps-core';
import { biquadQ30 } from '../src/biquad.ts';
import { openDevice, protocolOf } from '../src/index.ts';
import {
	decodeWalkplayBand,
	encodeWalkplayBand,
	encodeWalkplayControl,
	WALKPLAY_CONTROL_COMMANDS
} from '../src/handlers/walkplay-hid.ts';
import {
	exchangesOf,
	deviceAt,
	matchProfile,
	RecordingReplay,
	type Recording,
	type Snapshot
} from './recording.ts';

/** The parts of the app's device store (zustand) the checks read. */
export interface NicehckState {
	firmwareVersion?: string;
	eqIndex?: number;
	/** The pre-gain, whole dB. */
	offset?: number;
	bands?: { id: number; frequency: number; gain: number; qValue: number }[];
	equalizerSetting?: {
		minFrequency: number;
		maxFrequency: number;
		frequencyNumber: number;
		minGain: number;
		maxGain: number;
		minQValue: number;
		maxQValue: number;
		minOffset: number;
		maxOffset: number;
	};
	capabilities?: Record<string, unknown>;
	tkFilterTypeIndex?: { value: number };
	workMode?: number | null;
	gainLevel?: number | null;
	deviceVolume?: number | null;
	micGainDb?: number;
	/** One slider: n > 0 is the left channel cut by n dB, n < 0 the right by -n. */
	channelBalance?: number;
}

/** The app's "unknown" filter type. */
const UNKNOWN_FILTER = 99;

/** Each control as the app holds it. */
const STATE_OF: Record<string, (s: NicehckState) => number | undefined> = {
	dacFilter: (s) => {
		const v = s.tkFilterTypeIndex?.value;
		return v === undefined || v === UNKNOWN_FILTER ? undefined : v;
	},
	workMode: (s) => s.workMode ?? undefined,
	gainLevel: (s) => s.gainLevel ?? undefined,
	volume: (s) => s.deviceVolume ?? undefined,
	micGain: (s) => s.micGainDb,
	leftGain: (s) => (s.channelBalance === undefined ? undefined : -Math.max(0, s.channelBalance)),
	rightGain: (s) => (s.channelBalance === undefined ? undefined : Math.min(0, s.channelBalance))
};

/** The app capability that shows each control. */
const CAPABILITY_OF: Record<string, string> = {
	dacFilter: 'digitalFilter',
	workMode: 'workMode',
	gainLevel: 'gainLevel',
	volume: 'deviceVolume',
	micGain: 'microphoneGain',
	leftGain: 'channelBalance',
	rightGain: 'channelBalance'
};

/** The app rounds a band's gain and Q to 2 decimals. */
const near = (a: number, b: number) => Math.abs(a - b) <= 0.005 + 1e-9;

const show = (f: Filter | null) => (f ? `${f.type} ${f.freq} Hz Q ${f.q} ${f.gain} dB` : 'empty');

export function profileFor(
	recording: Recording,
	state: NicehckState,
	profiles: Iterable<Profile>,
	device = 0
): Profile | string {
	const firmware =
		state.firmwareVersion && state.firmwareVersion !== '0' ? state.firmwareVersion : undefined;
	return matchProfile(recording, firmware, profiles, device);
}

/** The exchanges of `device` before `t`. */
const exchangesBefore = (recording: Recording, device: number, t: number) =>
	exchangesOf(recording, device).filter((x) => x.t < t);

/**
 * Reads: what the handler reads from the answers the app got, against what the app shows. Not
 * checked when the app wrote after its last read: it then shows what it wrote, which no answer
 * holds (the writes are checked by `checkWrites`).
 */
export async function checkReads(
	recording: Recording,
	snapshot: Snapshot,
	profile: Profile
): Promise<string[]> {
	const state = snapshot.state as NicehckState;
	const out: string[] = [];
	const device = deviceAt(recording, snapshot.t);
	const before = exchangesBefore(recording, device, snapshot.t);
	const last = before.findLast((x) => x.request[0] === 0x80);
	if (!last || before.some((x) => x.t > last.t && x.request[0] === 0x01)) return out;
	const open = () =>
		openDevice(
			new RecordingReplay(recording, {
				device,
				until: snapshot.t
			}),
			protocolOf(profile)!,
			{
				profile,
				sleep: () => Promise.resolve()
			}
		);

	const firmware = await open().firmware();
	// The app takes byte 2 as the version's length, which the device leaves from an earlier
	// report, so it may show the version cut short.
	if (
		state.firmwareVersion &&
		state.firmwareVersion !== '0' &&
		!firmware?.startsWith(state.firmwareVersion)
	) {
		out.push(`firmware: the handler reads ${firmware}, the app ${state.firmwareVersion}`);
	}

	const bands = state.bands ?? [];
	if (bands.length) {
		let pulled;
		try {
			pulled = await open().pull({ bands: bands.length });
		} catch (e) {
			out.push(`bands: the handler can't read them (${(e as Error).message})`);
		}
		for (const b of pulled ? bands : []) {
			const ours = pulled!.filters[b.id] ?? null;
			// The app ignores the type byte and shows every band as peaking, an unset one at 0 Hz.
			const agree =
				b.frequency === 0
					? ours === null
					: ours !== null &&
						ours.type === 'PK' &&
						ours.freq === b.frequency &&
						near(ours.q, b.qValue) &&
						near(ours.gain, b.gain);
			if (!agree) {
				const app = { type: 'PK', freq: b.frequency, q: b.qValue, gain: b.gain } as const;
				out.push(`band ${b.id}: the handler reads ${show(ours)}, the app ${show(app)}`);
			}
		}
		if (pulled && state.offset !== undefined && pulled.preamp !== state.offset) {
			out.push(`pre-gain: the handler reads ${pulled.preamp}, the app ${state.offset}`);
		}
	}

	// The app reads a channel gain as s16 at byte 4, which a 0x16 answer leaves from an earlier
	// report; where that byte isn't 0, the app's balance isn't the device's.
	const stale = (channel: number) => {
		const x = before.findLast(
			(x) => x.request[0] === 0x80 && x.request[1] === 0x16 && x.request[3] === channel
		);
		return (x?.answers.at(-1)?.[4] ?? 0) !== 0;
	};
	const balanceRead = !stale(0) && !stale(1);

	const values = await open().readControls();
	for (const [id, value] of Object.entries(values)) {
		if (!balanceRead && (id === 'leftGain' || id === 'rightGain')) continue;
		const app = STATE_OF[id]?.(state);
		if (value !== null && app !== undefined && value !== app) {
			out.push(`control ${id}: the handler reads ${value}, the app ${app}`);
		}
	}
	return out;
}

/** Data: what the profile says the device offers, against the app's config and what it read. */
export function checkData(snapshot: Snapshot, profile: Profile): string[] {
	const state = snapshot.state as NicehckState;
	const out: string[] = [];
	const eq = state.equalizerSetting;
	if (eq) {
		if (eq.frequencyNumber !== profile.bandCount) {
			out.push(`the app uses ${eq.frequencyNumber} bands, ${profile.id} ${profile.bandCount}`);
		}
		const { freq, q, gain } = profile.band ?? {};
		const range = (d: unknown) => d as { min?: number; max?: number } | undefined;
		const compare = (what: string, d: unknown, min: number, max: number, tolerance = 0) => {
			const r = range(d);
			if (
				Math.abs((r?.min ?? NaN) - min) > tolerance ||
				Math.abs((r?.max ?? NaN) - max) > tolerance
			) {
				out.push(`${what}: the app allows ${min} to ${max}, ${profile.id} ${r?.min} to ${r?.max}`);
			}
		};
		compare('freq', freq, eq.minFrequency, eq.maxFrequency);
		// The app's Q limits are sent ×256, so a limit off that grid is written as its grid point.
		compare('Q', q, eq.minQValue, eq.maxQValue, 1 / 256);
		compare('gain', gain, eq.minGain, eq.maxGain);
		compare(
			'pre-gain',
			profile.preamp && 'gain' in profile.preamp ? profile.preamp.gain : undefined,
			eq.minOffset,
			eq.maxOffset
		);
	}
	const controls = profile.protocol?.controls ?? [];
	for (const c of controls) {
		const value = STATE_OF[c.id]?.(state);
		if (value !== undefined && !controlTakes(c, value)) {
			out.push(`control ${c.id}: the app read ${value}, which ${profile.id} doesn't list`);
		}
		const capability = CAPABILITY_OF[c.id];
		if (state.capabilities && capability && state.capabilities[capability] !== true) {
			out.push(`control ${c.id} is in ${profile.id}, the app doesn't offer it`);
		}
	}
	for (const [id, capability] of Object.entries(CAPABILITY_OF)) {
		if (state.capabilities?.[capability] === true && !controls.some((c) => c.id === id)) {
			out.push(`the app offers ${capability}, ${profile.id} has no control ${id}`);
		}
	}
	return out;
}

/** The control a write frame sets and its value; undefined if the frame isn't a control write. */
function controlOf(d: Uint8Array): [string, number] | undefined {
	for (const [id, c] of Object.entries(WALKPLAY_CONTROL_COMMANDS)) {
		if (c.cmd !== d[1] || (c.channel !== undefined && c.channel !== d[3])) continue;
		const at = c.channel === undefined ? 3 : 4;
		return [id, c.db ? (((d[at]! | (d[at + 1]! << 8)) << 16) >> 16) / 256 : d[at]!];
	}
	return undefined;
}

/** A band frame's coefficients (bytes 7–26) as five Q2.30 integers. */
const coefficients = (d: ArrayLike<number>) =>
	Array.from({ length: 5 }, (_, i) => {
		const at = 7 + i * 4;
		return d[at]! | (d[at + 1]! << 8) | (d[at + 2]! << 16) | (d[at + 3]! << 24) | 0;
	});

/**
 * The coefficient a band frame may carry, from the band it states: the app computes them from its
 * Q and gain before rounding those onto the ×256 grid, so anything within half a grid step of the
 * stated value, ±1 in the last place, is the same band. The handler computes from the stated value.
 */
function coefficientBounds(filter: Filter) {
	const half = 0.5 / 256;
	const corners = [-half, half].flatMap((dq) =>
		[-half, half].map((dg) =>
			biquadQ30(filter.type, filter.freq, filter.gain + dg, filter.q + dq, 96000)
		)
	);
	return Array.from({ length: 5 }, (_, i) => {
		const values = corners.map((c) => c[i]!);
		return [Math.min(...values) - 1, Math.max(...values) + 1] as const;
	});
}

/**
 * Writes: every band and control write the app sent, against the frame the handler sends for the
 * same values. Left out, as known differences: a band frame's length byte (2: the app says 0x21,
 * the handler 0x18, devicePEQ's) and the pre-gain the app also puts in it (34); its coefficients
 * are checked against the band they state (`coefficientBounds`). The commit frames differ too and
 * aren't compared (see the nicehck-walkplay base's notes).
 */
export async function checkWrites(recording: Recording): Promise<string[]> {
	const out: string[] = [];
	for (const x of recording.devices.flatMap((_, d) => exchangesOf(recording, d))) {
		const d = x.request;
		if (d[0] !== 0x01) continue;
		let ours: number[];
		let skip = new Set<number>();
		try {
			if (d[1] === 0x09) {
				const filter = decodeWalkplayBand(d);
				if (!filter) continue;
				ours = encodeWalkplayBand(d[4]!, filter, d[35]!);
				skip = new Set([2, 34, ...Array.from({ length: 20 }, (_, i) => 7 + i)]);
				const app = coefficients(d);
				const bounds = coefficientBounds(filter);
				const off = app.findIndex((v, i) => v < bounds[i]![0] || v > bounds[i]![1]);
				if (off >= 0) {
					out.push(
						`write 0x09 band ${d[4]} at ${x.t} ms: coefficient ${off} is ${app[off]} from the app, ${bounds[off]!.join(' to ')} for ${show(filter)}`
					);
				}
			} else {
				const control = controlOf(d);
				if (!control) continue;
				ours = encodeWalkplayControl(...control);
			}
		} catch (e) {
			out.push(
				`write 0x${d[1]!.toString(16)} at ${x.t} ms: the handler can't send it (${(e as Error).message})`
			);
			continue;
		}
		const differ = [...d].findIndex((b, i) => !skip.has(i) && b !== (ours[i] ?? 0));
		if (differ >= 0) {
			out.push(
				`write 0x${d[1]!.toString(16)} at ${x.t} ms: byte ${differ} is ${d[differ]} from the app, ${ours[differ]} from the handler`
			);
		}
	}
	return out;
}
