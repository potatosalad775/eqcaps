// Edifier ConnectX headphones (W830NB) over Bluetooth SPP, 4 bands, write-only here: the protocol
// has a read command (0x43) nobody has decoded yet (devicePEQ edifierUsbSerialHandler.js, 0BSD,
// at 0617f38).
//
// Frame: AA EC <cmd> <length u16 BE> <payload…> <sum of all bytes & 0xFF>. Set band (0x44):
// [band id, A5, freq code (2 bytes), A9 + gain ×4, 95 + q ×14]. Band ids are A5 A4 A7 A6.
// The frequency code follows no known formula: only the captured table entries can be sent, and
// any other frequency is `unrepresentable`.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { be16, wireInt } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import { SPP, type Codec, type StreamHandler, type WriteState } from '../handler.ts';
import { refuseUncarried, typeCodes } from '../io.ts';

const SET_BAND = 0x44;
const BAND_IDS = [0xa5, 0xa4, 0xa7, 0xa6];
const GAIN_ZERO = 0xa9;
const Q_ZERO = 0x95;

/** Captured frequency codes (verified on a W830NB, January 2026). */
export const EDIFIER_FREQUENCIES: ReadonlyMap<number, readonly [number, number]> = new Map([
	[20, [0xa5, 0xb1]],
	[50, [0xa5, 0x97]],
	[75, [0xa5, 0xee]],
	[76, [0xa5, 0xe9]],
	[77, [0xa5, 0xe8]],
	[100, [0xa5, 0xc1]],
	[150, [0xa5, 0x33]],
	[175, [0xa5, 0x0a]],
	[200, [0xa5, 0x6d]],
	[400, [0xa4, 0x35]],
	[500, [0xa4, 0x51]],
	[1000, [0xa6, 0x4d]],
	[1500, [0xa0, 0x79]],
	[2000, [0xa2, 0x75]],
	[3000, [0xae, 0x1d]],
	[3078, [0xa9, 0xa3]],
	[4000, [0xaa, 0x05]],
	[5000, [0xb6, 0x2d]],
	[6000, [0xb2, 0xd5]],
	[8000, [0xba, 0xe5]],
	[10000, [0x82, 0xb5]]
]);

const TYPES = typeCodes('edifier', { PK: 0 });

function encodeBand(band: number, f: Filter): Uint8Array {
	TYPES.encode(f.type);
	const id = BAND_IDS[band];
	if (id === undefined) throw new BridgeError('invalid-request', `Edifier: no band ${band}`);
	const freq = EDIFIER_FREQUENCIES.get(Math.round(f.freq * 1e6) / 1e6);
	if (!freq)
		throw new BridgeError('unrepresentable', `Edifier: no frequency code for ${f.freq} Hz`);
	const gain = GAIN_ZERO + wireInt(f.gain, 4, -GAIN_ZERO, 0xff - GAIN_ZERO, 'gain');
	const q = Q_ZERO + wireInt(f.q, 14, -Q_ZERO, 0xff - Q_ZERO, 'q');
	const payload = [id, 0xa5, ...freq, gain, q];
	const frame = [0xaa, 0xec, SET_BAND, ...be16(payload.length), ...payload];
	return Uint8Array.from([...frame, frame.reduce((a, b) => (a + b) & 0xff, 0)]);
}

export const edifierCodec: Codec<object, Uint8Array> = {
	types: TYPES.types,
	wire: () => ({
		freq: { values: [...EDIFIER_FREQUENCIES.keys()] },
		q: { min: -Q_ZERO / 14, max: (0xff - Q_ZERO) / 14, step: 1 / 14 },
		gain: { min: -GAIN_ZERO / 4, max: (0xff - GAIN_ZERO) / 4, step: 0.25 }
	}),
	encode(request) {
		refuseUncarried('edifier-serial', request, {});
		return request.filters.map((f, i) => encodeBand(i, f));
	},
	decode(frames) {
		const state: WriteState = { filters: [] };
		for (const d of frames) {
			if (d[2] !== SET_BAND) continue;
			const freq = [...EDIFIER_FREQUENCIES].find(([, c]) => c[0] === d[7] && c[1] === d[8])?.[0];
			state.filters[BAND_IDS.indexOf(d[5]!)] = {
				type: 'PK',
				freq: freq ?? NaN,
				q: (d[10]! - Q_ZERO) / 14,
				gain: (d[9]! - GAIN_ZERO) / 4
			};
		}
		return state;
	}
};

export const edifierSerial: StreamHandler = {
	id: 'edifier-serial',
	transport: 'serial',
	codec: edifierCodec,
	sppServiceClass: SPP,

	capabilities: () => ({
		canRead: false,
		canWrite: true,
		readsPreamp: false,
		writesPreamp: false,
		writesSlot: false,
		bands: BAND_IDS.length,
		needsBandCount: false,
		readsCurrentSlot: false,
		canEnable: false
	}),

	async pull() {
		throw new BridgeError('unsupported', 'Edifier: reading EQ back is not implemented');
	},

	async push(ctx, request) {
		for (const frame of edifierCodec.encode(request, {})) {
			await ctx.transport.write(frame);
			await ctx.sleep(50);
		}
		return { reconnect: false };
	}
};
