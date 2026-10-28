// KT Micro register protocol (Kiwi Ears, Tanchjim, JCally, Moondrop CDSP and Chu 2 DSP; devicePEQ
// ktmicroUsbHidHandler.js, 0BSD, at 0617f38; Tanchjim's Android app, which calls it "FeiFan").
//
// 10-byte packets on report 0x4B: [register, 0, 0, 0, cmd, 0, data…], cmd 'R' 0x52 read, 'W' 0x57
// write, 'S' 0x53 commit; answers echo register and cmd. A band has two registers: gain s16 LE ×10
// and freq u16 LE, then q u16 LE ×1000 and type. Register 0x24 is the EQ slot, 0x66 the preamp
// (s8 dB). Not every model acknowledges register writes; the commit makes them take effect.
// Tanchjim's app never touches 0x24 or 0x66, paces its writes 400 ms apart, and stores half the
// frequency on its Zero, One and Tanya (D39): the options below say so per device.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { field, grid, I16, I8, le16, readI16le, readI8, readU16le, U16, U8 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type { Codec, HandlerContext, HidFrame, HidHandler, WriteState } from '../handler.ts';
import { hidFrame, hidRequest, refuseUncarried, sendFrame, typeCodes } from '../io.ts';
import type { HidTransport } from '../transport.ts';

export interface KtmicroHidOptions {
	/** First band register; band i uses base + 2i and base + 2i + 1. Default 0x26. */
	baseRegister?: number;
	/** Explicit (gain/freq, q/type) registers per band, for models that skip or reorder them. */
	bandRegisters?: readonly { freq: number; q: number }[];
	/** Slot of the custom EQ. Default 3. */
	customSlot?: number;
	/** Hz per unit of the frequency field: 2 on firmware that stores half the frequency. Default 1. */
	freqUnit?: number;
	/** The EQ slot register 0x24 selects the slot and turns the EQ off. Default true. */
	slotRegister?: boolean;
	/** The preamp register 0x66 is read and written. Default true. */
	preampRegister?: boolean;
	/** Milliseconds between the frames of a push. Default 0. */
	frameDelay?: number;
}

const REPORT_ID = 0x4b;
const READ = 0x52;
const WRITE = 0x57;
const COMMIT = 0x53;
const SLOT = 0x24;
const PREAMP = 0x66;

export const KTMICRO_TYPES = typeCodes('ktmicro', { PK: 0, LPQ: 1, HPQ: 2, LSC: 3, HSC: 4 });

export function ktmicroRegisters(o: KtmicroHidOptions, band: number) {
	if (o.bandRegisters) {
		const explicit = o.bandRegisters[band];
		if (!explicit) {
			throw new BridgeError(
				'invalid-request',
				`KT Micro: band ${band}, the device has ${o.bandRegisters.length}`
			);
		}
		return explicit;
	}
	const freq = (o.baseRegister ?? 0x26) + band * 2;
	return { freq, q: freq + 1 };
}

const packet = (register: number, cmd: number, data: number[] = []) => {
	const bytes = new Array<number>(10).fill(0);
	[register, 0, 0, 0, cmd, 0, ...data].forEach((b, i) => (bytes[i] = b));
	return bytes;
};

const hasPreamp = (o: KtmicroHidOptions) => o.preampRegister !== false;
const hasSlots = (o: KtmicroHidOptions) => o.slotRegister !== false;
const freqUnit = (o: KtmicroHidOptions) => o.freqUnit ?? 1;

/** One band from its two register answers or writes. */
const band = (a: ArrayLike<number>, b: ArrayLike<number>, o: KtmicroHidOptions): Filter => ({
	type: KTMICRO_TYPES.decode(b[8] ?? 0),
	freq: readU16le(a, 8) * freqUnit(o),
	q: readU16le(b, 6) / 1000,
	gain: readI16le(a, 6) / 10
});

export const ktmicroCodec: Codec<KtmicroHidOptions, HidFrame> = {
	types: KTMICRO_TYPES.types,
	wire: (o) => ({
		freq: grid(1 / freqUnit(o), U16),
		q: grid(1000, U16),
		gain: grid(10, I16),
		...(hasPreamp(o) ? { preamp: grid(1, I8) } : {})
	}),
	encode(request, o) {
		refuseUncarried('ktmicro-usb-hid', request, { preamp: hasPreamp(o) });
		const { filters, preamp } = request;
		const frames = filters.flatMap((f, i) => {
			const regs = ktmicroRegisters(o, i);
			const freq = field(f.freq, 1 / freqUnit(o), U16, 'freq');
			return [
				packet(regs.freq, WRITE, [...le16(field(f.gain, 10, I16, 'gain') & 0xffff), ...le16(freq)]),
				packet(regs.q, WRITE, [
					...le16(field(f.q, 1000, U16, 'q')),
					KTMICRO_TYPES.encode(f.type),
					0
				])
			];
		});
		if (preamp !== undefined)
			frames.push(packet(PREAMP, WRITE, [field(preamp, 1, I8, 'preamp') & 0xff]));
		frames.push(packet(0, COMMIT));
		return frames.map((d) => hidFrame(REPORT_ID, d));
	},
	decode(frames, o) {
		const byRegister = new Map(
			frames.filter((f) => f.data[4] === WRITE).map((f) => [f.data[0]!, f.data] as const)
		);
		const state: WriteState = { filters: [] };
		for (let i = 0; i < (o.bandRegisters?.length ?? Infinity); i++) {
			const regs = ktmicroRegisters(o, i);
			const a = byRegister.get(regs.freq);
			const b = byRegister.get(regs.q);
			if (!a || !b) break;
			state.filters.push(band(a, b, o));
		}
		const preamp = byRegister.get(PREAMP);
		if (preamp && hasPreamp(o)) state.preamp = readI8(preamp, 6);
		return state;
	}
};

type Ctx = HandlerContext<HidTransport, KtmicroHidOptions>;

function request(ctx: Ctx, bytes: number[], what: string) {
	return hidRequest(
		ctx.transport,
		REPORT_ID,
		bytes,
		(d) => d[0] === bytes[0] && d[4] === bytes[4],
		1000,
		what
	);
}

const readSlot = async (ctx: Ctx) =>
	(await request(ctx, packet(SLOT, READ, [0x03]), 'KT Micro slot'))[6]!;
const selectSlot = (ctx: Ctx, slot: number) =>
	request(ctx, packet(SLOT, WRITE, [field(slot, 1, U8, 'slot')]), 'KT Micro slot switch');

export const ktmicroUsbHid: HidHandler<KtmicroHidOptions> = {
	id: 'ktmicro-usb-hid',
	transport: 'hid',
	codec: ktmicroCodec,
	bypassPreset: true,

	capabilities: (_transport, o) => ({
		canRead: true,
		canWrite: true,
		readsPreamp: hasPreamp(o),
		readsSlot: false,
		writesPreamp: hasPreamp(o),
		writesSlot: false,
		...(o.bandRegisters ? { bands: o.bandRegisters.length } : {}),
		needsBandCount: !o.bandRegisters,
		readsCurrentSlot: hasSlots(o),
		canEnable: hasSlots(o)
	}),

	async pull(ctx, { bands }) {
		const filters: Filter[] = [];
		const count = bands ?? ctx.options.bandRegisters?.length ?? 0;
		for (let i = 0; i < count; i++) {
			const regs = ktmicroRegisters(ctx.options, i);
			const a = await request(ctx, packet(regs.freq, READ), `KT Micro band ${i}`);
			const b = await request(ctx, packet(regs.q, READ), `KT Micro band ${i} q`);
			filters.push(band(a, b, ctx.options));
		}
		if (!hasPreamp(ctx.options)) return { filters };
		const preamp = await request(ctx, packet(PREAMP, READ), 'KT Micro preamp');
		return { filters, preamp: readI8(preamp, 6) };
	},

	async push(ctx, request) {
		const frames = ktmicroCodec.encode(request, ctx.options);
		// Writes don't take while EQ is off: switch the custom slot on first.
		if (hasSlots(ctx.options) && (await readSlot(ctx)) === (ctx.bypass ?? 2)) {
			await selectSlot(ctx, ctx.options.customSlot ?? 3);
		}
		const delay = ctx.options.frameDelay ?? 0;
		for (const [i, frame] of frames.entries()) {
			if (i > 0 && delay > 0) await ctx.sleep(delay);
			await sendFrame(ctx.transport, frame);
		}
		await ctx.sleep(1000);
		return { reconnect: false };
	},

	async currentSlot(ctx) {
		if (!hasSlots(ctx.options)) return null;
		const slot = await readSlot(ctx);
		return slot === (ctx.bypass ?? 2) ? null : slot;
	},

	async setEnabled(ctx, enabled, slot) {
		if (!hasSlots(ctx.options)) {
			throw new BridgeError('unsupported', 'ktmicro-usb-hid: this device has no EQ switch');
		}
		await selectSlot(ctx, enabled ? (slot ?? ctx.options.customSlot ?? 3) : (ctx.bypass ?? 2));
	}
};
