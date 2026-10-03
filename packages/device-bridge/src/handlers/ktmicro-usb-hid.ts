// KT Micro register protocol (Kiwi Ears, Tanchjim, JCally, Moondrop CDSP and Chu 2 DSP; devicePEQ
// ktmicroUsbHidHandler.js, 0BSD, at 0617f38).
//
// 10-byte packets on report 0x4B: [register, 0, 0, 0, cmd, 0, data…], cmd 'R' 0x52 read, 'W' 0x57
// write, 'S' 0x53 commit; answers echo register and cmd. A band has two registers: gain s16 LE ×10
// and freq u16 LE, then q u16 LE ×1000 and type. Register 0x24 is the EQ slot, 0x66 the preamp
// (s8 dB). Not every model acknowledges register writes; the commit makes them take effect.
// Older firmware is reported to double the frequency it's given; the codec doesn't correct for it
// (D39).

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
	/** Slot that switches EQ off. Default 2. */
	disabledSlot?: number;
	/** Slot of the custom EQ. Default 3. */
	customSlot?: number;
}

const REPORT_ID = 0x4b;
const READ = 0x52;
const WRITE = 0x57;
const COMMIT = 0x53;
const SLOT = 0x24;
const PREAMP = 0x66;

export const KTMICRO_TYPES = typeCodes('ktmicro', { PK: 0, LSC: 3, HSC: 4 });

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

export const ktmicroCodec: Codec<KtmicroHidOptions, HidFrame> = {
	types: KTMICRO_TYPES.types,
	wire: () => ({
		freq: grid(1, U16),
		q: grid(1000, U16),
		gain: grid(10, I16),
		preamp: grid(1, I8)
	}),
	encode(request, o) {
		refuseUncarried('ktmicro-usb-hid', request, { preamp: true });
		const { filters, preamp } = request;
		const frames = filters.flatMap((f, i) => {
			const regs = ktmicroRegisters(o, i);
			const freq = field(f.freq, 1, U16, 'freq');
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
			state.filters.push({
				type: KTMICRO_TYPES.decode(b[8]!),
				freq: readU16le(a, 8),
				q: readU16le(b, 6) / 1000,
				gain: readI16le(a, 6) / 10
			});
		}
		const preamp = byRegister.get(PREAMP);
		if (preamp) state.preamp = readI8(preamp, 6);
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

	capabilities: (_transport, o) => ({
		canRead: true,
		canWrite: true,
		readsPreamp: true,
		readsSlot: false,
		writesPreamp: true,
		writesSlot: false,
		...(o.bandRegisters ? { bands: o.bandRegisters.length } : {}),
		needsBandCount: !o.bandRegisters,
		readsCurrentSlot: true,
		canEnable: true
	}),

	async pull(ctx, { bands }) {
		const filters: Filter[] = [];
		const count = bands ?? ctx.options.bandRegisters?.length ?? 0;
		for (let i = 0; i < count; i++) {
			const regs = ktmicroRegisters(ctx.options, i);
			const a = await request(ctx, packet(regs.freq, READ), `KT Micro band ${i}`);
			const b = await request(ctx, packet(regs.q, READ), `KT Micro band ${i} q`);
			filters.push({
				type: KTMICRO_TYPES.decode(b[8] ?? 0),
				freq: readU16le(a, 8),
				q: readU16le(b, 6) / 1000,
				gain: readI16le(a, 6) / 10
			});
		}
		const preamp = await request(ctx, packet(PREAMP, READ), 'KT Micro preamp');
		return { filters, preamp: readI8(preamp, 6) };
	},

	async push(ctx, request) {
		const frames = ktmicroCodec.encode(request, ctx.options);
		// Writes don't take while EQ is off: switch the custom slot on first.
		if ((await readSlot(ctx)) === (ctx.options.disabledSlot ?? 2)) {
			await selectSlot(ctx, ctx.options.customSlot ?? 3);
		}
		for (const frame of frames) await sendFrame(ctx.transport, frame);
		await ctx.sleep(1000);
		return { reconnect: false };
	},

	async currentSlot(ctx) {
		const slot = await readSlot(ctx);
		return slot === (ctx.options.disabledSlot ?? 2) ? null : slot;
	},

	async setEnabled(ctx, enabled, slot) {
		await selectSlot(
			ctx,
			enabled ? (slot ?? ctx.options.customSlot ?? 3) : (ctx.options.disabledSlot ?? 2)
		);
	}
};
