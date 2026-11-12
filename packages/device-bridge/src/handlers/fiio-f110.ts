// FiiO EH11 / EH13 "F1 10" protocol, over Bluetooth SPP or BLE GATT: the frames are the same,
// only the transport differs (devicePEQ fiioSppSerialHandler.js and fiioBleHandler.js, 0BSD, at
// 0617f38).
//
// Frame: F1 10 <total length u16 BE> <cmd hi> <cmd lo> <payload…> FF.
// Read (03 0D, payload 01 00 09): 9-byte header, then 10 bands in FiiO's 7-byte band layout.
// Write (13 0D): one frame per band, payload 01 <band> <band> <7 band bytes>, each acknowledged.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { be16, readU16be } from '../bytes.ts';
import { BridgeError, isBridgeError } from '../errors.ts';
import {
	SPP,
	type Codec,
	type HandlerContext,
	type StreamHandler,
	type WriteState
} from '../handler.ts';
import { refuseUncarried, StreamReader } from '../io.ts';
import type { StreamTransport } from '../transport.ts';
import { decodeFiioBand, encodeFiioBand, FIIO_TYPES, FIIO_WIRE } from './fiio-usb-hid.ts';

const BANDS = 10;

export function f110Frame(cmd1: number, cmd2: number, payload: number[] = []): Uint8Array {
	return Uint8Array.from([0xf1, 0x10, ...be16(7 + payload.length), cmd1, cmd2, ...payload, 0xff]);
}

export function decodeF110Bands(frame: Uint8Array): (Filter | null)[] {
	if (frame.length < 9 + BANDS * 7 || frame[4] !== 0x03 || frame[5] !== 0x0d) {
		throw new BridgeError('bad-response', `FiiO: unexpected EQ answer (${frame.length} bytes)`);
	}
	return Array.from({ length: BANDS }, (_, i) => decodeFiioBand(frame, 9 + i * 7));
}

export const fiioF110Codec: Codec<object, Uint8Array> = {
	types: FIIO_TYPES.types,
	wire: () => ({ freq: FIIO_WIRE.freq, q: FIIO_WIRE.q, gain: FIIO_WIRE.gain }),
	encode(request) {
		refuseUncarried('fiio-f110', request, {});
		const { filters } = request;
		if (filters.length > BANDS) {
			throw new BridgeError(
				'invalid-request',
				`FiiO: ${filters.length} bands, the device has ${BANDS}`
			);
		}
		return filters.map((f, i) => f110Frame(0x13, 0x0d, [0x01, i, i, ...encodeFiioBand(f)]));
	},
	decode(frames) {
		const state: WriteState = { filters: [] };
		for (const d of frames)
			if (d[4] === 0x13 && d[5] === 0x0d) state.filters[d[7]!] = decodeFiioBand(d, 9);
		return state;
	}
};

type Ctx = HandlerContext<StreamTransport, object>;

function frameAt(buf: readonly number[]): [number, number] | null {
	const start = buf.findIndex((b, i) => b === 0xf1 && buf[i + 1] === 0x10);
	if (start < 0 || buf.length < start + 4) return null;
	const end = start + readU16be(buf, start + 2);
	return buf.length >= end ? [start, end] : null;
}

async function request(ctx: Ctx, reader: StreamReader, frame: Uint8Array, timeoutMs: number) {
	await reader.send(frame);
	return reader.readFrame(frameAt, timeoutMs, `FiiO ${frame[4]}/${frame[5]}`);
}

/** Missing acknowledgements are logged, not fatal: the device may still have taken the write. */
async function tolerant(ctx: Ctx, what: string, op: () => Promise<unknown>) {
	try {
		await op();
	} catch (error) {
		if (!isBridgeError(error, 'timeout')) throw error;
		ctx.log(`FiiO: no answer to ${what}`);
	}
}

export const fiioF110: StreamHandler = {
	id: 'fiio-f110',
	transport: ['serial', 'ble'],
	codec: fiioF110Codec,
	sppServiceClass: SPP,
	gatt: {
		service: '00001100-04a5-1000-1000-40ed981a04a5',
		tx: '00001101-04a5-1000-1000-40ed981a04a5',
		rx: '00001102-04a5-1000-1000-40ed981a04a5'
	},

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
		await tolerant(ctx, 'the version handshake', () =>
			request(ctx, reader, f110Frame(0x00, 0x02, [0x01]), 2000)
		);
		const answer = await request(ctx, reader, f110Frame(0x03, 0x0d, [0x01, 0x00, 0x09]), 6000);
		return { filters: decodeF110Bands(answer) };
	},

	async push(ctx, request_) {
		const reader = new StreamReader(ctx.transport);
		for (const frame of fiioF110Codec.encode(request_, {})) {
			await tolerant(ctx, `band ${frame[7]}`, () => request(ctx, reader, frame, 2000));
			await ctx.sleep(50);
		}
		return { reconnect: false };
	}
};
