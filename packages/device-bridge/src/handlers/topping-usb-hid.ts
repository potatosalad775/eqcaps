// Topping's DACs on USB id 0x152a:0x8750 (DX1 II, DX5 II, E50 II, DX9 Discrete, D900), as
// Topping's web app (home.toppingaudio.com, "web v1.17.0", read 2026-11-20) drives them. Reads and
// writes were tried on a DX5 II (firmware 2.58); the other four families are unchecked.
//
// Every message is one 16-byte output report with id 0:
//   [0x22, 0x33, kind, frames, frame, command hi, command lo, data (u32 BE), 0, 0, 0x66, 0x77, 0]
// `kind` is 0x10 for a read and 0x20 for a write. An answer is an input report in the same layout,
// with or without one byte in front. A long answer comes as `frames` reports, one 32-bit word each.
//
// The five families share the EQ commands and differ in how a session starts, how the list of
// stored configs is asked for, and where the firmware version, the active config and the EQ switch
// are read (`family`). A config holds a name, a pre-gain and 11 bands per channel; the app's editor
// shows 10 bands and writes all 11. The app writes a config by selecting it (0x110E) and sending
// every parameter as its own command: 0x9C01–0x9C04 for the pre-gain and its switch, left and
// right, and 0x9000 | band << 8 | field for the bands (fields 1–5 left type, frequency, gain, Q
// and switch; 6–10 right). It sends no save command after them. Both channels get the same
// filters here (`channels: linked`); a pull returns the left channel's.
//
// Type codes are the editor's: 1 peak, 2 low pass, 3 high pass, 4 low shelf, 5 high shelf.
// Gain is in tenths of a dB, Q in ten-thousandths, frequency in Hz. The pre-gain word is a linear
// gain with 0 dB at 2^25. The app takes it from a table, except for the D900, where it computes
// 2^25 · 10^(dB/20); this handler does the same. The table is one 0.1 dB step off above +7.7 dB and
// below −10.3 dB and wrong at +3.5 and −4.9 dB, so there the device applies a slightly different
// gain than the number says, as it does from Topping's app. A recording of the app with a DX5 II
// showed why the table is kept: the app reads any other word as a neighbouring step.
//
// Left out, though the app does them: the heartbeat it sends every 1 or 5 s, the shutdown notice on
// disconnect, the L/R-mode mask (0x1112) after a save, the preview state, creating, renaming and
// deleting configs, and most settings besides the EQ.
//
// The DX5 II's settings are controls: one read (0x710C) answers a block of words, one per setting,
// and each setting is written with its own command, which the device takes at once. Tried on the
// DX5 II: each one read back as written. The other families' settings are not driven.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { be32, field, grid, I32, U32 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type {
	Codec,
	HandlerContext,
	HandlerControl,
	HidFrame,
	HidHandler,
	WriteState
} from '../handler.ts';
import { hidFrame, sendFrame, typeCodes } from '../io.ts';
import { after } from '../platform.ts';
import type { HidTransport } from '../transport.ts';

export type ToppingFamily = 'dx1' | 'dx5' | 'e50' | 'dx9d' | 'd900';

export interface ToppingHidOptions {
	/** Which of the five session and read flows the device speaks. Default `dx1`. */
	family?: ToppingFamily;
}

const READ = 0x10;
const WRITE = 0x20;

const CONNECT_STATE = 0x1101;
const UPLOAD = 0x1106;
const SWITCH_CONFIG = 0x110e;
const AGREEMENT = 0x1120;
const SOFTWARE_VERSION = 0x1202;
const EQ_ENABLE_STATE = 0x1204;
const CURRENT_CONFIG = 0x1206;
const GET_SETTINGS = 0x710c;
const PEQ_STATE = 0x7132;
const D900_CAPABILITIES = 0x7144;
const D900_RESULT = 0x7145;
const PREAMP_LEFT = 0x9c01;
const BAND = 0x9000;

/** `SWITCH_CONFIG` with this turns the EQ off on the DX1 II and E50 II. */
const NO_CONFIG = 0xffffffff;
const UNITY = 0x2000000;
const BANDS = 11;
/** Words of a config as the device sends it; the app accepts 70 or more. */
const CONFIG_WORDS = 70;
const LIST_TIMEOUT = 10000;
const ANSWER_TIMEOUT = 2000;

const TYPES = typeCodes('topping', { PK: 1, LPQ: 2, HPQ: 3, LSC: 4, HSC: 5 }, [[0, 'PK']]);

interface Family {
	/** `CONNECT_STATE` data. */
	connect: number;
	/** The request the config list answers. */
	list: readonly [command: number, data: number, kind: number];
	/** Single-frame commands are numbered 1 of 1, or 0 of 1 on the D900. */
	frame: 0 | 1;
	/** Words of the settings answer: firmware, active config, EQ switch. */
	settings?: { kind: number; firmware: number; slot?: number; enabled?: number };
	/** Pause after selecting a config, ms. */
	switchPause: number;
	/** Band commands between 10 ms pauses. */
	burst: number;
}

const FAMILIES: Record<ToppingFamily, Family> = {
	dx1: { connect: 1, list: [UPLOAD, 0, READ], frame: 1, switchPause: 60, burst: 20 },
	e50: {
		connect: 1,
		list: [UPLOAD, 0, READ],
		frame: 1,
		settings: { kind: READ, firmware: 31, slot: 14 },
		switchPause: 60,
		burst: 20
	},
	dx5: { connect: 2, list: [AGREEMENT, 1, WRITE], frame: 1, switchPause: 120, burst: 10 },
	dx9d: {
		connect: 2,
		list: [AGREEMENT, 1, WRITE],
		frame: 1,
		settings: { kind: READ, firmware: 46, slot: 55, enabled: 54 },
		switchPause: 60,
		burst: 20
	},
	d900: {
		connect: 2,
		list: [UPLOAD, 0, WRITE],
		frame: 0,
		settings: { kind: WRITE, firmware: 49, slot: 48, enabled: 47 },
		switchPause: 60,
		burst: 10
	}
};

const familyOf = (o: ToppingHidOptions) => FAMILIES[o.family ?? 'dx1'];

/** Firmware the app refuses to control: the DX5 II below 2.37, the E50 II below 1.52. */
const MIN_FIRMWARE: Partial<Record<ToppingFamily, number>> = { dx5: 0x237, e50: 0x152 };

export interface ToppingFrame {
	kind: number;
	frames: number;
	frame: number;
	command: number;
	data: number;
}

export function toppingFrame(
	command: number,
	data: number,
	kind = WRITE,
	frames = 1,
	frame = 1
): Uint8Array {
	return Uint8Array.from([
		0x22,
		0x33,
		kind,
		frames,
		frame,
		command >> 8,
		command & 0xff,
		...be32(data >>> 0),
		0,
		0,
		0x66,
		0x77,
		0
	]);
}

/** A report in the frame layout, with or without one byte in front; null for anything else. */
export function parseToppingFrame(d: ArrayLike<number>): ToppingFrame | null {
	const at = d[0] === 0x22 && d[1] === 0x33 ? 0 : d[1] === 0x22 && d[2] === 0x33 ? 1 : -1;
	if (at < 0 || d.length < at + 15 || d[at + 13] !== 0x66 || d[at + 14] !== 0x77) return null;
	return {
		kind: d[at + 2]!,
		frames: d[at + 3]!,
		frame: d[at + 4]!,
		command: (d[at + 5]! << 8) | d[at + 6]!,
		data: ((d[at + 7]! << 24) | (d[at + 8]! << 16) | (d[at + 9]! << 8) | d[at + 10]!) >>> 0
	};
}

/**
 * The pre-gain words the app sends, per 0.1 dB from 0 to 12 dB of cut and of boost. They are not
 * quite 2^25 · 10^(dB/20), and the app reads a word that is not in its table as the next step
 * towards 0 dB, then writes that back when it connects: so a computed word would shift by 0.1 dB
 * the first time Topping's app saw it.
 */
// prettier-ignore
const PREAMP_CUT = [33554432, 33170334, 32790632, 32415259, 32044214, 31677397, 31314807, 30956345, 30601977, 30251702, 29905387, 29563065, 29224668, 28890131, 28559452, 28232531, 27909335, 27589863, 27274048, 26961858, 26653224, 26348114, 26046527, 25748362, 25453620, 25162267, 24874235, 24589493, 24308004, 24029771, 23754692, 23482767, 23213962, 22948245, 22685547, 22425869, 22169178, 21915406, 21664553, 21416552, 21171403, 20929040, 20689494, 20452634, 20218524, 19987100, 19758292, 19532135, 19308528, 19308528, 18869032, 18653042, 18439502, 18228445, 18019770, 17813511, 17609600, 17408039, 17208759, 17011761, 16817045, 16624543, 16434222, 16246116, 16060157, 15876313, 15694582, 15514931, 15337328, 15161737, 14988194, 14816630, 14647012, 14479374, 14313616, 14149769, 13987802, 13827680, 13669404, 13512940, 13358254, 13205346, 13054183, 12904732, 12757025, 12610997, 12466645, 12323938, 12182876, 12043390, 11905548, 11769250, 11634529, 11501351, 11369717, 11239560, 11110912, 10983707, 10857979, 10733693, 10610817, 10489350, 10369292, 10250610, 10250610, 10133270, 10017273, 9902583, 9789237, 9677198, 9566402, 9456914, 9348667, 9241628, 9135865, 9031276, 8927894, 8825688, 8724655, 8624797, 8526080];
// prettier-ignore
const PREAMP_BOOST = [33554432, 33942958, 34335981, 34733601, 35135785, 35542632, 35954211, 36370521, 36791696, 37217703, 37648676, 38084615, 38525621, 38971727, 39423001, 39879509, 40341285, 40808430, 41280943, 41758960, 42242546, 42731669, 43226463, 43726994, 44233331, 44802347, 45263653, 45787807, 46318001, 46854335, 47396876, 47945693, 48500884, 49062518, 49630628, 50075157, 50786679, 51374754, 51969641, 52571439, 53180184, 53795975, 54418913, 55049032, 55686465, 56331314, 56983579, 57643427, 58310891, 58986107, 59669141, 60360061, 61058999, 61766058, 62481271, 63204772, 63936627, 64676972, 65425907, 66183499, 66949883, 67725124, 68509325, 69302652, 70105140, 70916922, 71738100, 72568774, 73409077, 74259112, 75119011, 75988843, 76868740, 77758839, 78659239, 79570074, 80491445, 81423520, 81423520, 82366332, 83320117, 84284907, 85260872, 86248144, 87246858, 88257115, 89279116, 90312894, 91358685, 92416556, 93486707, 94569207, 95664289, 96772022, 97892605, 99026141, 100172797, 101332740, 102506138, 103693093, 104893805, 106108408, 107337104, 108579994, 109837279, 111109159, 112395737, 113697213, 115013754, 116345563, 117692774, 119055587, 120434204, 121828760, 123239489, 124666526, 126110104, 127570360, 129047560, 130541873, 132053467];
/** A word some devices hold from the factory, which the app reads as -3 dB. */
const PREAMP_FACTORY_MINUS_3 = 0x16a77e5;

/** The pre-gain word for `db`: the app's table, or computed on the D900 as the app does there. */
export function toppingPreampWord(db: number, family?: ToppingFamily) {
	const tenths = field(db, 10, [-120, 120], 'preamp');
	if (family === 'd900') return Math.round(UNITY * 10 ** (tenths / 200));
	const table = tenths < 0 ? PREAMP_CUT : PREAMP_BOOST;
	const i = Math.abs(tenths);
	// The table repeats the step before at -4.9, -10.4 and +7.8 dB, so the app can't hold those.
	// A word halfway to the next step is one the app reads as the step meant.
	if (i > 0 && table[i] === table[i - 1]) return Math.round((table[i]! + table[i + 1]!) / 2);
	return table[i]!;
}

/** The pre-gain a word means, as the app reads it. */
function preampDb(word: number, family?: ToppingFamily) {
	if (family === 'd900') return word > 0 ? Math.round(200 * Math.log10(word / UNITY)) / 10 || 0 : 0;
	if (word === PREAMP_FACTORY_MINUS_3) return -3;
	if (word < UNITY) {
		const exact = PREAMP_CUT.indexOf(word);
		if (exact > 0) return -exact / 10;
		const i = PREAMP_CUT.findIndex(
			(v, n) => n > 0 && word < v && word > (PREAMP_CUT[n + 1] ?? Infinity)
		);
		return i > 0 ? -i / 10 : 0;
	}
	const exact = PREAMP_BOOST.indexOf(word);
	if (exact >= 0) return exact / 10;
	const i = PREAMP_BOOST.findIndex((v, n) => word > v && word < (PREAMP_BOOST[n + 1] ?? -Infinity));
	return i > 0 ? i / 10 : 0;
}

const OFF = { type: 1, freq: 632, gain: 0, q: 7070, on: 0 };

/**
 * The frames that select `slot` and write the request to both channels: the pre-gain, then the 11
 * bands, unused ones switched off at the app's defaults. The D900 gets all left bands before the
 * right ones, as the app sends them, and its 11th band as `reserved` (the app writes back what it
 * read there).
 */
export function toppingWriteFrames(
	request: { filters: readonly Filter[]; preamp?: number; slot?: number },
	o: ToppingHidOptions,
	reserved: { left: typeof OFF; right: typeof OFF } = { left: OFF, right: OFF }
): HidFrame[] {
	const family = familyOf(o);
	const d900 = o.family === 'd900';
	const { filters, preamp = 0, slot } = request;
	if (filters.length > BANDS - (d900 ? 1 : 0)) {
		throw new BridgeError(
			'invalid-request',
			`Topping: ${filters.length} filters, a config holds ${BANDS - (d900 ? 1 : 0)}`
		);
	}
	const bands = filters.map((f) => ({
		type: TYPES.encode(f.type),
		freq: field(f.freq, 1, U32, 'freq'),
		gain: field(f.gain, 10, I32, 'gain'),
		q: field(f.q, 10000, U32, 'q'),
		on: 1
	}));
	const left = Array.from({ length: BANDS }, (_, i) => bands[i] ?? OFF);
	const right = [...left];
	if (d900) {
		left[BANDS - 1] = reserved.left;
		right[BANDS - 1] = reserved.right;
	}
	const out: Uint8Array[] = [];
	const write = (command: number, data: number) =>
		out.push(toppingFrame(command, data, WRITE, 1, family.frame));
	if (slot !== undefined) {
		out.push(toppingFrame(SWITCH_CONFIG, field(slot, 1, [0, 0xff], 'slot')));
	}
	const gain = toppingPreampWord(preamp, o.family);
	[gain, 1, gain, 1].forEach((v, i) => write(PREAMP_LEFT + i, v));
	const side = (band: number, b: typeof OFF, first: number) =>
		[b.type, b.freq, b.gain, b.q, b.on].forEach((v, i) =>
			write(BAND | ((band + 1) << 8) | (first + i), v)
		);
	if (d900) {
		left.forEach((b, i) => side(i, b, 1));
		right.forEach((b, i) => side(i, b, 6));
	} else {
		left.forEach((b, i) => {
			side(i, b, 1);
			side(i, right[i]!, 6);
		});
	}
	return out.map((d) => hidFrame(0, d));
}

export const toppingCodec: Codec<ToppingHidOptions, HidFrame> = {
	types: TYPES.types,
	wire: () => ({
		freq: { ...grid(1, U32), min: 1 },
		q: { ...grid(10000, U32), min: 0.0001 },
		gain: grid(10, I32),
		preamp: grid(10, [-120, 120])
	}),
	encode: (request, o) => toppingWriteFrames(request, o),
	decode(frames, o) {
		const state: WriteState = { filters: [] };
		const bands: Record<number, number>[] = [];
		for (const { data } of frames) {
			const f = parseToppingFrame(data);
			if (!f) continue;
			if (f.command === SWITCH_CONFIG) state.slot = f.data;
			else if (f.command === PREAMP_LEFT) state.preamp = preampDb(f.data, o.family);
			else if (f.command >> 12 === 9 && (f.command & 0xff) <= 5 && f.command >> 8 < 0x9c) {
				(bands[((f.command >> 8) & 0xf) - 1] ??= {})[f.command & 0xff] = f.data;
			}
		}
		for (const b of bands) {
			if (!b || b[5] !== 1) continue;
			state.filters.push({
				type: TYPES.decode(b[1]!),
				freq: b[2]!,
				gain: (b[3]! | 0) / 10,
				q: b[4]! / 10000
			});
		}
		return state;
	}
};

type Ctx = HandlerContext<HidTransport, ToppingHidOptions>;

interface ConfigList {
	/** The 32-bit words of each stored config. */
	configs: number[][];
}

interface Session {
	/** Stored configs, once the list has been read. */
	count?: number;
	/** The D900's 11th band per config, as last read. */
	reserved: { left: typeof OFF; right: typeof OFF }[];
	/** The firmware word the session's start read, where it reads one. */
	firmware?: number;
}

/**
 * Sends `request`, if any, and feeds every frame that arrives to `take` until it returns a value.
 * Subscribes before sending, so a fast answer isn't missed.
 */
function gather<T>(
	ctx: Ctx,
	request: Uint8Array | null,
	take: (frame: ToppingFrame) => T | undefined,
	timeoutMs: number,
	what: string
): Promise<T> {
	const result = new Promise<T>((resolve, reject) => {
		const cancel = after(timeoutMs, () => {
			unsubscribe();
			reject(new BridgeError('timeout', `Topping: no answer to ${what} within ${timeoutMs} ms`));
		});
		const unsubscribe = ctx.transport.onInputReport((_id, data) => {
			const frame = parseToppingFrame(data);
			if (!frame) return;
			let value: T | undefined;
			try {
				value = take(frame);
			} catch (error) {
				cancel();
				unsubscribe();
				reject(error as Error);
				return;
			}
			if (value === undefined) return;
			cancel();
			unsubscribe();
			resolve(value);
		});
	});
	// Keeps a send failure from leaving the wait's rejection unhandled.
	result.catch(() => {});
	return request ? ctx.transport.sendReport(0, request).then(() => result) : result;
}

/**
 * Collects the words of an answer to `command`. Its frames are numbered from 0 or from 1; the
 * first one seen says which, as the app decides it.
 */
function words(command: number) {
	const got: number[] = [];
	let base: number | undefined;
	let seen = 0;
	return (f: ToppingFrame) => {
		if (f.command !== command) return undefined;
		if (f.frames <= 1) return [f.data];
		base ??= f.frame === 1 ? 1 : 0;
		const i = f.frame - base;
		if (i < 0 || i >= f.frames) return undefined;
		if (got[i] === undefined) seen++;
		got[i] = f.data;
		return seen === f.frames ? got : undefined;
	};
}

function ask(ctx: Ctx, command: number, kind: number, what: string, timeoutMs = ANSWER_TIMEOUT) {
	const frame = familyOf(ctx.options).frame;
	return gather(ctx, toppingFrame(command, 0, kind, 1, frame), words(command), timeoutMs, what);
}

const send = (ctx: Ctx, command: number, data: number, frame = familyOf(ctx.options).frame) =>
	ctx.transport.sendReport(0, toppingFrame(command, data, WRITE, 1, frame));

/** "2.39" from 0x239: the hex digits are the decimal ones. Null where they aren't. */
export function toppingFirmware(word: number): string | null {
	const digits = word.toString(16);
	if (word === 0 || /[a-f]/.test(digits)) return null;
	return `${Number(digits.slice(0, -2) || '0')}.${digits.slice(-2).padStart(2, '0')}`;
}

function refuseOldFirmware(o: ToppingHidOptions, word: number) {
	const min = MIN_FIRMWARE[o.family ?? 'dx1'];
	if (min !== undefined && word < min) {
		throw new BridgeError(
			'unsupported',
			`Topping: firmware ${toppingFirmware(word) ?? `0x${word.toString(16)}`} is older than ${toppingFirmware(min)}, the first Topping's app controls`
		);
	}
}

async function settings(ctx: Ctx) {
	const s = familyOf(ctx.options).settings;
	if (!s) return null;
	return ask(ctx, GET_SETTINGS, s.kind, 'the settings request');
}

/** What the app requires of the D900's capabilities answer before it sends anything else. */
function d900Capable(c: readonly number[]) {
	const fixed = { 0: 2, 1: 255, 2: 7, 3: 10, 4: 10, 5: 30, 8: 74, 9: 78, 10: 74, 11: 10 };
	return (
		c.length === 12 &&
		Object.entries(fixed).every(([i, v]) => c[Number(i)] === v) &&
		(c[6]! & 0x1f0) === 0x1f0
	);
}

async function openSession(ctx: Ctx): Promise<Session> {
	const o = ctx.options;
	const family = familyOf(o);
	const session: Session = { reserved: [] };
	if (o.family === 'd900') {
		const c = await ask(ctx, D900_CAPABILITIES, WRITE, 'the capabilities request');
		if (!d900Capable(c)) {
			throw new BridgeError(
				'unsupported',
				"Topping D900: this firmware doesn't speak the control protocol Topping's app requires"
			);
		}
		// The device answers 0 until it grants the connection; the app asks again 200 ms later.
		for (let i = 0; ; i++) {
			const [granted] = await gather(
				ctx,
				toppingFrame(CONNECT_STATE, family.connect, WRITE, 1, 0),
				words(CONNECT_STATE),
				ANSWER_TIMEOUT,
				'the connection request'
			);
			if (granted === 1) break;
			if (i === 24) throw new BridgeError('rejected', 'Topping D900: connection not granted');
			await ctx.sleep(200);
		}
		await send(ctx, AGREEMENT, 1);
		return session;
	}
	await send(ctx, CONNECT_STATE, family.connect);
	await ctx.sleep(100);
	if (o.family === 'dx5') {
		const [word] = await ask(ctx, SOFTWARE_VERSION, READ, 'the firmware version request');
		session.firmware = word! & 0xfff;
		refuseOldFirmware(o, session.firmware);
		return session;
	}
	// The DX9 Discrete's agreement is its config list request, sent when the list is read.
	if (o.family !== 'dx9d') {
		await send(ctx, AGREEMENT, 1);
		await ctx.sleep(100);
	}
	if (o.family === 'e50') {
		const s = await settings(ctx);
		session.firmware = s?.[family.settings!.firmware] ?? 0;
		refuseOldFirmware(o, session.firmware);
	}
	return session;
}

const sessions = new WeakMap<HidTransport, Promise<Session>>();

/** The transport's session, started on first use; one that fails to start is forgotten. */
function sessionOf(ctx: Ctx) {
	const known = sessions.get(ctx.transport);
	if (known) return known;
	const opening = openSession(ctx);
	sessions.set(ctx.transport, opening);
	opening.catch(() => {
		if (sessions.get(ctx.transport) === opening) sessions.delete(ctx.transport);
	});
	return opening;
}

const band = (w: readonly number[], at: number) => ({
	on: (w[at]! & 0xff) === 1 ? 1 : 0,
	type: (w[at]! >> 8) & 0xff,
	gain: ((w[at]! >> 16) << 24) >> 24,
	freq: w[at + 1]!,
	q: w[at + 2]!
});

/** A stored config: words 5 the left pre-gain, 8… the left bands and 41… the right, 3 words each. */
function decodeConfig(w: readonly number[], family?: ToppingFamily) {
	const filters = Array.from({ length: BANDS }, (_, i): Filter | null => {
		const b = band(w, 8 + 3 * i);
		if (!b.on) return null;
		return { type: TYPES.decode(b.type), freq: b.freq, gain: b.gain / 10, q: b.q / 10000 };
	});
	return { filters, preamp: preampDb(w[5]!, family) };
}

/**
 * Reads the stored configs: a two-frame header (the count, then a word that is not the active
 * config on a DX5 II), then each config as its own run of frames. The app takes a missing header
 * as 3.
 */
async function readList(ctx: Ctx, session: Session): Promise<ConfigList> {
	const [command, data, kind] = familyOf(ctx.options).list;
	const configs: number[][] = [];
	let count: number | undefined;
	let current: number[] = [];
	const list = await gather(
		ctx,
		toppingFrame(command, data, kind),
		(f): ConfigList | undefined => {
			if (f.command !== UPLOAD) return undefined;
			if (f.frames === 2) {
				if (f.frame === 0) {
					count = f.data;
					configs.length = 0;
				} else if (count === 0) return { configs };
				return undefined;
			}
			if (f.frames < CONFIG_WORDS) return undefined;
			if (f.frame === 0) current = [];
			current[f.frame] = f.data;
			if (f.frame !== f.frames - 1) return undefined;
			configs.push(Array.from({ length: f.frames }, (_, i) => current[i] ?? 0));
			return configs.length >= (count ?? 3) ? { configs } : undefined;
		},
		LIST_TIMEOUT,
		'the config list request'
	);
	session.count = list.configs.length;
	session.reserved = list.configs.map((w) => ({
		left: band(w, 8 + 3 * (BANDS - 1)),
		right: band(w, 41 + 3 * (BANDS - 1))
	}));
	return list;
}

/** The active config, from the settings where they hold it. */
async function activeSlot(ctx: Ctx): Promise<number | null> {
	const o = ctx.options;
	const at = familyOf(o).settings?.slot;
	if (at !== undefined) return (await settings(ctx))?.[at] ?? null;
	// The app only listens for the active config of the DX1 II and DX5 II. A DX5 II answers this
	// read (firmware 2.58).
	try {
		const [slot] = await ask(ctx, CURRENT_CONFIG, READ, 'the active config request', 1500);
		return slot === NO_CONFIG ? 0 : slot!;
	} catch (error) {
		ctx.log(`Topping: active config unknown (${(error as Error).message})`);
		return null;
	}
}

async function setEnabled(ctx: Ctx, enabled: boolean, slot?: number) {
	await sessionOf(ctx);
	const o = ctx.options;
	const family = familyOf(o);
	if (o.family === 'dx1' || o.family === 'e50' || o.family === undefined) {
		// These two have no switch: selecting no config turns the EQ off, selecting one turns it on.
		const target = enabled ? (slot ?? (await activeSlot(ctx)) ?? 0) : NO_CONFIG;
		await send(ctx, SWITCH_CONFIG, target, 1);
		if (enabled && o.family !== 'e50') {
			await ctx.sleep(140);
			await send(ctx, SWITCH_CONFIG, target, 1);
		}
		await ctx.sleep(enabled ? 170 : 90);
		return;
	}
	if (enabled && slot !== undefined) {
		await send(ctx, SWITCH_CONFIG, slot);
		await ctx.sleep(o.family === 'd900' ? 100 : family.switchPause);
	}
	if (o.family !== 'd900') return send(ctx, PEQ_STATE, enabled ? 1 : 0);
	// The D900 reports each setting's outcome: the command, a status (0 for done) and the value.
	const [, status] = await gather(
		ctx,
		toppingFrame(PEQ_STATE, enabled ? 1 : 0, WRITE, 1, 0),
		words(D900_RESULT),
		5000,
		'the EQ switch'
	);
	if (status !== 0) throw new BridgeError('rejected', `Topping D900: EQ switch status ${status}`);
}

/**
 * The DX5 II's one-word settings: the command that writes each, and its word in the settings
 * answer. The value is the device's own number.
 */
export const TOPPING_DX5_SETTINGS: Readonly<
	Record<string, readonly [command: number, word: number]>
> = {
	mute: [0x7103, 10],
	input: [0x7104, 11],
	output: [0x7105, 12],
	gain: [0x7117, 13],
	dacFilter: [0x710d, 18],
	lineMode: [0x710e, 19],
	brightness: [0x710a, 25],
	polarity: [0x711d, 33],
	crossfeed: [0x712b, 42]
};
const DX5_VOLUME = 0x7102;
const DX5_BALANCE = 0x7116;
/** Words of the DX5 II's settings answer that the volume depends on. */
const DX5 = { volume: 9, output: 12, balance: 17, lineMode: 19, volumeStep: 32 };
/** Outputs that are line outputs only: in DAC mode their volume is fixed. */
const DX5_LINE_OUTPUTS = [2, 5, 6];
const CONTROL_PAUSE = 60;

async function dx5Settings(ctx: Ctx, fresh = false): Promise<number[]> {
	if (ctx.options.family !== 'dx5') {
		throw new BridgeError('unsupported', "Topping: only the DX5 II's settings are driven");
	}
	await sessionOf(ctx);
	// Reading every control asks for each in turn: one answer serves them all. A write decides on
	// a fresh one.
	const held = dx5Blocks.get(ctx.transport);
	if (!fresh && held && Date.now() - held.at < DX5_BLOCK_AGE) return held.words;
	const words = await ask(ctx, GET_SETTINGS, READ, 'the settings request');
	dx5Blocks.set(ctx.transport, { at: Date.now(), words });
	return words;
}

/** The settings answer last read, kept for `DX5_BLOCK_AGE` ms or until a setting is written. */
const dx5Blocks = new WeakMap<HidTransport, { at: number; words: number[] }>();
const DX5_BLOCK_AGE = 250;

async function dx5Write(ctx: Ctx, command: number, data: number) {
	dx5Blocks.delete(ctx.transport);
	await send(ctx, command, data >>> 0);
	await ctx.sleep(CONTROL_PAUSE);
}

type Control = HandlerControl<HidTransport, ToppingHidOptions>;

const dx5Word = (command: number, word: number): Control => ({
	read: async (ctx) => (await dx5Settings(ctx))[word] ?? 0,
	async write(ctx, value) {
		await dx5Settings(ctx, true);
		await dx5Write(ctx, command, value);
	}
});

/** dB, held as attenuation steps of 0.5 dB, or of 1 dB when the device's volume step is so set. */
const dx5Volume: Control = {
	async read(ctx) {
		const s = await dx5Settings(ctx);
		const steps = s[DX5.volume] ?? 0;
		return steps === 0 ? 0 : -steps / (s[DX5.volumeStep] === 1 ? 1 : 2);
	},
	async write(ctx, value) {
		const s = await dx5Settings(ctx, true);
		if (s[DX5.lineMode] === 1 && DX5_LINE_OUTPUTS.includes(s[DX5.output]!)) {
			// The app sends nothing here.
			throw new BridgeError(
				'rejected',
				'Topping DX5 II: the volume is fixed while a line output is in DAC mode'
			);
		}
		await dx5Write(ctx, DX5_VOLUME, Math.round(-value * (s[DX5.volumeStep] === 1 ? 1 : 2)));
	}
};

/** dB, negative towards the left; the device holds tenths, as a signed word. */
const dx5Balance: Control = {
	read: async (ctx) => ((await dx5Settings(ctx))[DX5.balance]! | 0) / 10,
	async write(ctx, value) {
		await dx5Settings(ctx, true);
		await dx5Write(ctx, DX5_BALANCE, Math.round(value * 10));
	}
};

export const toppingUsbHid: HidHandler<ToppingHidOptions> = {
	id: 'topping-usb-hid',
	transport: 'hid',
	codec: toppingCodec,

	capabilities: () => ({
		canRead: true,
		canWrite: true,
		readsPreamp: true,
		readsSlot: true,
		writesPreamp: true,
		writesSlot: true,
		needsBandCount: false,
		readsCurrentSlot: true,
		canEnable: true
	}),

	async pull(ctx, { slot, bands = BANDS - 1 }) {
		const list = await readList(ctx, await sessionOf(ctx));
		const index = slot ?? (await activeSlot(ctx)) ?? 0;
		const config = list.configs[index];
		if (!config) {
			throw new BridgeError(
				'invalid-request',
				`Topping: no config ${index}, the device holds ${list.configs.length}`
			);
		}
		const { filters, preamp } = decodeConfig(config, ctx.options.family);
		return { filters: filters.slice(0, bands), preamp, slot: index };
	},

	async push(ctx, request) {
		const session = await sessionOf(ctx);
		const family = familyOf(ctx.options);
		const count = session.count ?? (await readList(ctx, session)).configs.length;
		const slot = request.slot ?? (await activeSlot(ctx)) ?? 0;
		if (slot >= count) {
			throw new BridgeError(
				'invalid-request',
				`Topping: no config ${slot}, the device holds ${count}; Topping's app creates them`
			);
		}
		const frames = toppingWriteFrames({ ...request, slot }, ctx.options, session.reserved[slot]);
		const [select, ...parameters] = frames;
		await sendFrame(ctx.transport, select!);
		await ctx.sleep(family.switchPause);
		for (const [i, frame] of parameters.entries()) {
			await sendFrame(ctx.transport, frame);
			// The DX5 II also pauses after the pre-gain; the D900 counts the pre-gain's four in.
			const sent = ctx.options.family === 'd900' ? i + 1 : i - 3;
			if (sent > 0 ? sent % family.burst === 0 : sent === 0 && ctx.options.family === 'dx5') {
				await ctx.sleep(10);
			}
		}
		await ctx.sleep(85);
		return { reconnect: false };
	},

	async currentSlot(ctx) {
		await sessionOf(ctx);
		return activeSlot(ctx);
	},

	async eqEnabled(ctx) {
		await sessionOf(ctx);
		const o = ctx.options;
		if (o.family === 'dx5') {
			// The app waits for the DX5 II to announce its switch; the device answers a read of it
			// (firmware 2.58).
			const [on] = await ask(ctx, PEQ_STATE, READ, 'the EQ switch request');
			return on !== 0;
		}
		const at = familyOf(o).settings?.enabled;
		if (at !== undefined) {
			const s = await settings(ctx);
			return s?.[at] === undefined ? null : s[at] !== 0;
		}
		const [state] = await ask(ctx, EQ_ENABLE_STATE, READ, 'the EQ state request');
		return (state! & 1) === 1;
	},

	setEnabled,

	async firmware(ctx) {
		const session = await sessionOf(ctx);
		const at = familyOf(ctx.options).settings?.firmware;
		if (session.firmware !== undefined) return toppingFirmware(session.firmware);
		if (at !== undefined) return toppingFirmware((await settings(ctx))?.[at] ?? 0);
		const [word] = await ask(ctx, SOFTWARE_VERSION, READ, 'the firmware version request');
		return toppingFirmware(word!);
	},

	controls: {
		volume: dx5Volume,
		balance: dx5Balance,
		...Object.fromEntries(
			Object.entries(TOPPING_DX5_SETTINGS).map(([id, [command, word]]) => [
				id,
				dx5Word(command, word)
			])
		)
	}
};
