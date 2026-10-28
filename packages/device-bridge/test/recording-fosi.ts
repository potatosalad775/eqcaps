// What Fosi Audio's web control center decoded from a device (a `fosi-cc` snapshot), checked
// against what the fosi-audio-usb-hid handler and the device's profile say about the same bytes.
// Each check returns disagreements as sentences; none means the handler, the data and the
// vendor app agree.

import { matchDevice } from '@potatosalad775/eqcaps-client';
import { controlTakes, type Filter, type Profile } from '@potatosalad775/eqcaps-core';
import { identityOf, openDevice, protocolOf, type HidHandler } from '../src/index.ts';
import {
	decodeFosiBand,
	encodeFosiBand,
	FOSI_CONTROL_COMMANDS,
	FOSI_TYPES,
	fosiAudioCodec,
	fosiAudioUsbHid
} from '../src/handlers/fosi-audio-usb-hid.ts';
import { exchangesOf, RecordingReplay, type Recording, type Snapshot } from './recording.ts';

/** The parts of a Fosi store's device info (`ds3DeviceInfo` and alike) the checks read. */
export interface FosiState {
	firmwareVersion?: string;
	eqModeCount?: { total: number; predefined: number } | 0;
	eqModeInfo?: {
		index: number;
		gain: number;
		nameRaw?: string;
		bandList?: {
			bandIndex: number;
			filterType: number;
			centerFreq: number;
			q: number;
			gain: number;
		}[];
	}[];
	volume?: number;
	gainMode?: number;
	filterMode?: number;
	gameMode?: number;
	upsampleEnable?: boolean;
	currentUacMode?: number;
	ledSwitch?: number;
}

/** Each control as the app holds it. */
const STATE_OF: Record<string, (s: FosiState) => number | undefined> = {
	volume: (s) => s.volume,
	gainMode: (s) => s.gainMode,
	filterMode: (s) => s.filterMode,
	gameMode: (s) => s.gameMode,
	upsample: (s) => (s.upsampleEnable === undefined ? undefined : Number(s.upsampleEnable)),
	uacMode: (s) => s.currentUacMode,
	led: (s) => s.ledSwitch
};

const same = (a: number, b: number) => Math.fround(a) === Math.fround(b);

/** A band as the app holds it, as a filter; null for a bypassed or empty band. */
function appFilter(
	b: NonNullable<NonNullable<FosiState['eqModeInfo']>[number]['bandList']>[number]
) {
	if (b.filterType === 0 || (b.centerFreq === 0 && b.gain === 0)) return null;
	return { type: FOSI_TYPES.decode(b.filterType), freq: b.centerFreq, q: b.q, gain: b.gain };
}

const show = (f: Filter | null) => (f ? `${f.type} ${f.freq} Hz Q ${f.q} ${f.gain} dB` : 'empty');

/** The profile an app would pick for the recorded device, given the firmware the app read. */
export function profileFor(
	recording: Recording,
	state: FosiState,
	profiles: Iterable<Profile>
): Profile | string {
	const identity = identityOf(new RecordingReplay(recording));
	const firmware = state.firmwareVersion || undefined;
	const result = matchDevice([...profiles], { ...identity, ...(firmware ? { firmware } : {}) });
	if (!result.best) {
		return result.ambiguous
			? `matches ${result.matches.map((m) => m.id).join(', ')} equally`
			: `no profile matches ${identity.usb?.productName} on firmware ${firmware}`;
	}
	return [...profiles].find((p) => p.id === result.best!.id)!;
}

/** Reads: what the handler reads from the answers the app got, against what the app shows. */
export async function checkReads(
	recording: Recording,
	snapshot: Snapshot,
	profile: Profile
): Promise<string[]> {
	const state = snapshot.state as FosiState;
	const out: string[] = [];
	const protocol = protocolOf(profile)!;
	const open = () =>
		openDevice(new RecordingReplay(recording, { until: snapshot.t }), protocol, {
			profile,
			sleep: () => Promise.resolve()
		});

	const firmware = await open().firmware();
	if (state.firmwareVersion && firmware !== state.firmwareVersion) {
		out.push(`firmware: the handler reads ${firmware}, the app ${state.firmwareVersion}`);
	}

	for (const mode of state.eqModeInfo ?? []) {
		if (!mode?.bandList?.length) continue;
		const at = `preset ${mode.index}`;
		let pulled;
		try {
			pulled = await open().pull({ slot: mode.index });
		} catch (e) {
			out.push(`${at}: the handler can't read it (${(e as Error).message})`);
			continue;
		}
		const bands = mode.bandList.filter(Boolean);
		if (pulled.filters.length !== bands.length) {
			out.push(`${at}: the handler reads ${pulled.filters.length} bands, the app ${bands.length}`);
		}
		for (const b of bands) {
			let app: Filter | null;
			try {
				app = appFilter(b);
			} catch {
				out.push(`${at} band ${b.bandIndex}: type code ${b.filterType} has no eqcaps type`);
				continue;
			}
			const ours = pulled.filters[b.bandIndex] ?? null;
			const agree =
				app === null
					? ours === null
					: ours !== null &&
						ours.type === app.type &&
						same(ours.freq, app.freq) &&
						same(ours.q, app.q) &&
						same(ours.gain, app.gain);
			if (!agree) {
				out.push(
					`${at} band ${b.bandIndex}: the handler reads ${show(ours)}, the app ${show(app)}`
				);
			}
		}
		if (pulled.preamp !== mode.gain) {
			out.push(`${at}: the handler reads pre-gain ${pulled.preamp}, the app ${mode.gain}`);
		}
	}

	const values = await open().readControls();
	for (const [id, value] of Object.entries(values)) {
		const app = STATE_OF[id]?.(state);
		if (value !== null && app !== undefined && value !== app) {
			out.push(`control ${id}: the handler reads ${value}, the app ${app}`);
		}
	}
	return out;
}

/** Data: what the profile says the device offers, against what the app read from it. */
export function checkData(snapshot: Snapshot, profile: Profile): string[] {
	const state = snapshot.state as FosiState;
	const out: string[] = [];
	const presets = profile.protocol?.presets ?? [];
	const count = state.eqModeCount || undefined;
	if (count) {
		for (let id = 0; id < count.total; id++) {
			const listed = presets.find((p) => p.id === id);
			const builtIn = id < count.predefined;
			const name = state.eqModeInfo?.[id]?.nameRaw?.trim();
			if (!listed) out.push(`preset ${id} (${name || 'no name'}) isn't in ${profile.id}`);
			else if (!builtIn && !listed.writable)
				out.push(`preset ${id} is a user preset, not marked writable`);
			else if (builtIn && listed.writable)
				out.push(`preset ${id} is built in, but marked writable`);
			else if (builtIn && name && listed.name !== name) {
				out.push(`preset ${id} is "${name}" on the device, "${listed.name}" in ${profile.id}`);
			}
		}
		for (const p of presets) {
			if (p.id >= count.total) out.push(`preset ${p.id} is in ${profile.id}, not on the device`);
		}
	}
	const longest = Math.max(0, ...(state.eqModeInfo ?? []).map((m) => m?.bandList?.length ?? 0));
	if (longest > (profile.bandCount ?? Infinity)) {
		out.push(`a preset holds ${longest} bands, ${profile.id} allows ${profile.bandCount}`);
	}
	for (const c of profile.protocol?.controls ?? []) {
		const value = STATE_OF[c.id]?.(state);
		if (value !== undefined && !controlTakes(c, value)) {
			out.push(`control ${c.id}: the app read ${value}, which ${profile.id} doesn't list`);
		}
	}
	return out;
}

/** The handler's frame for a write the app made, or why it has none; undefined if not ours. */
async function oursFor(d: Uint8Array): Promise<Uint8Array | string | undefined> {
	try {
		if (d[1] === 0x8d) {
			const band = decodeFosiBand(d);
			return band?.filter ? encodeFosiBand(d[2]!, band.band, band.filter, {}) : undefined;
		}
		if (d[1] === 0x8c) {
			// The session writes the name the preset already has, as the app does: take the app's.
			const preamp = new DataView(d.buffer, d.byteOffset).getInt32(3, true);
			const frames = fosiAudioCodec.encode({ filters: [], preamp, slot: d[2]! }, {});
			const ours = Uint8Array.from(frames.find((f) => f.data[1] === 0x8c)!.data);
			ours.set(d.subarray(7, 23), 7);
			return ours;
		}
	} catch (e) {
		return (e as Error).message;
	}
	const control = Object.entries(FOSI_CONTROL_COMMANDS).find(([, c]) => c.set === d[1]);
	if (!control) return undefined;
	const [id, c] = control;
	const sent: Uint8Array[] = [];
	const spy = new RecordingReplay(EMPTY);
	spy.sendReport = async (_r, data) => void sent.push(Uint8Array.from(data));
	await (fosiAudioUsbHid as HidHandler<object>).controls![id]!.write(
		{ transport: spy, options: {}, sleep: () => Promise.resolve(), log: () => {} },
		d[c.index === undefined ? 2 : 3]!
	);
	return sent[0];
}

const EMPTY = {
	devices: [{ vendorId: 0, productId: 0, productName: '' }],
	events: []
} as unknown as Recording;

/**
 * Writes: every band and control write the app sent, against the frame the handler sends for the
 * same values (a pre-gain write with the app's preset name). The bandwidth field (bytes 13–16 of a band) is left out: the handler writes its
 * `bandwidth` option (default 0) where the app writes 1, as devicePEQ did.
 */
export async function checkWrites(recording: Recording): Promise<string[]> {
	const out: string[] = [];
	for (const x of exchangesOf(recording)) {
		const ours = await oursFor(x.request);
		if (ours === undefined) continue;
		const cmd = `0x${x.request[1]!.toString(16)}`;
		if (typeof ours === 'string') {
			out.push(`write ${cmd} at ${x.t} ms: the handler can't send it (${ours})`);
			continue;
		}
		const skip = x.request[1] === 0x8d ? new Set([13, 14, 15, 16]) : new Set<number>();
		const differ = [...x.request].findIndex((b, i) => !skip.has(i) && b !== (ours[i] ?? 0));
		if (differ >= 0) {
			out.push(
				`write ${cmd} at ${x.t} ms: byte ${differ} is ${x.request[differ]} from the app, ${ours[differ]} from the handler`
			);
		}
	}
	return out;
}
