// Moondrop USB HID, a Walkplay-derived protocol (Rays, Marigold, FreeDSP Pro/Mini, Dawn Pro, the
// dongle-and-headset sets…), as Moondrop's web app (hub.moondroplab.com, v1.8.0) drives it.
// devicePEQ (moondropUsbHidHandler.js, 0BSD, at 0617f38) differed: a [1,0x0A,index,0,FF,FF,FF]
// after every band, length byte 0x18, the pre-gain read from cmd 0x03 and no slot select.
//
// Report 0x4B, 63-byte writes: [op, cmd, length, payload…], op 0x01 write, 0x80 read; an answer
// has the same header, so its payload starts at byte 3. A push is: select the custom slot
// [1,0x0F,1,slot]; one band frame per band; the commit; the pre-gain [1,0x23,2,s16 LE ×256]; the
// save [1,1,0]; the offset save [1,4,0], each followed by the wait the app makes. Band frame
// (`bandFrame`):
//   biquad:  [1,9,0x21,0, band,0,0, Q2.30 coefficients at 96 kHz (20 bytes), freq u16 LE,
//            q s16 LE ×256, gain s16 LE ×256, type, 0, slot]
//   compact: [1,9,0x0B,0, band,0,0, freq, q, gain, type]
//   wide:    [1,9,0x1F,0, band,0,0, 20 zero bytes, freq, q, gain, type]
// Commit (`commit`): apply [1,0x0A,4,0,0,FF,FF] once after all the bands, [1,0x60,0], or none.
// Types: 0 off, 1 LSC, 2 PK, 3 HSC, 4 LPQ, 5 HPQ. The coefficients are the RBJ forms; the app
// passes a shelf's Q as its slope, and computes LPQ and HPQ as true low-pass and high-pass.
//
// A band read is [0x80, 9, 2, 0, band], answered in the band layout (freq at byte 27, at byte 7
// on `compact`), with a 50 ms wait after each. The pre-gain is read with cmd 0x23
// ([0x80, 0x23, 0]), cmd 0x03 being the separate global gain (a control). Firmware is cmd 0x0C
// (ASCII from byte 3), the current slot cmd 0x0F. The sets of a dongle and a headset first ask
// [0x80, 0x31, 0] whether the two are linked (`linkCheck`): a 0 at byte 3 is not.
//
// Controls: the global gain (cmd 0x03, s16 LE ×256 dB, saved with the offset save [1,4,0]), and
// features read with [0x80, cmd, 0] and written with [1, cmd, 1, value] and 50 ms, with no save:
// DAC filter 0x11, DAC mode 0x1D, LED 0x28 (`ledCommand`), gain level 0x26, ANC mode 0x25, dual-mic
// ENC 0x34, and the prompt tone 0x2B, three bytes (on, volume, tone) written back together.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { biquadQ30, coefficientBytes } from '../biquad.ts';
import { field, grid, I16, le16, readI16le, readU16le, U8 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type {
	Codec,
	HandlerContext,
	HandlerControl,
	HidFrame,
	HidHandler,
	PushRequest,
	WriteState
} from '../handler.ts';
import { hidFrame, hidRequest, refuseUncarried, sendFrame, typeCodes } from '../io.ts';
import type { HidTransport } from '../transport.ts';

export interface MoondropUsbHidOptions {
	/**
	 * The band frame: `biquad` (36 bytes, with coefficients and the slot), `compact` (14 bytes,
	 * parameters only) or `wide` (34 bytes, coefficients left zero). Default `biquad`.
	 */
	bandFrame?: 'biquad' | 'compact' | 'wide';
	/**
	 * What follows the bands: `apply` ([1,0x0A,4,0,0,FF,FF]), `commit` ([1,0x60,0]) or `none`
	 * (nothing, but the wait remains). Default `apply`.
	 */
	commit?: 'apply' | 'commit' | 'none';
	/** The slot a push selects and a `biquad` frame names. Default 7. */
	customSlot?: number;
	/** Whether a push selects the custom slot first. Default true. */
	selectSlot?: boolean;
	/** Whether the pre-gain is set to -128 dB while the bands are written. Default false. */
	duckPreamp?: boolean;
	/** Whether a push ends with the offset save [1,4,0]. Default false. */
	saveOffsets?: boolean;
	/**
	 * Whether every push, pull and control access first asks if the headset is linked to its
	 * dongle, and refuses if it isn't. Default false.
	 */
	linkCheck?: boolean;
	/** The command of the `led` control. Default 0x28; BLUE ROSE uses 0x18. */
	ledCommand?: number;
}

const REPORT_ID = 0x4b;
const WRITE = 0x01;
const READ = 0x80;
const BAND = 0x09;
const APPLY = 0x0a;
const COMMIT = 0x60;
const SAVE = 0x01;
const SAVE_OFFSETS = 0x04;
const GLOBAL_GAIN = 0x03;
const PREAMP = 0x23;
const ACTIVE_EQ = 0x0f;
const FIRMWARE = 0x0c;
const LINK = 0x31;
const TIMEOUT = 2000;
const DEFAULT_SLOT = 7;
/** The pre-gain a push sets while it writes the bands, as the app does with `duckPreamp`. */
const DUCKED = -128;

/** Outside 10 Hz–24 kHz a band reads back as unset. */
const FREQ = [10, 24000] as const;

/** Where the band's frequency starts in an answer or write frame, by frame length byte. */
const COMPACT_LENGTH = 0x0b;
const COMPACT_AT = 7;
const FULL_AT = 27;

export const MOONDROP_TYPES = typeCodes('moondrop', { PK: 2, LSC: 1, HSC: 3, LPQ: 4, HPQ: 5 });

/**
 * The band of a read answer or write frame, which holds its frequency at `at` (27, or 7 for the
 * compact frame). Null for a band whose type is 0 (off), or whose frequency is outside
 * 10 Hz–24 kHz: what an unset band reads as.
 */
export function decodeMoondropBand(d: ArrayLike<number>, at = FULL_AT): Filter | null {
	const code = d[at + 6] ?? 0;
	if (code === 0) return null;
	const freq = readU16le(d, at);
	if (freq < FREQ[0] || freq > FREQ[1]) return null;
	return {
		type: MOONDROP_TYPES.decode(code),
		freq,
		q: readI16le(d, at + 2) / 256,
		gain: readI16le(d, at + 4) / 256
	};
}

/** "0.1" from the 0x0C answer: the ASCII from byte 3 with the zero bytes dropped; else null. */
export function decodeMoondropFirmware(d: ArrayLike<number>): string | null {
	let text = '';
	for (let i = 3; i < d.length; i++) if (d[i] !== 0) text += String.fromCharCode(d[i]!);
	return /^\d+(\.\d+)*$/.test(text) ? text : null;
}

const padded = (bytes: number[]) => {
	const data = new Uint8Array(63);
	data.set(bytes);
	return hidFrame(REPORT_ID, data);
};

function bandBytes(index: number, f: Filter, o: MoondropUsbHidOptions): number[] {
	const freq = field(f.freq, 1, FREQ, 'freq');
	const type = MOONDROP_TYPES.encode(f.type);
	const head = (length: number) => [
		WRITE,
		BAND,
		length,
		0x00,
		field(index, 1, U8, 'band index'),
		0,
		0
	];
	const params = [
		...le16(freq),
		...le16(field(f.q, 256, I16, 'q') & 0xffff),
		...le16(field(f.gain, 256, I16, 'gain') & 0xffff),
		type
	];
	if (o.bandFrame === 'compact') return [...head(COMPACT_LENGTH), ...params];
	if (o.bandFrame === 'wide') return [...head(0x1f), ...new Array<number>(20).fill(0), ...params];
	const slot = field(o.customSlot ?? DEFAULT_SLOT, 1, U8, 'slot');
	const coefficients = coefficientBytes(biquadQ30(f.type, freq, f.gain, f.q, 96000, true));
	return [...head(0x21), ...coefficients, ...params, 0x00, slot];
}

/** The parts of a push, in order; each is followed by its own wait. */
export type MoondropStep = 'select' | 'duck' | 'band' | 'commit' | 'preamp' | 'save' | 'offsets';

/**
 * A push as the app sends it, step by step. A step without a frame is one the options leave out
 * but whose wait remains (`commit: "none"`).
 */
export function moondropSteps(
	request: PushRequest,
	o: MoondropUsbHidOptions
): { step: MoondropStep; frame?: HidFrame }[] {
	refuseUncarried('moondrop-usb-hid', request, { preamp: true });
	const { filters, preamp } = request;
	const steps: { step: MoondropStep; frame?: HidFrame }[] = [];
	const preampFrame = (db: number) =>
		padded([WRITE, PREAMP, 0x02, ...le16(field(db, 256, I16, 'preamp') & 0xffff)]);
	// The values are checked before anything is returned, so a push refuses before it sends.
	const bands = filters.map((f, i) => padded(bandBytes(i, f, o)));
	const real = preamp === undefined ? undefined : preampFrame(preamp);
	if (o.selectSlot !== false) {
		const slot = field(o.customSlot ?? DEFAULT_SLOT, 1, U8, 'slot');
		steps.push({ step: 'select', frame: padded([WRITE, ACTIVE_EQ, 0x01, slot]) });
	}
	if (o.duckPreamp && real) steps.push({ step: 'duck', frame: preampFrame(DUCKED) });
	for (const frame of bands) steps.push({ step: 'band', frame });
	const commit = o.commit ?? 'apply';
	steps.push({
		step: 'commit',
		...(commit === 'apply'
			? { frame: padded([WRITE, APPLY, 0x04, 0x00, 0x00, 0xff, 0xff]) }
			: commit === 'commit'
				? { frame: padded([WRITE, COMMIT, 0x00]) }
				: {})
	});
	if (real) steps.push({ step: 'preamp', frame: real });
	steps.push({ step: 'save', frame: padded([WRITE, SAVE, 0x00]) });
	if (o.saveOffsets) steps.push({ step: 'offsets', frame: padded([WRITE, SAVE_OFFSETS, 0x00]) });
	return steps;
}

/** Milliseconds the app waits after each step. */
const WAIT: Record<MoondropStep, number> = {
	select: 150,
	duck: 50,
	band: 25,
	commit: 50,
	preamp: 50,
	save: 200,
	offsets: 200
};

export const moondropUsbHidCodec: Codec<MoondropUsbHidOptions, HidFrame> = {
	types: MOONDROP_TYPES.types,
	wire: () => ({
		freq: grid(1, FREQ),
		q: { ...grid(256, I16), min: 1 / 256 },
		gain: grid(256, I16),
		preamp: grid(256, I16)
	}),
	encode(request, o) {
		return moondropSteps(request, o).flatMap((s) => (s.frame ? [s.frame] : []));
	},
	decode(frames) {
		const state: WriteState = { filters: [] };
		for (const { data: d } of frames) {
			if (d[0] !== WRITE) continue;
			// The frame says its own layout; the last pre-gain frame is the one that stays.
			if (d[1] === BAND) {
				state.filters[d[4]!] = decodeMoondropBand(
					d,
					d[2] === COMPACT_LENGTH ? COMPACT_AT : FULL_AT
				);
			} else if (d[1] === PREAMP) state.preamp = readI16le(d, 3) / 256;
		}
		return state;
	}
};

type Ctx = HandlerContext<HidTransport, MoondropUsbHidOptions>;

const ask = (ctx: Ctx, cmd: number, what: string, also = (_d: Uint8Array) => true) =>
	hidRequest(
		ctx.transport,
		REPORT_ID,
		[READ, cmd, 0x00],
		(d) => d[0] === READ && d[1] === cmd && also(d),
		TIMEOUT,
		what
	);

/** With `linkCheck`, refuses unless the headset answers that it is linked to its dongle. */
async function checkLink(ctx: Ctx) {
	if (!ctx.options.linkCheck) return;
	const answer = await ask(ctx, LINK, 'Moondrop link');
	await ctx.sleep(50);
	if (answer[3] === 0) {
		throw new BridgeError('rejected', 'Moondrop: the headset is not linked to the dongle');
	}
}

const globalGain: HandlerControl<HidTransport, MoondropUsbHidOptions> = {
	async read(ctx) {
		await checkLink(ctx);
		return readI16le(await ask(ctx, GLOBAL_GAIN, 'Moondrop global gain'), 3) / 256;
	},
	async write(ctx, value) {
		const bytes = le16(field(value, 256, I16, 'global gain') & 0xffff);
		await checkLink(ctx);
		await sendFrame(ctx.transport, padded([WRITE, GLOBAL_GAIN, 0x02, ...bytes]));
		await ctx.sleep(50);
		await sendFrame(ctx.transport, padded([WRITE, SAVE_OFFSETS, 0x00]));
		await ctx.sleep(200);
	}
};

const DEFAULT_LED = 0x28;
const PROMPT_TONE = 0x2b;

/** A feature value as one byte: a whole number in range, or `unrepresentable` (never rounded). */
function featureByte(value: number, what: string, max = 0xff) {
	if (!Number.isInteger(value) || value < 0 || value > max) {
		throw new BridgeError(
			'unrepresentable',
			`Moondrop: ${what} ${value} is not a whole number from 0 to ${max}`
		);
	}
	return value;
}

/**
 * A feature the app reads with [0x80, cmd, 0] (the value at byte 3) and writes with
 * [1, cmd, 1, value] and 50 ms, with no save after it. `bool` ones take 0 or 1 only.
 */
function feature(
	id: string,
	cmd: (o: MoondropUsbHidOptions) => number,
	bool = false
): HandlerControl<HidTransport, MoondropUsbHidOptions> {
	return {
		async read(ctx) {
			await checkLink(ctx);
			return (await ask(ctx, cmd(ctx.options), `Moondrop ${id}`))[3] ?? 0;
		},
		async write(ctx, value) {
			const byte = featureByte(value, id, bool ? 1 : 0xff);
			await checkLink(ctx);
			await sendFrame(ctx.transport, padded([WRITE, cmd(ctx.options), 0x01, byte]));
			await ctx.sleep(50);
		}
	};
}

/**
 * One byte of the prompt tone's three (enabled, volume, tone), which are read and written
 * together: a write reads all three, changes its own and writes them back. The tone selection is
 * never changed.
 */
function promptTone(
	id: string,
	index: 0 | 1,
	max: number
): HandlerControl<HidTransport, MoondropUsbHidOptions> {
	return {
		async read(ctx) {
			await checkLink(ctx);
			return (await ask(ctx, PROMPT_TONE, `Moondrop ${id}`))[3 + index] ?? 0;
		},
		async write(ctx, value) {
			const byte = featureByte(value, id, max);
			await checkLink(ctx);
			const current = await ask(ctx, PROMPT_TONE, `Moondrop ${id}`);
			const bytes = [current[3] ?? 0, current[4] ?? 0, current[5] ?? 0];
			bytes[index] = byte;
			await sendFrame(ctx.transport, padded([WRITE, PROMPT_TONE, 0x03, ...bytes]));
			await ctx.sleep(50);
		}
	};
}

export const moondropUsbHid: HidHandler<MoondropUsbHidOptions> = {
	id: 'moondrop-usb-hid',
	transport: 'hid',
	codec: moondropUsbHidCodec,

	capabilities: () => ({
		canRead: true,
		canWrite: true,
		readsPreamp: true,
		readsSlot: false,
		writesPreamp: true,
		writesSlot: false,
		needsBandCount: true,
		readsCurrentSlot: true,
		canEnable: false
	}),

	async pull(ctx, { bands = 0 }) {
		await checkLink(ctx);
		const at = ctx.options.bandFrame === 'compact' ? COMPACT_AT : FULL_AT;
		const filters: (Filter | null)[] = [];
		for (let i = 0; i < bands; i++) {
			const answer = await hidRequest(
				ctx.transport,
				REPORT_ID,
				[READ, BAND, 0x02, 0x00, i],
				// The answer echoes the band index at byte 4, as the Marigold capture shows.
				(d) => d[0] === READ && d[1] === BAND && d[4] === i,
				TIMEOUT,
				`Moondrop band ${i}`
			);
			filters.push(decodeMoondropBand(answer, at));
			await ctx.sleep(50);
		}
		const result: { filters: (Filter | null)[]; preamp?: number } = { filters };
		try {
			result.preamp = readI16le(await ask(ctx, PREAMP, 'Moondrop preamp'), 3) / 256;
		} catch (error) {
			ctx.log(`Moondrop: no preamp (${String(error)})`);
		}
		return result;
	},

	async push(ctx, request) {
		const steps = moondropSteps(request, ctx.options);
		let group: MoondropStep | undefined;
		for (const { step, frame } of steps) {
			// The link is asked about once before each part of the push, the bands counting as one.
			if (step !== group) await checkLink(ctx);
			group = step;
			if (frame) await sendFrame(ctx.transport, frame);
			await ctx.sleep(WAIT[step]);
		}
		return { reconnect: false };
	},

	async currentSlot(ctx) {
		const answer = await ask(ctx, ACTIVE_EQ, 'Moondrop slot');
		return answer[3] ?? null;
	},

	async firmware(ctx) {
		return decodeMoondropFirmware(await ask(ctx, FIRMWARE, 'Moondrop firmware'));
	},

	controls: {
		globalGain,
		dacFilter: feature('dacFilter', () => 0x11),
		dacMode: feature('dacMode', () => 0x1d),
		led: feature('led', (o) => o.ledCommand ?? DEFAULT_LED, true),
		gainLevel: feature('gainLevel', () => 0x26),
		ancMode: feature('ancMode', () => 0x25),
		dualMicEnc: feature('dualMicEnc', () => 0x34, true),
		promptTone: promptTone('promptTone', 0, 1),
		promptToneVolume: promptTone('promptToneVolume', 1, 0xff)
	}
};
