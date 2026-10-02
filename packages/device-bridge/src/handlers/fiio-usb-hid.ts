// FiiO USB HID protocol, also used by JadeAudio and Snowsky devices (devicePEQ
// fiioUsbHidHandler.js, 0BSD, at 0617f38).
//
// Frames on the model's report id (7 by default):
//   set: AA 0A 00 00 <cmd> <len> <data…> 00 EE
//   get: BB 0B 00 00 <cmd> <len> <data…> 00 EE, answered by a BB 0B … input report
// Commands: 0x15 band, 0x16 preset, 0x17 preamp (s16 BE ×10), 0x18 band count, 0x19 save
// (0x21 on newer models). Band: <index> <gain s16 BE ×10> <freq u16 BE> <q u16 BE ×100> <type>.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { be16, field, grid, I16, readI16be, readU16be, U16, U8 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type { Codec, HandlerContext, HidFrame, HidHandler, WriteState } from '../handler.ts';
import { hidFrame, hidRequest, sendFrame, typeCodes } from '../io.ts';
import type { HidTransport } from '../transport.ts';

export interface FiioUsbHidOptions {
	/** Report id. Default 7. */
	reportId?: number;
	/** Command that saves to a preset. Default 0x19; 0x21 on newer models. */
	saveCommand?: number;
	/** Preset that means "EQ off"; reading it reports no current slot. */
	disabledPresetId?: number;
}

const BAND = 0x15;
const PRESET = 0x16;
const PREAMP = 0x17;
const COUNT = 0x18;
const SAVE = 0x19;
const END = 0xee;

export const FIIO_TYPES = typeCodes('fiio', { PK: 0, LSC: 1, HSC: 2 });

/** 0 Hz is left out: with 0 dB and Q 0 it reads back as an unused band. */
const FREQ = [1, 0xffff] as const;

/** One band's 7 bytes after its index (shared with the USB serial protocol). */
export function encodeFiioBand(f: Filter): number[] {
	return [
		...be16(field(f.gain, 10, I16, 'gain') & 0xffff),
		...be16(field(f.freq, 1, FREQ, 'freq')),
		...be16(field(f.q, 100, U16, 'q')),
		FIIO_TYPES.encode(f.type)
	];
}

/** The band at `offset`; null for an all-zero (unused) band. */
export function decodeFiioBand(b: ArrayLike<number>, offset: number): Filter | null {
	const gain = readI16be(b, offset);
	const freq = readU16be(b, offset + 2);
	const q = readU16be(b, offset + 4);
	if (gain === 0 && freq === 0 && q === 0) return null;
	return { type: FIIO_TYPES.decode(b[offset + 6] ?? 0), freq, q: q / 100, gain: gain / 10 };
}

/** FiiO's wire grid (also the USB serial protocol's). */
export const FIIO_WIRE = {
	freq: grid(1, FREQ),
	q: grid(100, U16),
	gain: grid(10, I16),
	preamp: grid(10, I16)
};

const set = (cmd: number, data: number[]) => [0xaa, 0x0a, 0, 0, cmd, data.length, ...data, 0, END];
const get = (cmd: number, data: number[] = []) => [
	0xbb,
	0x0b,
	0,
	0,
	cmd,
	data.length,
	...data,
	0,
	END
];
const reportId = (o: FiioUsbHidOptions) => o.reportId ?? 7;

export const fiioUsbHidCodec: Codec<FiioUsbHidOptions, HidFrame> = {
	types: FIIO_TYPES.types,
	wire: () => FIIO_WIRE,
	encode({ filters, preamp, slot }, o) {
		const frames: number[][] = [];
		if (preamp !== undefined)
			frames.push(set(PREAMP, be16(field(preamp, 10, I16, 'preamp') & 0xffff)));
		frames.push(set(COUNT, [field(filters.length, 1, U8, 'band count')]));
		filters.forEach((f, i) => frames.push(set(BAND, [i, ...encodeFiioBand(f)])));
		if (slot !== undefined) frames.push(set(o.saveCommand ?? SAVE, [field(slot, 1, U8, 'slot')]));
		return frames.map((d) => hidFrame(reportId(o), d));
	},
	decode(frames, o) {
		const state: WriteState = { filters: [] };
		for (const { data: d } of frames) {
			if (d[0] !== 0xaa) continue;
			if (d[4] === BAND) state.filters[d[6]!] = decodeFiioBand(d, 7);
			else if (d[4] === PREAMP) state.preamp = readI16be(d, 6) / 10;
			else if (d[4] === (o.saveCommand ?? SAVE)) state.slot = d[6]!;
		}
		return state;
	}
};

type Ctx = HandlerContext<HidTransport, FiioUsbHidOptions>;

function ask(ctx: Ctx, cmd: number, data: number[] = []) {
	return hidRequest(
		ctx.transport,
		reportId(ctx.options),
		get(cmd, data),
		(d) => d[0] === 0xbb && d[1] === 0x0b && d[4] === cmd && (cmd !== BAND || d[6] === data[0]),
		2000,
		`FiiO command 0x${cmd.toString(16)}`
	);
}

const presetOf = (ctx: Ctx, d: Uint8Array) =>
	d[6] === ctx.options.disabledPresetId ? undefined : d[6];

export const fiioUsbHid: HidHandler<FiioUsbHidOptions> = {
	id: 'fiio-usb-hid',
	transport: 'hid',
	codec: fiioUsbHidCodec,

	capabilities: () => ({
		canRead: true,
		canWrite: true,
		readsPreamp: true,
		writesPreamp: true,
		writesSlot: true,
		needsBandCount: false,
		readsCurrentSlot: true,
		canEnable: true
	}),

	async pull(ctx) {
		const slot = presetOf(ctx, await ask(ctx, PRESET));
		const count = (await ask(ctx, COUNT))[6]!;
		const preamp = readI16be(await ask(ctx, PREAMP), 6) / 10;
		const filters: (Filter | null)[] = [];
		for (let i = 0; i < count; i++) filters.push(decodeFiioBand(await ask(ctx, BAND, [i]), 7));
		return slot === undefined ? { filters, preamp } : { filters, preamp, slot };
	},

	async push(ctx, request) {
		const frames = fiioUsbHidCodec.encode(request, ctx.options);
		const save = ctx.options.saveCommand ?? SAVE;
		for (const frame of frames) {
			// The device needs a moment after the band count and before the save.
			if (frame.data[4] === save) await ctx.sleep(100);
			await sendFrame(ctx.transport, frame);
			if (frame.data[4] === COUNT) await ctx.sleep(100);
		}
		return { reconnect: false };
	},

	async currentSlot(ctx) {
		return presetOf(ctx, await ask(ctx, PRESET)) ?? null;
	},

	async setEnabled(ctx, enabled, slot) {
		const id = enabled ? slot : ctx.options.disabledPresetId;
		if (id === undefined) {
			throw new BridgeError(
				'invalid-request',
				enabled
					? 'FiiO: enabling EQ needs a preset slot'
					: 'FiiO: this model has no "EQ off" preset'
			);
		}
		await sendFrame(
			ctx.transport,
			hidFrame(reportId(ctx.options), set(PRESET, [field(id, 1, U8, 'slot')]))
		);
	}
};
