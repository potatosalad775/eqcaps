// Conexant "Freeman" DSP over USB HID (Moondrop FreeDSP, ECHO-B), write-only (devicePEQ
// conexantUsbHidHandler.js, 0BSD, at 0617f38).
//
// 61-byte packets on report 1: [1, 1, 0, length | id << 16 (u32 LE), 0x00B307B0 (u32 LE),
// s32 LE words…]. Per band (numbered from 1): a config frame [0, band, freq, q ×256, type,
// gain ×256], then a coefficient frame per sample rate [rate index, band, 3, b0, b1, b2, −a1, −a2]
// in Q2.30. A mode frame [90, 0] applies the result.

import { biquadQ30 } from '../biquad.ts';
import { field, grid, I32, le32, readI32le, U16 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type { Codec, HidFrame, HidHandler, WriteState } from '../handler.ts';
import { hidFrame, refuseUncarried, sendFrame, typeCodes } from '../io.ts';

const REPORT_ID = 0x01;
const MAGIC = 0xb307b0;
const SAVE = 220;
const MODE = 90;
const BANDS = 9;
const SAMPLE_RATES = [
	[0x04, 44100],
	[0x05, 48000],
	[0x06, 96000],
	[0x07, 192000]
] as const;

const TYPES = typeCodes('conexant', { PK: 0, LSC: 1, HSC: 2 });

function packet(id: number, words: readonly number[]): HidFrame {
	const data = new Uint8Array(61);
	data.set([1, 1, 0, ...le32(words.length | ((id & 0xfff) << 16)), ...le32(MAGIC)]);
	data.set(
		words.flatMap((w) => le32(w)),
		11
	);
	return hidFrame(REPORT_ID, data);
}

const word = (d: ArrayLike<number>, i: number) => readI32le(d, 11 + 4 * i);

export const conexantCodec: Codec<object, HidFrame> = {
	types: TYPES.types,
	wire: () => ({
		freq: grid(1, U16),
		q: { ...grid(256, I32), min: 1 / 256 },
		gain: grid(256, I32)
	}),
	encode(request) {
		refuseUncarried('conexant-usb-hid', request, {});
		const { filters } = request;
		if (filters.length > BANDS) {
			throw new BridgeError(
				'invalid-request',
				`Conexant: ${filters.length} bands, the DSP has ${BANDS}`
			);
		}
		const frames = filters.flatMap((f, i) => {
			const band = i + 1;
			const freq = field(f.freq, 1, U16, 'freq');
			return [
				packet(SAVE, [
					0,
					band,
					freq,
					field(f.q, 256, I32, 'q'),
					TYPES.encode(f.type),
					field(f.gain, 256, I32, 'gain')
				]),
				...SAMPLE_RATES.map(([index, rate]) =>
					packet(SAVE, [index, band, 3, ...biquadQ30(f.type, freq, f.gain, f.q, rate)])
				)
			];
		});
		return [...frames, packet(MODE, [90, 0])];
	},
	decode(frames) {
		const state: WriteState = { filters: [] };
		for (const { data: d } of frames) {
			if (d[5] !== SAVE || word(d, 0) !== 0) continue;
			state.filters[word(d, 1) - 1] = {
				type: TYPES.decode(word(d, 4)),
				freq: word(d, 2),
				q: word(d, 3) / 256,
				gain: word(d, 5) / 256
			};
		}
		return state;
	}
};

export const conexantUsbHid: HidHandler = {
	id: 'conexant-usb-hid',
	transport: 'hid',
	codec: conexantCodec,

	capabilities: () => ({
		canRead: false,
		canWrite: true,
		readsPreamp: false,
		readsSlot: false,
		writesPreamp: false,
		writesSlot: false,
		bands: BANDS,
		needsBandCount: false,
		readsCurrentSlot: false,
		canEnable: false
	}),

	async pull() {
		throw new BridgeError('unsupported', 'Conexant: the protocol has no read command');
	},

	async push(ctx, request) {
		for (const frame of conexantCodec.encode(request, {})) {
			await sendFrame(ctx.transport, frame);
			await ctx.sleep(15);
		}
		return { reconnect: false };
	}
};
