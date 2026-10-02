// Moondrop USB HID, a Walkplay-derived protocol (Rays, Marigold, FreeDSP Pro/Mini, Dawn Pro…;
// devicePEQ moondropUsbHidHandler.js, 0BSD, at 0617f38).
//
// Report 0x4B, 63-byte writes. Band: [0x01, 0x09, 0x18, 0, index, 0, 0, Q2.30 biquad at 96 kHz
// (20 bytes), freq u16 LE, q s16 LE ×256, gain s16 LE ×256, type, 0, 7], then
// [0x01, 0x0A, index, 0, FF, FF, FF] loads the coefficients. Reads ([0x80, 0x09, 0x18, 0, index, 0])
// answer in the band layout. Preamp: written with cmd 0x23, read with cmd 0x03 (s16 LE ×256).
// Save: [0x01, 0x01].

import type { Filter } from '@potatosalad775/eqcaps-core';
import { biquadQ30, coefficientBytes } from '../biquad.ts';
import { field, grid, I16, le16, readI16le, readU16le, U8 } from '../bytes.ts';
import type { Codec, HidFrame, HidHandler, WriteState } from '../handler.ts';
import { hidFrame, hidRequest, refuseUncarried, sendFrame, typeCodes } from '../io.ts';

const REPORT_ID = 0x4b;
const WRITE = 0x01;
const READ = 0x80;
const BAND = 0x09;
const LOAD = 0x0a;
const SAVE = 0x01;
const PREAMP_READ = 0x03;
const PREAMP_WRITE = 0x23;
const ACTIVE_EQ = 0x0f;

/** Outside 10 Hz–24 kHz a band reads back as unset. */
const FREQ = [10, 24000] as const;

export const MOONDROP_TYPES = typeCodes('moondrop', { PK: 2, LSC: 1, HSC: 3 });

/** Null for a band whose frequency is outside 10 Hz–24 kHz: what an unset band reads as. */
export function decodeMoondropBand(d: ArrayLike<number>): Filter | null {
	const freq = readU16le(d, 27);
	if (freq < FREQ[0] || freq > FREQ[1]) return null;
	return {
		type: MOONDROP_TYPES.decode(d[33] ?? 0),
		freq,
		q: readI16le(d, 29) / 256,
		gain: readI16le(d, 31) / 256
	};
}

const padded = (bytes: number[]) => {
	const data = new Uint8Array(63);
	data.set(bytes);
	return data;
};

export const moondropUsbHidCodec: Codec<object, HidFrame> = {
	types: MOONDROP_TYPES.types,
	wire: () => ({
		freq: grid(1, FREQ),
		q: { ...grid(256, I16), min: 1 / 256 },
		gain: grid(256, I16),
		preamp: grid(256, I16)
	}),
	encode(request) {
		refuseUncarried('moondrop-usb-hid', request, { preamp: true });
		const { filters, preamp } = request;
		const frames: Uint8Array[] = [];
		filters.forEach((f, i) => {
			const freq = field(f.freq, 1, FREQ, 'freq');
			frames.push(
				padded([
					WRITE,
					BAND,
					0x18,
					0x00,
					field(i, 1, U8, 'band index'),
					0x00,
					0x00,
					...coefficientBytes(biquadQ30(f.type, freq, f.gain, f.q, 96000)),
					...le16(freq),
					...le16(field(f.q, 256, I16, 'q') & 0xffff),
					...le16(field(f.gain, 256, I16, 'gain') & 0xffff),
					MOONDROP_TYPES.encode(f.type),
					0,
					7
				]),
				padded([WRITE, LOAD, i, 0, 0xff, 0xff, 0xff])
			);
		});
		if (preamp !== undefined) {
			frames.push(
				padded([WRITE, PREAMP_WRITE, 0, ...le16(field(preamp, 256, I16, 'preamp') & 0xffff)])
			);
		}
		frames.push(Uint8Array.from([WRITE, SAVE]));
		return frames.map((d) => hidFrame(REPORT_ID, d));
	},
	decode(frames) {
		const state: WriteState = { filters: [] };
		for (const { data: d } of frames) {
			if (d[0] !== WRITE) continue;
			if (d[1] === BAND) state.filters[d[4]!] = decodeMoondropBand(d);
			else if (d[1] === PREAMP_WRITE) state.preamp = readI16le(d, 3) / 256;
		}
		return state;
	}
};

export const moondropUsbHid: HidHandler = {
	id: 'moondrop-usb-hid',
	transport: 'hid',
	codec: moondropUsbHidCodec,

	capabilities: () => ({
		canRead: true,
		canWrite: true,
		readsPreamp: true,
		writesPreamp: true,
		writesSlot: false,
		needsBandCount: true,
		readsCurrentSlot: true,
		canEnable: false
	}),

	async pull(ctx, { bands = 0 }) {
		const filters: (Filter | null)[] = [];
		for (let i = 0; i < bands; i++) {
			const answer = await hidRequest(
				ctx.transport,
				REPORT_ID,
				[READ, BAND, 0x18, 0x00, i, 0x00],
				// The answer echoes the band index at byte 4, as the Marigold capture shows.
				(d) => d[0] === READ && d[1] === BAND && d[4] === i,
				1000,
				`Moondrop band ${i}`
			);
			filters.push(decodeMoondropBand(answer));
		}
		const result: { filters: (Filter | null)[]; preamp?: number } = { filters };
		try {
			const answer = await hidRequest(
				ctx.transport,
				REPORT_ID,
				[READ, PREAMP_READ],
				(d) => d[0] === READ && d[1] === PREAMP_READ,
				1000,
				'Moondrop preamp'
			);
			result.preamp = readI16le(answer, 3) / 256;
		} catch (error) {
			ctx.log(`Moondrop: no preamp (${String(error)})`);
		}
		return result;
	},

	async push(ctx, request) {
		for (const frame of moondropUsbHidCodec.encode(request, {}))
			await sendFrame(ctx.transport, frame);
		return { reconnect: false };
	},

	async currentSlot(ctx) {
		const answer = await hidRequest(
			ctx.transport,
			REPORT_ID,
			[READ, ACTIVE_EQ, 0x00],
			(d) => d[0] === READ && d[1] === ACTIVE_EQ,
			1000,
			'Moondrop slot'
		);
		return answer[3] ?? null;
	}
};
