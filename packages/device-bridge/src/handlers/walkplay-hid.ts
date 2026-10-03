// Walkplay-chipset USB DACs and dongles, every scheme group (devicePEQ walkplayHidHandler.js,
// 0BSD, at 0617f38).
//
// Report 0x4B; requests [0x80 read | 0x01 write, <cmd>, …]. A band write (cmd 0x09) carries the
// band twice: as Q2.30 biquad coefficients at 96 kHz (bytes 7–26), and as metadata from byte 27:
// freq u16 LE, q u16 LE ×256, gain s16 LE ×256, type, 0, slot. Reads answer in the same layout.
// Both forms carry the frequency as given, in Hz. Some firmware is reported to place a band off
// that frequency (SchemeNo11 about 2.25% low); the codec doesn't correct for it (D39).
// Preamp: cmd 0x03, s8 dB. A write ends with a commit: [1,5,0], [1,0x17,0], [1,0x0A,4,0,0,FF,FF,0],
// [1,1,1,0] (persist, PEQ on).

import type { Filter } from '@potatosalad775/eqcaps-core';
import { biquadQ30, coefficientBytes } from '../biquad.ts';
import { field, grid, I16, I8, le16, readI16le, readI8, readU16le, U8 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type { Codec, HandlerContext, HidFrame, HidHandler, WriteState } from '../handler.ts';
import { hidFrame, hidRequest, sendFrame, typeCodes, waitForInput } from '../io.ts';
import type { HidTransport } from '../transport.ts';

export interface WalkplayHidOptions {
	/** Slot byte of a write that names no slot. Default 101 ("Custom"). */
	defaultSlot?: number;
}

const REPORT_ID = 0x4b;
const READ = 0x80;
const WRITE = 0x01;
const BAND = 0x09;
const PREAMP = 0x03;
const COMMIT = [
	[WRITE, 0x05, 0x00],
	[WRITE, 0x17, 0x00],
	[WRITE, 0x0a, 0x04, 0x00, 0x00, 0xff, 0xff, 0x00],
	[WRITE, 0x01, 0x01, 0x00]
];

export const WALKPLAY_TYPES = typeCodes('walkplay', { PK: 2, LSC: 1, HSC: 3, LPQ: 4, HPQ: 5 });

/** The band of a read answer or write frame; null for an unset band. */
export function decodeWalkplayBand(d: ArrayLike<number>): Filter | null {
	const freq = readU16le(d, 27);
	const q = readU16le(d, 29);
	if (freq === 0 || freq === 0xffff || q === 0) return null;
	return {
		type: WALKPLAY_TYPES.decode(d[33] ?? 0),
		freq,
		q: q / 256,
		gain: readI16le(d, 31) / 256
	};
}

/** 0 and 0xFFFF in freq, and 0 in q, read back as an unset band. */
const FREQ = [1, 0xfffe] as const;
const Q = [1, 0xffff] as const;

export const walkplayHidCodec: Codec<WalkplayHidOptions, HidFrame> = {
	types: WALKPLAY_TYPES.types,
	wire: () => ({
		freq: grid(1, FREQ),
		q: grid(256, Q),
		gain: grid(256, I16),
		preamp: grid(1, I8)
	}),
	encode({ filters, preamp, slot }, o) {
		const slotByte = field(slot ?? o.defaultSlot ?? 101, 1, U8, 'slot');
		const frames = filters.map((f, i) => {
			const freq = field(f.freq, 1, FREQ, 'freq');
			const type = WALKPLAY_TYPES.encode(f.type);
			const coeffs = biquadQ30(f.type, freq, f.gain, f.q, 96000);
			return [
				WRITE,
				BAND,
				0x18,
				0x00,
				field(i, 1, U8, 'band index'),
				0x00,
				0x00,
				...coefficientBytes(coeffs),
				...le16(freq),
				...le16(field(f.q, 256, Q, 'q')),
				...le16(field(f.gain, 256, I16, 'gain') & 0xffff),
				type,
				0x00,
				slotByte,
				0x00
			];
		});
		if (preamp !== undefined) {
			frames.push([WRITE, PREAMP, 0x02, 0x00, field(preamp, 1, I8, 'preamp') & 0xff]);
		}
		return [...frames, ...COMMIT].map((d) => hidFrame(REPORT_ID, d));
	},
	decode(frames) {
		const state: WriteState = { filters: [] };
		for (const { data: d } of frames) {
			if (d[0] !== WRITE) continue;
			if (d[1] === BAND) {
				state.filters[d[4]!] = decodeWalkplayBand(d);
				state.slot = d[35]!;
			} else if (d[1] === PREAMP) state.preamp = readI8(d, 4);
		}
		return state;
	}
};

type Ctx = HandlerContext<HidTransport, WalkplayHidOptions>;

const send = (ctx: Ctx, bytes: number[]) =>
	ctx.transport.sendReport(REPORT_ID, Uint8Array.from(bytes));

export const walkplayHid: HidHandler<WalkplayHidOptions> = {
	id: 'walkplay-hid',
	transport: 'hid',
	codec: walkplayHidCodec,

	capabilities: () => ({
		canRead: true,
		canWrite: true,
		readsPreamp: true,
		readsSlot: false,
		writesPreamp: true,
		writesSlot: true,
		needsBandCount: true,
		readsCurrentSlot: true,
		canEnable: true
	}),

	async pull(ctx, { bands = 0 }) {
		const filters: (Filter | null)[] = [];
		for (let i = 0; i < bands; i++) {
			const answer = await hidRequest(
				ctx.transport,
				REPORT_ID,
				[READ, BAND, 0x00, 0x00, i, 0x00],
				(d) => d[1] === BAND && d[4] === i && d.length >= 34,
				2000,
				`Walkplay band ${i}`
			);
			filters.push(decodeWalkplayBand(answer));
		}
		const result: { filters: (Filter | null)[]; preamp?: number } = { filters };
		try {
			const answer = await hidRequest(
				ctx.transport,
				REPORT_ID,
				[READ, PREAMP, 0x00],
				(d) => d[0] === READ && d[1] === PREAMP,
				1000,
				'Walkplay preamp'
			);
			result.preamp = readI8(answer, 4);
		} catch (error) {
			ctx.log(`Walkplay: no preamp (${String(error)})`);
		}
		return result;
	},

	async push(ctx, request) {
		const frames = walkplayHidCodec.encode(request, ctx.options);
		for (const frame of frames) {
			await sendFrame(ctx.transport, frame);
			await ctx.sleep(frame.data[1] === BAND ? 20 : 50);
		}
		return { reconnect: false };
	},

	async currentSlot(ctx) {
		const answer = waitForInput(ctx.transport, (d) => d[1] === BAND, 2000, 'Walkplay slot');
		answer.catch(() => {});
		await send(ctx, [READ, BAND, 0x00]);
		// Byte 36 of the full report; the transport strips the report id.
		const slot = (await answer)[35];
		if (slot === undefined) throw new BridgeError('bad-response', 'Walkplay: short slot answer');
		return slot;
	},

	async setEnabled(ctx, enabled, slot) {
		const id = enabled ? (slot ?? ctx.options.defaultSlot ?? 101) : 0;
		await send(ctx, [WRITE, 0x01, enabled ? 1 : 0, field(id, 1, U8, 'slot'), 0x00]);
	}
};
