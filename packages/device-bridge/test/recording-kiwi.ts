// What Kiwi Ears' web EQ (equalizer.kiwiears.com) decoded from a device (a `kiwi-ears-eq` snapshot)
// and wrote to it, checked against what ktmicro-usb-hid and the device's profile say about the same
// bytes. Each check returns disagreements as sentences; none means they all agree.

import type { Profile } from '@potatosalad775/eqcaps-core';
import { ktmicroCodec, type KtmicroHidOptions } from '../src/handlers/ktmicro-usb-hid.ts';
import { openDevice, protocolOf, type HidTransport } from '../src/index.ts';
import { profiles } from './data.ts';
import {
	deviceAt,
	exchangesOf,
	matchProfile,
	RecordingReplay,
	type Recording,
	type Snapshot
} from './recording.ts';

/** The parts of the app's `equalizerKt` store the checks read. */
export interface KiwiState {
	filters: { type: string; frequency: number; gain: number; Q: number }[];
	dacEqEnabled: boolean;
	globalGainDb: number;
	globalGainIndex: number;
	globalGainConfig: {
		type: 'steps' | 'linear';
		steps?: { index: number; db: number | null }[];
		minDb?: number;
		maxDb?: number;
		step?: number;
	} | null;
}

const READ = 0x52;
const WRITE = 0x57;
const SAVE = 0x53;
const GAIN_REGISTER = 0x3b;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const hex = (d: ArrayLike<number>) =>
	Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');

export function profileFor(
	recording: Recording,
	_state: unknown,
	all: Iterable<Profile>,
	device = 0
): Profile | string {
	return matchProfile(recording, undefined, all, device);
}

/**
 * Reads: what the handler reads from the answers the app got, against what the app shows. A value
 * the app wrote after its last read of that register is skipped: it shows what it wrote, which no
 * answer holds (the writes are checked by `checkWrites`).
 */
export async function checkReads(
	recording: Recording,
	snapshot: Snapshot,
	profile: Profile
): Promise<string[]> {
	const state = snapshot.state as KiwiState;
	const out: string[] = [];
	const device = deviceAt(recording, snapshot.t);
	const before = exchangesOf(recording, device).filter((x) => x.t < snapshot.t);
	const stale = (register: number) => {
		const of = before.filter((x) => x.request[0] === register);
		return of.at(-1)?.request[4] === WRITE;
	};
	const protocol = protocolOf(profile)!;
	const options = protocol.options as KtmicroHidOptions;
	const open = () =>
		openDevice(new RecordingReplay(recording, { device, until: snapshot.t }), protocol, {
			profile,
			sleep: () => Promise.resolve()
		});

	const { filters } = await open().pull({ bands: state.filters.length });
	state.filters.forEach((app, i) => {
		const regs = options.bandRegisters?.[i] ?? { freq: 0x26 + 2 * i, q: 0x27 + 2 * i };
		if (stale(regs.freq) || stale(regs.q)) return;
		const ours = filters[i];
		// The app ignores the type byte and shows every band as peaking.
		const agree =
			ours && ours.freq === app.frequency && near(ours.gain, app.gain) && near(ours.q, app.Q);
		if (!agree) {
			out.push(
				`${snapshot.label}, band ${i}: the handler reads ${JSON.stringify(ours)}, the app ${JSON.stringify(app)}`
			);
		}
	});

	if (!stale(options.enableRegister!)) {
		const on = await open().eqEnabled();
		if (on !== state.dacEqEnabled) {
			out.push(`${snapshot.label}: the handler reads EQ ${on}, the app ${state.dacEqEnabled}`);
		}
	}
	if (!stale(GAIN_REGISTER) && state.globalGainConfig) {
		const values = await open().readControls();
		const steps = state.globalGainConfig.type === 'steps';
		const ours = steps ? values['globalGain'] : values['globalGainDb'];
		const app = steps ? state.globalGainIndex : state.globalGainDb;
		if (ours !== app) out.push(`${snapshot.label}: the handler reads gain ${ours}, the app ${app}`);
	}
	return out;
}

/** Data: what the profile says the device offers, against the app's config and what it read. */
export function checkData(snapshot: Snapshot, profile: Profile): string[] {
	const state = snapshot.state as KiwiState;
	const out: string[] = [];
	if (state.filters.length !== profile.bandCount) {
		out.push(`the app uses ${state.filters.length} bands, ${profile.id} ${profile.bandCount}`);
	}
	if (state.filters.some((f) => f.type !== 'peaking12') || profile.band?.types?.join() !== 'PK') {
		out.push(`types: the app has peaking only, ${profile.id} ${profile.band?.types?.join()}`);
	}
	const control = protocolOf(profile)?.controls?.find((c) => c.id.startsWith('globalGain'));
	const config = state.globalGainConfig;
	if (!config !== !control) {
		out.push(`global gain: the app ${config ? 'has' : 'has no'} one, ${profile.id} disagrees`);
	}
	if (config?.type === 'steps' && control?.kind === 'choice') {
		const name = (db: number | null) => (db === null ? 'Mute' : `${db > 0 ? '+' : ''}${db} dB`);
		const app = config.steps!.map((s) => `${s.index} ${name(s.db)}`).join();
		const ours = (control.values ?? []).map((v) => `${v.value} ${v.name}`).join();
		if (app !== ours) out.push(`global gain: the app has ${app}, ${profile.id} ${ours}`);
	}
	return out;
}

/** A device that takes writes, answers with `flag`, and answers reads with what it was last told. */
function sink(flag: number) {
	const sent: number[][] = [];
	const held = new Map<number, number[]>();
	const listeners = new Set<(id: number, d: Uint8Array) => void>();
	const transport: HidTransport = {
		kind: 'hid',
		vendorId: 0,
		productId: 0,
		productName: '',
		collections: [],
		sendReport: async (_id, d) => {
			const answer = [...d];
			if (d[4] === READ) answer.splice(6, 4, ...(held.get(d[0]!) ?? [0, 0, 0, 0]));
			else {
				sent.push([...d]);
				held.set(d[0]!, [...d].slice(6));
				answer[6] = flag;
			}
			for (const l of listeners) l(0x4b, Uint8Array.from(answer));
		},
		sendFeatureReport: async () => {},
		receiveFeatureReport: async () => new Uint8Array(64),
		onInputReport: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		close: async () => {}
	};
	return { transport, sent };
}

/**
 * Writes: every write and save the app sent is one the handler sends as the same bytes, and the
 * device answered it with the flag the profile names. The enable register's value 3 is the
 * recording's own clean-up (see its notes), which the app's UI can't send.
 */
export async function checkWrites(recording: Recording): Promise<string[]> {
	const out: string[] = [];
	for (const [d] of recording.devices.entries()) {
		const profile = matchProfile(recording, undefined, [...profiles.values()], d);
		if (typeof profile === 'string') {
			out.push(profile);
			continue;
		}
		const protocol = protocolOf(profile)!;
		const options = protocol.options as KtmicroHidOptions;
		const open = () => {
			const s = sink(options.writeAck!);
			return {
				...s,
				device: openDevice(s.transport, protocol, { profile, sleep: () => Promise.resolve() })
			};
		};
		for (const x of exchangesOf(recording, d)) {
			const f = x.request;
			if (f[4] !== WRITE && f[4] !== SAVE) continue;
			const at = `write ${hex(f)} at ${x.t} ms`;
			if (x.answers.at(-1)?.[6] !== options.writeAck) {
				out.push(`${at}: the device answered flag ${x.answers.at(-1)?.[6]}`);
			}
			const { device, sent } = open();
			if (f[4] === SAVE) {
				sent.push(
					ktmicroCodec
						.encode({ filters: [] }, options)
						.map((c) => [...c.data])
						.at(-1)!
				);
			} else if (f[0] === options.enableRegister) {
				if (f[6] === 3) continue;
				await device.setEnabled(f[6] === 1);
			} else if (f[0] === GAIN_REGISTER && !options.bandRegisters) {
				await device.writeControl('globalGain', f[6]!);
			} else {
				const gain = ((f[6]! | (f[7]! << 8)) << 16) >> 16;
				const filter = { type: 'PK', freq: f[8]! | (f[9]! << 8), q: 1, gain: gain / 10 } as const;
				const band = (f[0]! - 0x26) / 2;
				const frames = ktmicroCodec.encode(
					{ filters: Array.from({ length: band + 1 }, () => filter) },
					options
				);
				sent.push([...frames[band * 2]!.data]);
			}
			const ours = sent.at(-1)!;
			if (hex(ours) !== hex(f)) out.push(`${at}: the handler sends ${hex(ours)}`);
		}
	}
	return out;
}
