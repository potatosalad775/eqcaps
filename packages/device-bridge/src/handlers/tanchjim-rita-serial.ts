// Tanchjim Rita over Bluetooth SPP, 12 bands (devicePEQ ritaUsbSerialHandler.js, 0BSD, at 0617f38).
//
// TX: FF A1 <len> <cmd> <data…> AA; RX: FF A2 <len> <cmd> <data…>, len counting cmd and data.
// Read all (0x0B) and write all (0x2B, count 0x0C) carry 12 bands of 7 bytes: type,
// gain s16 BE ×100, freq u16 BE, q u16 BE ×100. Type 0x01 is peaking; no other code is known, and
// unknown codes read back as `x-wire-<code>`.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { be16, field, grid, I16, readI16be, readU16be, U16 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import { SPP, type Codec, type StreamHandler, type WriteState } from '../handler.ts';
import { refuseUncarried, StreamReader, typeCodes } from '../io.ts';

const BANDS = 12;
const GET_ALL_EQ = Uint8Array.from([0xff, 0xa1, 0x01, 0x0b, 0xaa]);

export const RITA_TYPES = typeCodes('tanchjim-rita', { PK: 0x01 });

/** Bands from the first band byte at `offset` (5 in both the read answer and the write). */
function decodeBands(d: ArrayLike<number>, offset: number): Filter[] {
	return Array.from({ length: BANDS }, (_, i) => {
		const o = offset + i * 7;
		return {
			type: RITA_TYPES.decode(d[o]!),
			gain: readI16be(d, o + 1) / 100,
			freq: readU16be(d, o + 3),
			q: readU16be(d, o + 5) / 100
		};
	});
}

export const ritaCodec: Codec<object, Uint8Array> = {
	types: RITA_TYPES.types,
	wire: () => ({ freq: grid(1, U16), q: grid(100, U16), gain: grid(100, I16) }),
	encode(request) {
		refuseUncarried('tanchjim-rita-serial', request, {});
		const { filters } = request;
		if (filters.length !== BANDS) {
			throw new BridgeError('invalid-request', `Rita: the write carries exactly ${BANDS} bands`);
		}
		const body = filters.flatMap((f) => [
			RITA_TYPES.encode(f.type),
			...be16(field(f.gain, 100, I16, 'gain') & 0xffff),
			...be16(field(f.freq, 1, U16, 'freq')),
			...be16(field(f.q, 100, U16, 'q'))
		]);
		return [Uint8Array.from([0xff, 0xa1, 0x56, 0x2b, 0x0c, ...body, 0xaa])];
	},
	decode(frames): WriteState {
		const frame = frames.find((f) => f[3] === 0x2b);
		return { filters: frame ? decodeBands(frame, 5) : [] };
	}
};

function frameAt(buf: readonly number[]): [number, number] | null {
	for (let i = 0; i + 2 < buf.length; i++) {
		if (buf[i] === 0xff && buf[i + 1] === 0xa2) {
			const end = i + 3 + buf[i + 2]!;
			return buf.length >= end ? [i, end] : null;
		}
	}
	return null;
}

export const tanchjimRitaSerial: StreamHandler = {
	id: 'tanchjim-rita-serial',
	transport: 'serial',
	codec: ritaCodec,
	sppServiceClass: SPP,

	capabilities: () => ({
		canRead: true,
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

	async pull(ctx) {
		const reader = new StreamReader(ctx.transport);
		await reader.send(GET_ALL_EQ);
		const frame = await reader.readFrame(frameAt, 8000, 'Rita EQ read');
		if (frame.length < 5 + BANDS * 7 || frame[3] !== 0x0b) {
			throw new BridgeError('bad-response', `Rita: unexpected EQ answer (${frame.length} bytes)`);
		}
		return { filters: decodeBands(frame, 5) };
	},

	async push(ctx, request) {
		for (const frame of ritaCodec.encode(request, {})) await ctx.transport.write(frame);
		return { reconnect: false };
	}
};
