// Fosi Audio DS3 (and the C1, C3, ZH1 and ZH3 the vendor's web app drives the same way): 63-byte
// commands [0x77, cmd, …] on report 1, answers read back from the feature report (devicePEQ
// fosiAudioUsbHidHandler.js, 0BSD, at 0617f38; command names and the controls from Fosi's web
// control center, cc.fosiaudio.com).
//
// Band (0x8D): [0x77, 0x8D, preset, band, type, freq f32 LE, q f32 LE, bandwidth f32 LE,
// gain f32 LE]; 0x8E reads a band as a feature request and commits it as an output report. Type
// codes are the vendor app's. 0x8A selects a preset and 0x92 selects and saves it; a write starts
// with 0x91, which asks for the preset count, as devicePEQ does. A preset's pre-gain (whole dB,
// int32 LE) and name (16 bytes UTF-8) are written together (0x8C) and read with 0x8B; the codec
// leaves the name empty and the session fills in the one the device holds, so a write keeps it.
// 0x8B with preset 0xFF answers for the active preset, its id in byte 2, as the vendor app asks
// when it connects. Built-in presets hold 8 bands; user presets hold 8, or 32 on firmware from
// 1.4.15.
//
// EQ on/off (0x9D, read with 0x9E, answered on the feature report) is separate, persistent state
// that selecting or writing a preset doesn't change, and turning it off keeps the active preset;
// so a push also switches it on. A pull selects the preset it reads, as the
// vendor app does, so it changes the active preset. A band at 0 Hz and 0 dB reads back as empty,
// so frequencies must be above 0 (upstream never sends 0 Hz either).

import type { Filter } from '@potatosalad775/eqcaps-core';
import {
	f32le,
	F32_FIELD,
	field,
	grid,
	I32,
	le32,
	readF32le,
	readI32le,
	tidyF32,
	U8
} from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type {
	Codec,
	HandlerContext,
	HandlerControl,
	HidFrame,
	HidHandler,
	WriteState
} from '../handler.ts';
import { hidFrame, refuseUncarried, sendFrame, typeCodes } from '../io.ts';
import type { HidTransport } from '../transport.ts';

export interface FosiAudioHidOptions {
	/** Default 1. */
	reportId?: number;
	/** Written to the band's bandwidth field. Default 0. */
	bandwidth?: number;
	/** Preset of a write that names none. Default 7 ("Custom 1"). */
	defaultSlot?: number;
}

const HEADER = 0x77;
const SET_UPSAMPLE = 0x80;
const GET_UPSAMPLE = 0x81;
const SET_EQ_MODE = 0x8a;
const GET_EQ_MODE = 0x8b;
const SET_MODE_GAIN_AND_NAME = 0x8c;
const SET_EQ_PARAMS = 0x8d;
const GET_EQ_PARAMS = 0x8e;
const GET_EQ_MODE_COUNT = 0x91;
const SET_AND_SAVE_EQ_MODE = 0x92;
const SET_VOLUME = 0x93;
const GET_VOLUME = 0x94;
const SET_LED_SWITCH = 0x96;
const GET_LED_SWITCH = 0x97;
const SET_UAC_MODE = 0x9b;
const GET_UAC_MODE = 0x9c;
const SET_EQ_ENABLE = 0x9d;
const GET_EQ_ENABLE = 0x9e;
const SET_GAIN_MODE = 0xa0;
const GET_GAIN_MODE = 0xa1;
const SET_FILTER_MODE = 0xa2;
const GET_FILTER_MODE = 0xa3;
const SET_GAME_MODE = 0xa4;
const GET_GAME_MODE = 0xa5;
const GET_FIRMWARE_VERSION = 0xa6;
const BYPASS = 0;
/** The preset id 0x8B answers for the active preset. */
const ACTIVE_PRESET = 0xff;
/** Bands of a built-in preset, whatever the firmware. */
const BUILT_IN_BANDS = 8;
const NAME_AT = 7;
const NAME_LENGTH = 16;
/** The smallest positive float32: anything below rounds to 0 Hz. */
const MIN_FREQ = 2 ** -149;

function frequency(freq: number) {
	if (!(Math.fround(freq) >= MIN_FREQ)) {
		throw new BridgeError('unrepresentable', `Fosi Audio: freq ${freq} must be above 0 Hz`);
	}
	return f32le(freq, 'freq');
}

export const FOSI_TYPES = typeCodes('fosi-audio', {
	AP: 1,
	PK: 2,
	LPQ: 3,
	HPQ: 4,
	BP: 5,
	NO: 7,
	LSC: 9,
	HSC: 10
});

const reportId = (o: FosiAudioHidOptions) => o.reportId ?? 1;
const preset = (o: FosiAudioHidOptions, slot?: number) =>
	field(slot ?? o.defaultSlot ?? 7, 1, U8, 'slot');

function command(cmd: number, ...data: number[]) {
	const packet = new Uint8Array(63);
	packet.set([HEADER, cmd, ...data]);
	return packet;
}

/** A band in the 0x8D / 0x8E layout (report id stripped); null for a bypassed or empty band. */
export function decodeFosiBand(
	d: ArrayLike<number>
): { band: number; filter: Filter | null } | null {
	if (d.length < 21 || d[0] !== HEADER) return null;
	const typeCode = d[4]!;
	const freq = tidyF32(readF32le(d, 5));
	const q = tidyF32(readF32le(d, 9));
	const gain = tidyF32(readF32le(d, 17));
	const off = typeCode === BYPASS || (gain === 0 && freq === 0);
	return { band: d[3]!, filter: off ? null : { type: FOSI_TYPES.decode(typeCode), freq, q, gain } };
}

/** The 0x8D frame that writes `filter` to band `index` of preset `slot` (report id stripped). */
export function encodeFosiBand(
	slot: number,
	index: number,
	filter: Filter,
	o: FosiAudioHidOptions
): Uint8Array {
	const band = command(
		SET_EQ_PARAMS,
		field(slot, 1, U8, 'slot'),
		field(index, 1, U8, 'band index'),
		FOSI_TYPES.encode(filter.type)
	);
	band.set(
		[
			...frequency(filter.freq),
			...f32le(filter.q, 'q'),
			...f32le(o.bandwidth ?? 0),
			...f32le(filter.gain, 'gain')
		],
		5
	);
	return band;
}

/** "1.5.8" from the 0xA6 answer: three bytes, each BCD where both digits are decimal. */
export function decodeFosiFirmware(d: ArrayLike<number>): string | null {
	if (d.length < 5 || d[0] !== HEADER || d[1] !== GET_FIRMWARE_VERSION) return null;
	const part = (b: number) => {
		const hi = b >> 4;
		const lo = b & 0x0f;
		return hi <= 9 && lo <= 9 ? hi * 10 + lo : b;
	};
	return [d[2]!, d[3]!, d[4]!].map(part).join('.');
}

export const fosiAudioCodec: Codec<FosiAudioHidOptions, HidFrame> = {
	types: FOSI_TYPES.types,
	wire: () => ({
		freq: { ...F32_FIELD, min: MIN_FREQ },
		q: F32_FIELD,
		gain: F32_FIELD,
		preamp: grid(1, I32)
	}),
	encode(request, o) {
		refuseUncarried('fosi-audio-usb-hid', request, { preamp: true, slot: true });
		const { filters, slot, preamp } = request;
		const id = reportId(o);
		const p = preset(o, slot);
		const frames = [
			hidFrame(id, command(GET_EQ_MODE_COUNT, 0), true),
			hidFrame(id, command(SET_EQ_MODE, p), true)
		];
		filters.forEach((f, i) => {
			frames.push(
				hidFrame(id, encodeFosiBand(p, i, f, o), true),
				hidFrame(id, command(GET_EQ_PARAMS, p, i))
			);
		});
		if (preamp !== undefined) {
			// The name field is left empty here; the session copies in the preset's own name.
			frames.push(
				hidFrame(id, command(SET_MODE_GAIN_AND_NAME, p, ...le32(field(preamp, 1, I32, 'preamp'))))
			);
		}
		frames.push(hidFrame(id, command(SET_AND_SAVE_EQ_MODE, p), true));
		return frames;
	},
	decode(frames) {
		const state: WriteState = { filters: [] };
		for (const frame of frames) {
			if (frame.data[1] === SET_MODE_GAIN_AND_NAME) state.preamp = readI32le(frame.data, 3);
			if (!frame.feature || frame.data[1] !== SET_EQ_PARAMS) continue;
			const band = decodeFosiBand(frame.data);
			if (band) state.filters[band.band] = band.filter;
			state.slot = frame.data[2]!;
		}
		return state;
	}
};

type Ctx = HandlerContext<HidTransport, FosiAudioHidOptions>;

/** WebHID prepends the report id to numbered feature reports; the vendor app strips it. */
async function readFeature(ctx: Ctx) {
	const id = reportId(ctx.options);
	const d = await ctx.transport.receiveFeatureReport(id);
	return d[0] === id && d[1] === HEADER ? d.subarray(1) : d;
}

async function ack(ctx: Ctx, cmd: number) {
	const d = await readFeature(ctx);
	return d[0] === HEADER && d[1] === cmd ? d : null;
}

/** Sends a command as the vendor app does, as an output report, and reads its answer. */
async function ask(ctx: Ctx, cmd: number, ...data: number[]) {
	await ctx.transport.sendReport(reportId(ctx.options), command(cmd, ...data));
	return ack(ctx, cmd);
}

/** A preset's pre-gain (dB) and name (0x8B); null when the device doesn't answer. */
async function presetInfo(ctx: Ctx, slot: number) {
	const d = await ask(ctx, GET_EQ_MODE, slot);
	if (!d || d.length < NAME_AT + NAME_LENGTH) return null;
	return { gain: readI32le(d, 3), name: d.slice(NAME_AT, NAME_AT + NAME_LENGTH) };
}

/** How many presets are built in (0x91 answers the total, then the built-in count). */
async function builtInPresets(ctx: Ctx): Promise<number | null> {
	const d = await ask(ctx, GET_EQ_MODE_COUNT);
	return d && d.length >= 4 ? d[3]! : null;
}

async function setEnabled(ctx: Ctx, enabled: boolean, slot?: number) {
	const id = reportId(ctx.options);
	await ctx.transport.sendReport(id, command(SET_EQ_ENABLE, enabled ? 1 : 0));
	const answer = await ack(ctx, SET_EQ_ENABLE);
	if (answer && answer[2] !== 0) {
		throw new BridgeError('rejected', `Fosi Audio: EQ switch rejected (status ${answer[2]})`);
	}
	await ctx.sleep(30);
	if (enabled && slot !== undefined) {
		await ctx.transport.sendFeatureReport(id, command(SET_EQ_MODE, preset(ctx.options, slot)));
		await ctx.sleep(30);
	}
	await ctx.transport.sendReport(id, command(GET_EQ_ENABLE));
	const state = await ack(ctx, GET_EQ_ENABLE);
	if (state && (state[2] === 1) !== enabled) ctx.log(`Fosi Audio: EQ switch did not take`);
}

/** Each control's read and write commands; `index` addresses one of several (the LEDs). */
export const FOSI_CONTROL_COMMANDS: Readonly<
	Record<string, { get: number; set: number; index?: number }>
> = {
	volume: { get: GET_VOLUME, set: SET_VOLUME },
	gainMode: { get: GET_GAIN_MODE, set: SET_GAIN_MODE },
	filterMode: { get: GET_FILTER_MODE, set: SET_FILTER_MODE },
	gameMode: { get: GET_GAME_MODE, set: SET_GAME_MODE },
	upsample: { get: GET_UPSAMPLE, set: SET_UPSAMPLE },
	uacMode: { get: GET_UAC_MODE, set: SET_UAC_MODE },
	led: { get: GET_LED_SWITCH, set: SET_LED_SWITCH, index: 0 }
};

/**
 * A control read with one command and written with another; the value is one byte, after
 * `index` where the command addresses one of several (the LEDs). A write the device doesn't
 * answer is reported, and the session's read-back decides whether it took.
 */
function byteControl(
	get: number,
	set: number,
	index?: number
): HandlerControl<HidTransport, FosiAudioHidOptions> {
	const at = index === undefined ? 2 : 3;
	const lead = index === undefined ? [] : [index];
	return {
		async read(ctx) {
			const d = await ask(ctx, get, ...lead);
			if (!d || d.length <= at) {
				throw new BridgeError('bad-response', `Fosi Audio: no answer to 0x${get.toString(16)}`);
			}
			return d[at]!;
		},
		async write(ctx, value) {
			const answer = await ask(ctx, set, ...lead, field(value, 1, U8, 'control value'));
			if (!answer) ctx.log(`Fosi Audio: no answer to 0x${set.toString(16)}`);
			await ctx.sleep(30);
		}
	};
}

export const fosiAudioUsbHid: HidHandler<FosiAudioHidOptions> = {
	id: 'fosi-audio-usb-hid',
	transport: 'hid',
	codec: fosiAudioCodec,

	capabilities: () => ({
		canRead: true,
		canWrite: true,
		readsPreamp: true,
		readsSlot: true,
		writesPreamp: true,
		writesSlot: true,
		needsBandCount: true,
		readsCurrentSlot: true,
		canEnable: true
	}),

	async pull(ctx, { slot, bands = 0 }) {
		const id = reportId(ctx.options);
		const p = preset(ctx.options, slot);
		// Built-in presets hold 8 bands even where user presets hold more.
		const builtIn = await builtInPresets(ctx);
		const count = builtIn !== null && p < builtIn ? Math.min(bands, BUILT_IN_BANDS) : bands;
		await ctx.transport.sendFeatureReport(id, command(SET_EQ_MODE, p));
		const filters: (Filter | null)[] = [];
		for (let i = 0; i < count; i++) {
			await ctx.transport.sendFeatureReport(id, command(GET_EQ_PARAMS, p, i));
			const band = decodeFosiBand(await readFeature(ctx));
			if (!band || band.band !== i) {
				throw new BridgeError('bad-response', `Fosi Audio: no answer for band ${i}`);
			}
			filters.push(band.filter);
			await ctx.sleep(20);
		}
		const info = await presetInfo(ctx, p);
		return info ? { filters, slot: p, preamp: info.gain } : { filters, slot: p };
	},

	async push(ctx, request) {
		const frames = fosiAudioCodec.encode(request, ctx.options);
		const gainFrame = frames.find((f) => f.data[1] === SET_MODE_GAIN_AND_NAME);
		if (gainFrame) {
			const info = await presetInfo(ctx, gainFrame.data[2]!);
			if (!info) throw new BridgeError('bad-response', 'Fosi Audio: no answer for the preset name');
			gainFrame.data.set(info.name, NAME_AT);
		}
		for (const frame of frames) {
			await sendFrame(ctx.transport, frame);
			if (frame === gainFrame) await ack(ctx, SET_MODE_GAIN_AND_NAME);
			const cmd = frame.data[1];
			await ctx.sleep(cmd === SET_EQ_MODE || cmd === GET_EQ_MODE_COUNT ? 50 : 20);
		}
		await setEnabled(ctx, true, request.slot ?? ctx.options.defaultSlot ?? 7);
		return { reconnect: false };
	},

	async currentSlot(ctx) {
		const d = await ask(ctx, GET_EQ_MODE, ACTIVE_PRESET);
		return d && d.length > 2 ? d[2]! : null;
	},

	async eqEnabled(ctx) {
		const d = await ask(ctx, GET_EQ_ENABLE);
		return d && d.length > 2 ? d[2] === 1 : null;
	},

	setEnabled,

	async firmware(ctx) {
		return decodeFosiFirmware((await ask(ctx, GET_FIRMWARE_VERSION)) ?? []);
	},

	controls: Object.fromEntries(
		Object.entries(FOSI_CONTROL_COMMANDS).map(([key, c]) => [
			key,
			byteControl(c.get, c.set, c.index)
		])
	)
};
