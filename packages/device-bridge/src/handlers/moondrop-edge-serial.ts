// Moondrop Edge ANC over Bluetooth SPP, 5 peaking bands (devicePEQ
// moondropEdgeUsbSerialHandler.js, 0BSD, at 0617f38).
//
// Frame: FF 04 <payload length u16 BE> 00 1D <0A to device | 0B from device> <cmd> <payload…>.
// EQ payload (query 0x05 answer, write 0x06): 00 04, five band slots of 7 bytes (the last one 6),
// 3 bytes of padding. A slot is [gain of the previous band s16 BE ×60, freq u16 BE,
// q u16 BE ×4096, 0]: each band's gain sits in the next band's slot, the last band's in the
// padding.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { be16, field, grid, I16, readI16be, readU16be, U16 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import { SPP, type Codec, type StreamHandler, type WriteState } from '../handler.ts';
import { refuseUncarried, StreamReader, typeCodes } from '../io.ts';

const BANDS = 5;
const ENABLE_EQ = 0x03;
const QUERY_EQ = 0x05;
const SET_EQ = 0x06;

const TYPES = typeCodes('moondrop-edge', { PK: 0 });

export function edgeFrame(cmd: number, payload: number[]): Uint8Array {
	return Uint8Array.from([0xff, 0x04, ...be16(payload.length), 0x00, 0x1d, 0x0a, cmd, ...payload]);
}

const gain = (g: number) => be16(field(g, 60, I16, 'gain') & 0xffff);

/** The bands of an EQ payload (after the 8-byte frame header). */
export function decodeEdgeBands(payload: ArrayLike<number>): Filter[] {
	if (payload.length < 38) throw new BridgeError('bad-response', 'Moondrop Edge: short EQ payload');
	return Array.from({ length: BANDS }, (_, i) => {
		const o = 2 + i * 7;
		return {
			type: 'PK' as const,
			freq: readU16be(payload, o + 2),
			q: readU16be(payload, o + 4) / 4096,
			gain: readI16be(payload, i < BANDS - 1 ? o + 7 : 36) / 60
		};
	});
}

export const edgeCodec: Codec<object, Uint8Array> = {
	types: TYPES.types,
	wire: () => ({ freq: grid(1, U16), q: grid(4096, U16), gain: grid(60, I16) }),
	encode(request) {
		refuseUncarried('moondrop-edge-serial', request, {});
		const { filters } = request;
		if (filters.length !== BANDS) {
			throw new BridgeError(
				'invalid-request',
				`Moondrop Edge: the write carries exactly ${BANDS} bands`
			);
		}
		const payload = [0x00, 0x04];
		filters.forEach((f, i) => {
			TYPES.encode(f.type);
			payload.push(...(i === 0 ? [0, 0] : gain(filters[i - 1]!.gain)));
			payload.push(...be16(field(f.freq, 1, U16, 'freq')), ...be16(field(f.q, 4096, U16, 'q')));
			if (i < BANDS - 1) payload.push(0x00);
		});
		payload.push(...gain(filters[BANDS - 1]!.gain), 0x00);
		return [edgeFrame(SET_EQ, payload)];
	},
	decode(frames): WriteState {
		const frame = frames.find((f) => f[7] === SET_EQ);
		return { filters: frame ? decodeEdgeBands(frame.subarray(8)) : [] };
	}
};

function frameAt(buf: readonly number[]): [number, number] | null {
	const start = buf.findIndex(
		(b, i) => b === 0xff && buf[i + 6] === 0x0b && buf[i + 7] === QUERY_EQ
	);
	if (start < 0) return null;
	const end = start + 8 + readU16be(buf, start + 2);
	return buf.length >= end ? [start, end] : null;
}

export const moondropEdgeSerial: StreamHandler = {
	id: 'moondrop-edge-serial',
	transport: 'serial',
	codec: edgeCodec,
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
		canEnable: true
	}),

	async pull(ctx) {
		const reader = new StreamReader(ctx.transport);
		await reader.send(edgeFrame(QUERY_EQ, [0x00, 0x04]));
		const frame = await reader.readFrame(frameAt, 5000, 'Moondrop Edge EQ read');
		return { filters: decodeEdgeBands(frame.subarray(8)) };
	},

	async push(ctx, request) {
		for (const frame of edgeCodec.encode(request, {})) await ctx.transport.write(frame);
		return { reconnect: false };
	},

	async setEnabled(ctx, enabled) {
		await ctx.transport.write(edgeFrame(ENABLE_EQ, [enabled ? 1 : 0]));
	}
};
