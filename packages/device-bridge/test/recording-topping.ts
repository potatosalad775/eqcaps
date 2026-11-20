// What Topping's web app (home.toppingaudio.com) did with a DX5 II (a `topping-home` recording) and
// what the device answered, checked against what topping-usb-hid and the device's profile say
// about the same frames. Each check returns disagreements as sentences; none means they all agree.
//
// The snapshot holds nothing (`store: 'none'`): the app's state is read from the frames. Every
// event is one 16-byte report; `output` is what the app sent, `input` what the device answered
// or volunteered. The app's heartbeat (0x7134) and its echoes are left out throughout.

import { validate, type Filter, type Profile } from '@potatosalad775/eqcaps-core';
import {
	parseToppingFrame,
	toppingCodec,
	toppingWriteFrames,
	type ToppingFrame
} from '../src/handlers/topping-usb-hid.ts';
import { BridgeError, openDevice, protocolOf, type HidTransport } from '../src/index.ts';
import { profiles } from './data.ts';
import { deviceAt, fromHex, matchProfile, type Recording, type Snapshot } from './recording.ts';

const READ = 0x10;
const AGREEMENT = 0x1120;
const UPLOAD = 0x1106;
const PEQ_STATE = 0x7132;
const HEARTBEAT = 0x7134;
const PREAMP_LEFT = 0x9c01;
const FAMILY = { family: 'dx5' } as const;
/** The pre-gain's four commands, then 11 bands of 10 commands. */
const RUN_LENGTH = 4 + 11 * 10;
const CONFIGS = 5;

/** What the app's screen showed (the recording's notes): volume -30.0 dB, USB, HP SE. */
const CONTROLS = {
	volume: -30,
	mute: 0,
	input: 0,
	output: 3,
	gain: 0,
	lineMode: 0,
	dacFilter: 0,
	balance: 0,
	polarity: 0,
	crossfeed: 2,
	brightness: 1
};

const hex = (n: number) => `0x${n.toString(16)}`;
const describeFrame = (f: ToppingFrame) =>
	`${hex(f.command)}=${hex(f.data)} (kind ${hex(f.kind)}, ${f.frame} of ${f.frames})`;
const same = (a: ToppingFrame, b: ToppingFrame) =>
	a.command === b.command &&
	a.data === b.data &&
	a.kind === b.kind &&
	a.frames === b.frames &&
	a.frame === b.frame;

interface Timed {
	t: number;
	frame: ToppingFrame;
}

/** What `op` carried for one device, in order, as frames; the heartbeat and what isn't one left out. */
function framesOf(recording: Recording, op: 'output' | 'input', device = 0): Timed[] {
	const out: Timed[] = [];
	for (const e of recording.events) {
		if (e.device !== device || e.op !== op || e.data === undefined) continue;
		const frame = parseToppingFrame(fromHex(e.data));
		if (frame && frame.command !== HEARTBEAT) out.push({ t: e.t, frame });
	}
	return out;
}

/** A config the app wrote in full (pre-gain and every band), and where it sat in the output. */
interface Run {
	t: number;
	frames: ToppingFrame[];
}

const expectedCommands = toppingWriteFrames({ filters: [] }, FAMILY).map(
	(d) => parseToppingFrame(d.data)!.command
);

/**
 * The app's outputs split into full-config runs and the single frames around them. A run starts at
 * the pre-gain and holds every command of `toppingWriteFrames`; the pre-gain alone, as the app
 * sends it at an edit before the full config, is a loose frame group.
 */
function split(outputs: Timed[]) {
	const runs: Run[] = [];
	const loose: Timed[] = [];
	for (let i = 0; i < outputs.length;) {
		const slice = outputs.slice(i, i + RUN_LENGTH);
		const full =
			outputs[i]!.frame.command === PREAMP_LEFT &&
			slice.length === RUN_LENGTH &&
			slice.every((x, n) => x.frame.command === expectedCommands[n]);
		if (full) {
			runs.push({ t: outputs[i]!.t, frames: slice.map((x) => x.frame) });
			i += RUN_LENGTH;
		} else loose.push(outputs[i++]!);
	}
	return { runs, loose };
}

export function profileFor(
	recording: Recording,
	_state: unknown,
	all: Iterable<Profile>,
	device = 0
): Profile | string {
	const profile = matchProfile(recording, undefined, all, device);
	if (typeof profile !== 'string' && profile.id !== 'topping-dx5-ii') {
		return `the DX5 II matches ${profile.id}, not topping-dx5-ii`;
	}
	return profile;
}

/**
 * Replays the device's recorded answers as the handler asks: a read gets the input frames of the
 * same command, and so does the config list request. The app never sends some of these reads (the
 * firmware version, the active config, the EQ switch): the device volunteers the values when the
 * app connects, and the recording holds those. Every frame comes from before `until` ms, the
 * device as the app first found it. A frame sent is kept in `sent`; a read nothing answers, in
 * `unanswered`.
 */
class ToppingReplay implements HidTransport {
	readonly kind = 'hid' as const;
	readonly vendorId: number;
	readonly productId: number;
	readonly productName: string;
	readonly collections = [];
	readonly sent: ToppingFrame[] = [];
	readonly unanswered: ToppingFrame[] = [];
	private readonly heard = new Map<number, Uint8Array[]>();
	private readonly listeners = new Set<(reportId: number, data: Uint8Array) => void>();

	constructor(recording: Recording, device: number, until: number) {
		const d = recording.devices[device]!;
		this.vendorId = d.vendorId;
		this.productId = d.productId;
		this.productName = d.productName;
		for (const e of recording.events) {
			if (e.device !== device || e.op !== 'input' || e.t > until || e.data === undefined) continue;
			const bytes = fromHex(e.data);
			const frame = parseToppingFrame(bytes);
			if (!frame) continue;
			const list = this.heard.get(frame.command) ?? [];
			// A long answer is every frame of it; a one-word answer is the last the device gave.
			if (frame.frames > 1) list.push(bytes);
			else list.splice(0, list.length, bytes);
			this.heard.set(frame.command, list);
		}
	}

	async sendReport(_reportId: number, data: Uint8Array) {
		const frame = parseToppingFrame(data);
		if (!frame) return;
		this.sent.push(frame);
		const asks = frame.kind === READ || frame.command === AGREEMENT;
		if (!asks) return;
		const answer = this.heard.get(frame.command === AGREEMENT ? UPLOAD : frame.command);
		if (!answer) this.unanswered.push(frame);
		for (const bytes of answer ?? []) for (const l of [...this.listeners]) l(0, bytes);
	}
	async sendFeatureReport() {}
	async receiveFeatureReport() {
		return new Uint8Array(64);
	}
	onInputReport(listener: (reportId: number, data: Uint8Array) => void) {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}
	async close() {}
}

/** The first moment the app wrote a config: the device as it was found, before that. */
const firstWrite = (recording: Recording, device: number) =>
	framesOf(recording, 'output', device).find((x) => x.frame.command === PREAMP_LEFT)?.t ?? Infinity;

/**
 * Reads: the handler reads the recorded answers as the app did. The stored config it pulls is the
 * one the app wrote back when it connected, the device holds five configs, the firmware is 2.58
 * and the settings are what the app's screen showed.
 */
export async function checkReads(
	recording: Recording,
	snapshot: Snapshot,
	profile: Profile
): Promise<string[]> {
	const out: string[] = [];
	const device = deviceAt(recording, snapshot.t);
	const protocol = protocolOf(profile)!;
	const until = firstWrite(recording, device);
	const transports: ToppingReplay[] = [];
	const open = () => {
		const transport = new ToppingReplay(recording, device, until);
		transports.push(transport);
		return openDevice(transport, protocol, { profile, sleep: () => Promise.resolve() });
	};

	const firmware = await open().firmware();
	if (firmware !== '2.58') out.push(`the handler reads firmware ${firmware}, the app 2.58`);

	const first = split(framesOf(recording, 'output', device)).runs[0];
	try {
		const { filters, preamp } = await open().pull({ slot: 0 });
		const used = filters.filter((f): f is Filter => f !== null);
		if (used.length !== filters.findLastIndex((f) => f !== null) + 1) {
			out.push('the handler reads config 0 with a band switched off between used ones');
		}
		const ours = toppingWriteFrames(
			{ filters: used, ...(preamp === undefined ? {} : { preamp }) },
			FAMILY
		).map((d) => parseToppingFrame(d.data)!);
		out.push(...compare('config 0 as the handler reads it', ours, 'the app wrote back', first));
	} catch (error) {
		out.push(`the handler can't pull config 0: ${(error as Error).message}`);
	}

	for (let slot = 0; slot < CONFIGS; slot++) {
		try {
			await open().pull({ slot });
		} catch (error) {
			out.push(`the handler can't pull config ${slot}: ${(error as Error).message}`);
		}
	}
	try {
		await open().pull({ slot: CONFIGS });
		out.push(`the handler pulls config ${CONFIGS}, the device holds ${CONFIGS}`);
	} catch (error) {
		if (!(error instanceof BridgeError) || error.code !== 'invalid-request') {
			out.push(`config ${CONFIGS} is refused with ${(error as Error).message}`);
		}
	}

	const controls = await open().readControls();
	for (const [id, app] of Object.entries(CONTROLS)) {
		if (controls[id] !== app) {
			out.push(`control ${id}: the handler reads ${controls[id]}, the app showed ${app}`);
		}
	}
	for (const id of Object.keys(controls)) {
		if (!(id in CONTROLS)) out.push(`control ${id} is read, the app's screen showed no value`);
	}
	for (const f of transports.flatMap((t) => t.unanswered)) {
		out.push(`the handler asked ${describeFrame(f)}, which the recording has no answer to`);
	}
	return out;
}

/** Frame by frame differences between two sequences of frames, as sentences. */
function compare(
	ours: string,
	ourFrames: readonly ToppingFrame[],
	theirs: string,
	run: Run | undefined
): string[] {
	if (!run) return [`${theirs}: no full config in the recording`];
	const out: string[] = [];
	if (ourFrames.length !== run.frames.length) {
		out.push(`${ours}: ${ourFrames.length} frames, ${theirs} ${run.frames.length}`);
	}
	run.frames.forEach((app, i) => {
		const mine = ourFrames[i];
		if (mine && !same(mine, app)) {
			out.push(
				`${ours}, frame ${i}: ${describeFrame(mine)}, ${theirs} ${describeFrame(app)} at ${run.t} ms`
			);
		}
	});
	return out;
}

/** The filters, pre-gain and slot the app wrote last of every full config: what each edit left. */
function writtenStates(recording: Recording, device = 0) {
	const { runs } = split(framesOf(recording, 'output', device));
	return runs.map((run) => ({
		run,
		state: toppingCodec.decode(
			run.frames.map((f) => ({ reportId: 0, data: toppingFrameBytes(f) })),
			FAMILY
		)
	}));
}

function toppingFrameBytes(f: ToppingFrame) {
	return Uint8Array.from([
		0x22,
		0x33,
		f.kind,
		f.frames,
		f.frame,
		f.command >> 8,
		f.command & 0xff,
		f.data >>> 24,
		(f.data >>> 16) & 0xff,
		(f.data >>> 8) & 0xff,
		f.data & 0xff,
		0,
		0,
		0x66,
		0x77,
		0
	]);
}

/**
 * Data: the profile offers what the recording shows: at least the five configs the app listed,
 * and every type, frequency, gain, Q and pre-gain the app wrote is one it accepts.
 */
export function checkData(snapshot: Snapshot, profile: Profile, recording?: Recording): string[] {
	const out: string[] = [];
	const presets = profile.protocol?.presets ?? [];
	if (presets.length < CONFIGS) {
		out.push(`the device holds ${CONFIGS} configs, ${profile.id} lists ${presets.length}`);
	}
	presets.forEach((p, id) => {
		if (p.id !== id || !p.writable)
			out.push(`preset ${id} of ${profile.id} is not a writable config`);
	});
	if (!recording) return out;
	for (const { run, state } of writtenStates(recording, deviceAt(recording, snapshot.t))) {
		const slots = Array.from(
			{ length: profile.bandCount ?? 0 },
			(_, i) => state.filters[i] ?? null
		);
		for (const v of validate(profile, slots, state.preamp)) {
			out.push(
				`the app wrote a config at ${run.t} ms that ${profile.id} refuses: ${v.code} (${v.field ?? 'profile'}, slot ${v.slot})`
			);
		}
	}
	return out;
}

/** The state the app's notes say each full config holds, in order (see the recording's notes). */
const BAND2 = (freq: number, gain: number, q: number): Filter => ({ type: 'PK', freq, gain, q });
const EXPECTED = [
	// Connecting: the active config written back as it was read; the app read -2.9 dB for the word.
	undefined,
	// Pre-gain set to -3.0.
	{ preamp: -3, band2: BAND2(632, 0, 0.707) },
	{ preamp: -3, band2: BAND2(632, -1.5, 0.707) },
	{ preamp: -3, band2: BAND2(700, -1.5, 0.707) },
	{ preamp: -3, band2: BAND2(700, -1.5, 1.2345) },
	{ preamp: -3, band2: BAND2(700, 0, 1.2345) },
	{ preamp: -3, band2: BAND2(632, 0, 1.2345) },
	{ preamp: -3, band2: BAND2(632, 0, 0.707) }
];

/**
 * Writes: each full config the app sent is what the handler's codec decodes and encodes back as
 * the same frames, and the decoded state is what the notes say; an edit's single frames are in the
 * config that follows; the EQ switch the app wrote is the handler's `setEnabled`.
 */
export async function checkWrites(recording: Recording): Promise<string[]> {
	const out: string[] = [];
	for (const [device] of recording.devices.entries()) {
		const outputs = framesOf(recording, 'output', device);
		const { runs, loose } = split(outputs);
		const states = writtenStates(recording, device);
		if (states.length !== EXPECTED.length) {
			out.push(`the app wrote ${states.length} full configs, the notes say ${EXPECTED.length}`);
		}
		states.forEach(({ run, state }, n) => {
			const at = `config written at ${run.t} ms`;
			const encoded = toppingCodec
				.encode(
					{
						filters: state.filters as Filter[],
						...(state.preamp === undefined ? {} : { preamp: state.preamp }),
						slot: 0
					},
					FAMILY
				)
				.slice(1)
				.map((d) => parseToppingFrame(d.data)!);
			out.push(...compare(`the handler encodes the ${at}`, encoded, 'the app sent', run));
			const want = EXPECTED[n];
			if (!want) return;
			const band2 = state.filters[1];
			if (state.preamp !== want.preamp || JSON.stringify(band2) !== JSON.stringify(want.band2)) {
				out.push(
					`${at}: the handler decodes pre-gain ${state.preamp}, band 2 ${JSON.stringify(band2)}; the notes say ${want.preamp}, ${JSON.stringify(want.band2)}`
				);
			}
		});

		// The frames sent at an edit are the same commands and data as the config that follows.
		for (const { frame, t } of loose) {
			if (frame.command < 0x9000) continue;
			const next = runs.find((r) => r.t > t);
			const inRun = next?.frames.find((f) => f.command === frame.command);
			const message = `the frame ${describeFrame(frame)} at ${t} ms`;
			if (!inRun) out.push(`${message}: the config after it has no such command`);
			else if (!same(inRun, frame)) {
				out.push(`${message}: the config after it has ${describeFrame(inRun)}`);
			}
		}

		// The EQ switch: what `setEnabled` sends.
		const profile = matchProfile(recording, undefined, [...profiles.values()], device);
		if (typeof profile === 'string') {
			out.push(profile);
			continue;
		}
		const protocol = protocolOf(profile)!;
		for (const { t, frame } of outputs) {
			if (frame.command !== PEQ_STATE) continue;
			const transport = new ToppingReplay(recording, device, firstWrite(recording, device));
			const bridge = openDevice(transport, protocol, { profile, sleep: () => Promise.resolve() });
			await bridge.setEnabled(frame.data !== 0);
			const ours = transport.sent.at(-1);
			if (!ours || !same(ours, frame)) {
				out.push(
					`EQ switch at ${t} ms: the app sends ${describeFrame(frame)}, the handler ${ours ? describeFrame(ours) : 'nothing'}`
				);
			}
		}
	}
	return out;
}
