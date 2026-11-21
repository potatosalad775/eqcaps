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
	toppingConfigName,
	toppingNameWords,
	toppingNewConfigWords,
	toppingWriteFrames,
	type ToppingFrame
} from '../src/handlers/topping-usb-hid.ts';
import { BridgeError, openDevice, protocolOf, type HidTransport } from '../src/index.ts';
import { profiles } from './data.ts';
import { deviceAt, fromHex, matchProfile, type Recording, type Snapshot } from './recording.ts';

const READ = 0x10;
const AGREEMENT = 0x1120;
const UPLOAD = 0x1106;
const NEW_CONFIG = 0x110b;
const SET_NAME_INDEX = 0x110c;
const SET_NAME = 0x110d;
const DELETE_CONFIG = 0x110a;
const SWITCH_CONFIG = 0x110e;
const ACTIVE_CONFIG = 0x1206;
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
		// A config-list session writes the active config back once, when the app connects.
		const expected = isConfigSession(recording) ? EXPECTED.slice(0, 1) : EXPECTED;
		if (states.length !== expected.length) {
			out.push(`the app wrote ${states.length} full configs, the notes say ${expected.length}`);
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
			const want = expected[n];
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
	if (isConfigSession(recording)) out.push(...(await checkConfigs(recording)));
	return out;
}

/** A session in which the app created, renamed and deleted a config (it sent a whole new one). */
const isConfigSession = (recording: Recording) =>
	framesOf(recording, 'output').some((x) => x.frame.command === NEW_CONFIG);

/** The config lists the device answered (command 0x1106), each a run of configs as words. */
function listsOf(recording: Recording, device = 0) {
	const lists: { t: number; configs: number[][] }[] = [];
	for (const { t, frame } of framesOf(recording, 'input', device)) {
		if (frame.command !== UPLOAD) continue;
		if (frame.frames === 2) {
			if (frame.frame === 0) lists.push({ t, configs: [] });
		} else if (frame.frames >= 70) {
			const list = lists.at(-1);
			if (!list) continue;
			if (frame.frame === 0) list.configs.push([]);
			list.configs.at(-1)![frame.frame] = frame.data;
		}
	}
	return lists;
}

/** The first difference between two frame sequences by command, kind and numbering, or none. */
function shapeDiff(ours: readonly ToppingFrame[], theirs: readonly ToppingFrame[]) {
	if (ours.length !== theirs.length) return `${ours.length} frames, the app sent ${theirs.length}`;
	for (const [i, a] of ours.entries()) {
		const b = theirs[i]!;
		if (
			a.command !== b.command ||
			a.kind !== b.kind ||
			a.frames !== b.frames ||
			a.frame !== b.frame
		) {
			return `frame ${i} is ${describeFrame(a)}, the app sent ${describeFrame(b)}`;
		}
	}
	return undefined;
}

const wordsOf = (frames: readonly ToppingFrame[]) => frames.map((f) => f.data);
const sameWords = (a: readonly number[], b: readonly number[]) =>
	a.length === b.length && a.every((w, i) => w === b[i]);

/**
 * Configs: what the app did to the list in a session that created, renamed and deleted one. The
 * handler reads the list the app first read; the app's new config has the name's four words (the
 * band count in the last byte) and then what the active config held, where the handler sends an
 * empty one, so the handler's frames are compared for their numbering and name only; the name
 * writes and the delete are the same frames (the handler's slot is the last the replayed device
 * holds, one below the app's); and the lists the device answered are the five it started with.
 */
export async function checkConfigs(recording: Recording): Promise<string[]> {
	const out: string[] = [];
	const device = 0;
	const connected = recording.snapshots.find((s) => s.label === 'connected');
	if (!connected) return ['the recording has no "connected" snapshot'];
	const profile = profileFor(recording, undefined, [...profiles.values()], device);
	if (typeof profile === 'string') return [profile];
	const protocol = protocolOf(profile)!;
	const NAMES = ['Bass 1', 'Bass 2', 'Airy', 'Warm', 'Dynamic'];

	// The handler reads the list as the device first answered it.
	const replayed = () => {
		const transport = new ToppingReplay(recording, device, connected.t);
		const bridge = openDevice(transport, protocol, { profile, sleep: () => Promise.resolve() });
		return { transport, bridge };
	};
	const slots = await replayed().bridge.slots();
	if (slots.length !== NAMES.length || slots.some((s, i) => s.id !== i || s.name !== NAMES[i])) {
		out.push(
			`the handler lists the configs ${JSON.stringify(slots.map((s) => [s.id, s.name]))}, the app showed ${JSON.stringify(NAMES)} as 0 to 4`
		);
	}

	const outputs = framesOf(recording, 'output', device);
	const lists = listsOf(recording, device);
	for (const list of lists) {
		const names = list.configs.map(toppingConfigName);
		if (
			!sameWords(
				names.map((n) => n.length),
				NAMES.map((n) => n.length)
			) ||
			names.join() !== NAMES.join()
		) {
			out.push(
				`the list the device answered at ${list.t} ms holds ${names.join(', ')}, not ${NAMES.join(', ')}`
			);
		}
	}

	// Create.
	const created = outputs.filter((x) => x.frame.command === NEW_CONFIG);
	const first = created[0];
	const config = created.map((x) => x.frame);
	if (!first) return [...out, 'the app sent no new config'];
	const last = created.at(-1)!;
	const sentAs = (command: number, after: number, until = Infinity) =>
		outputs.filter((x) => x.frame.command === command && x.t > after && x.t < until);
	if (
		config.length !== 74 ||
		config.some((f, i) => f.frames !== 74 || f.frame !== i || f.kind !== 0x20)
	) {
		out.push("the app's new config is not 74 frames of 0x110b, numbered 0 to 73 of 74, kind 0x20");
	}
	const name = toppingNameWords('devconfig6');
	const empty = toppingNewConfigWords('devconfig6');
	const words = wordsOf(config);
	const head = name.map((w, i) => (i === 3 ? (w | (11 << 24)) >>> 0 : w));
	if (!sameWords(words.slice(0, 4), head) || !sameWords(words.slice(0, 4), empty.slice(0, 4))) {
		out.push(
			`the app's new config starts ${words.slice(0, 4).map(hex).join(' ')}, not "devconfig6" with 11 in the top byte`
		);
	}
	const before = lists
		.filter((l) => l.t < first.t)
		.at(-1)
		?.configs.find((c) => toppingConfigName(c) === 'Bass 1');
	if (!before) out.push('the list the app read before creating has no Bass 1 to copy');
	else {
		const at = words.findIndex((w, i) => i >= 4 && w !== before[i]);
		if (at >= 0) {
			out.push(
				`the app's new config differs from Bass 1 at word ${at}: ${hex(words[at]!)}, ${hex(before[at]!)}`
			);
		}
	}
	// The name, with the new index, and no select: the device announces the new config itself.
	const index = sentAs(SET_NAME_INDEX, last.t)[0];
	const nameFrames = sentAs(SET_NAME, last.t, index ? index.t + 1000 : Infinity).map(
		(x) => x.frame
	);
	if (index?.frame.data !== 5)
		out.push(
			`after the new config the app sends 0x110c=${index ? hex(index.frame.data) : 'nothing'}, not 5`
		);
	if (
		nameFrames.length !== 4 ||
		nameFrames.some((f, i) => f.frames !== 4 || f.frame !== i || f.kind !== 0x20) ||
		!sameWords(wordsOf(nameFrames), name)
	) {
		out.push(
			"after the new config the app does not send the name's four 0x110d frames, numbered 0 to 3 of 4"
		);
	}
	const stray = outputs.find(
		(x) =>
			x.frame.command === SWITCH_CONFIG &&
			x.t > first.t &&
			x.t < (sentAs(SET_NAME_INDEX, last.t)[1]?.t ?? Infinity)
	);
	if (stray)
		out.push(
			`the app selects a config (${describeFrame(stray.frame)}) between creating a config and renaming it, at ${stray.t} ms`
		);
	const announced = framesOf(recording, 'input', device).find(
		(x) => x.frame.command === ACTIVE_CONFIG && x.t > last.t && x.t < (index?.t ?? Infinity)
	);
	if (announced?.frame.data !== 5)
		out.push('the device does not announce 0x1206 = 5 after the new config');

	// Rename.
	const renames = sentAs(SET_NAME_INDEX, last.t).slice(1);
	const rename = renames[0];
	const renamed = rename ? sentAs(SET_NAME, rename.t, rename.t + 1000).map((x) => x.frame) : [];
	if (!rename || rename.frame.data !== 5) out.push('the rename does not start with 0x110c = 5');
	if (
		renamed.length !== 4 ||
		renamed.some((f, i) => f.frames !== 4 || f.frame !== i) ||
		!sameWords(wordsOf(renamed), toppingNameWords('eqcaps test 1'))
	) {
		out.push('the rename is not the four 0x110d frames of "eqcaps test 1"');
	}

	// Delete: 0x110a, 0x110e = 0, then the list request.
	const del = outputs.findIndex((x) => x.frame.command === DELETE_CONFIG);
	const after = outputs.slice(del, del + 3).map((x) => x.frame);
	if (
		del < 0 ||
		after[0]!.data !== 5 ||
		after[1]?.command !== SWITCH_CONFIG ||
		after[1].data !== 0 ||
		after[2]?.command !== AGREEMENT ||
		after[2].data !== 1
	) {
		out.push(
			'the delete is not 0x110a = 5, 0x110e = 0 and the list request 0x1120 = 1, in that order'
		);
	}
	const final = lists.at(-1);
	if (!final || final.t < outputs[del]!.t)
		out.push('the app does not read the list after the delete');

	// The handler's own frames, as the app's: the replayed device never grows, so each act ends in
	// the handler's own check of the list and is cut short, after the frames compared here. It
	// renames and deletes the last config the device holds (4) where the app's was 5.
	const run = async (act: (b: ReturnType<typeof replayed>['bridge']) => Promise<unknown>) => {
		const r = replayed();
		await act(r.bridge).catch(() => undefined);
		return r.transport.sent;
	};
	const ours = await run((b) => b.createSlot({ name: 'devconfig6' }));
	const ourConfig = ours.filter((f) => f.command === NEW_CONFIG);
	const diff = shapeDiff(ourConfig, config);
	if (diff) out.push(`the handler's new config: ${diff}`);
	else if (!sameWords(wordsOf(ourConfig).slice(0, 4), words.slice(0, 4))) {
		out.push("the handler's new config does not start with the words the app's does");
	}
	const ourName = ours.filter((f) => f.command === SET_NAME_INDEX || f.command === SET_NAME);
	const appName = [index!.frame, ...nameFrames];
	const nameDiff = shapeDiff(ourName, appName);
	if (nameDiff) out.push(`the handler's name after a new config: ${nameDiff}`);
	else if (!ourName.every((f, i) => f.data === appName[i]!.data)) {
		out.push("the handler's name after a new config is not the app's words");
	}
	if (ours.some((f) => f.command === SWITCH_CONFIG)) {
		out.push('the handler selects the new config, which a DX5 II does by itself');
	}

	const renameSent = (await run((b) => b.renameSlot(4, 'eqcaps test 1'))).filter(
		(f) => f.command === SET_NAME_INDEX || f.command === SET_NAME
	);
	const appRename = [rename!.frame, ...renamed];
	const renameDiff = shapeDiff(renameSent, appRename);
	if (renameDiff) out.push(`the handler's rename: ${renameDiff}`);
	else if (
		renameSent[0]!.data !== 4 ||
		!renameSent.slice(1).every((f, i) => f.data === appRename[i + 1]!.data)
	) {
		out.push("the handler's rename is not the app's words, with the index 4");
	}

	const deleteSent = (await run((b) => b.deleteSlot(4))).filter(
		(f) => f.command === DELETE_CONFIG || f.command === SWITCH_CONFIG || f.command === AGREEMENT
	);
	const deleteDiff = shapeDiff(deleteSent.slice(1), after.length === 3 ? after : []);
	if (deleteDiff) out.push(`the handler's delete: ${deleteDiff}`);
	else if (deleteSent[1]!.data !== 4 || deleteSent[2]!.data !== 0) {
		out.push("the handler's delete is not 0x110a = 4 then 0x110e = 0");
	}
	return out;
}
