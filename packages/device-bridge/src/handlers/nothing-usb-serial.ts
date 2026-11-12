// Nothing Headphone (1) over Bluetooth SPP (devicePEQ nothingUsbSerialHandler.js, 0BSD, at
// 0617f38).
//
// Frame: 55 60 01 <cmd u16 LE> <payload length u16 LE> <operation id> <payload…> <CRC-16/MODBUS
// LE>. Only the Custom preset (slot 5) has bands to read and write. Its payload: preset index,
// band count, total gain f32, then per band type, gain f32, freq f32, q f32 (all LE).

import type { Filter } from '@potatosalad775/eqcaps-core';
import { f32le, F32_FIELD, field, le16, readF32le, readU16le, tidyF32, U8 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type { Codec, HandlerContext, StreamHandler, WriteState } from '../handler.ts';
import { StreamReader, typeCodes } from '../io.ts';
import type { StreamTransport } from '../transport.ts';

export interface NothingOptions {
	/** The preset whose bands can be read and written. Default 5 ("Custom"). */
	customSlot?: number;
	/** Operation id of the frame (the session counts them). Default 1. */
	operation?: number;
}

const READ_EQ_MODE = 49183;
const READ_EQ_VALUES = 49229;
const SET_CUSTOM_EQ = 61520;
const EQ_MODE = 16415;
const EQ_VALUES = 16461;
const NOTHING_SPP = 'aeac4a03-dff5-498f-843a-34487cf133eb';

export const NOTHING_TYPES = typeCodes('nothing', { LSC: 0, PK: 1, HSC: 2 });

export function crc16Modbus(bytes: ArrayLike<number>, start = 0, end = bytes.length): number {
	let crc = 0xffff;
	for (let i = start; i < end; i++) {
		crc ^= bytes[i]!;
		for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
	}
	return crc;
}

export function nothingFrame(command: number, payload: number[], operation = 1): Uint8Array {
	const frame = [
		0x55,
		0x60,
		0x01,
		...le16(command),
		...le16(payload.length),
		operation & 0xff,
		...payload
	];
	return Uint8Array.from([...frame, ...le16(crc16Modbus(frame))]);
}

/** The bands of an EQ values answer, or of a write's payload (same layout from byte 8). */
export function decodeNothingBands(frame: ArrayLike<number>): {
	filters: Filter[];
	preamp: number;
} {
	const count = frame[9] ?? 0;
	const filters: Filter[] = [];
	for (let i = 0, o = 14; i < count && o + 13 <= frame.length; i++, o += 13) {
		filters.push({
			type: NOTHING_TYPES.decode(frame[o]!),
			gain: tidyF32(readF32le(frame, o + 1)),
			freq: tidyF32(readF32le(frame, o + 5)),
			q: tidyF32(readF32le(frame, o + 9))
		});
	}
	return { filters, preamp: tidyF32(readF32le(frame, 10)) };
}

export const nothingCodec: Codec<NothingOptions, Uint8Array> = {
	types: NOTHING_TYPES.types,
	wire: () => ({ freq: F32_FIELD, q: F32_FIELD, gain: F32_FIELD, preamp: F32_FIELD }),
	encode({ filters, preamp, slot }, o) {
		const custom = o.customSlot ?? 5;
		if (slot !== undefined && slot !== custom) {
			throw new BridgeError(
				'invalid-request',
				`Nothing: only the Custom preset (${custom}) is writable`
			);
		}
		// The total gain travels with the bands: a push without a preamp writes 0 dB.
		const payload = [
			0,
			field(filters.length, 1, U8, 'band count'),
			...f32le(preamp ?? 0, 'preamp'),
			...filters.flatMap((f) => [
				NOTHING_TYPES.encode(f.type),
				...f32le(f.gain, 'gain'),
				...f32le(f.freq, 'freq'),
				...f32le(f.q, 'q')
			])
		];
		return [nothingFrame(SET_CUSTOM_EQ, payload, o.operation)];
	},
	decode(frames): WriteState {
		const frame = frames.find((f) => readU16le(f, 3) === SET_CUSTOM_EQ);
		return frame ? decodeNothingBands(frame) : { filters: [] };
	}
};

type Ctx = HandlerContext<StreamTransport, NothingOptions>;

const operations = new WeakMap<StreamTransport, number>();
const nextOperation = (t: StreamTransport) => {
	const op = ((operations.get(t) ?? 0) % 255) + 1;
	operations.set(t, op);
	return op;
};

/** A complete frame at the start of the buffer (bytes before the 0x55 are skipped). */
function frameAt(buf: readonly number[]): [number, number] | null {
	const start = buf.indexOf(0x55);
	if (start < 0 || buf.length < start + 8) return null;
	const end = start + 8 + readU16le(buf, start + 5) + 2;
	return buf.length >= end ? [start, end] : null;
}

async function exchange(ctx: Ctx, reader: StreamReader, frame: Uint8Array, answer?: number) {
	await reader.send(frame);
	const got = await reader.readFrame(frameAt, 5000, `Nothing command ${readU16le(frame, 3)}`);
	if (answer !== undefined && readU16le(got, 3) !== answer) {
		throw new BridgeError(
			'bad-response',
			`Nothing: expected answer ${answer}, got ${readU16le(got, 3)}`
		);
	}
	return got;
}

const readMode = async (ctx: Ctx, reader: StreamReader) =>
	(
		await exchange(
			ctx,
			reader,
			nothingFrame(READ_EQ_MODE, [], nextOperation(ctx.transport)),
			EQ_MODE
		)
	)[8]!;

export const nothingUsbSerial: StreamHandler<NothingOptions> = {
	id: 'nothing-usb-serial',
	transport: 'serial',
	codec: nothingCodec,
	sppServiceClass: NOTHING_SPP,

	capabilities: () => ({
		canRead: true,
		canWrite: true,
		readsPreamp: true,
		readsSlot: false,
		writesPreamp: true,
		writesSlot: true,
		needsBandCount: false,
		readsCurrentSlot: true,
		canEnable: false
	}),

	async pull(ctx) {
		const reader = new StreamReader(ctx.transport);
		const custom = ctx.options.customSlot ?? 5;
		const mode = await readMode(ctx, reader);
		if (mode !== custom) {
			throw new BridgeError(
				'unsupported',
				`Nothing: preset ${mode} is active; only the Custom preset (${custom}) exposes its bands`
			);
		}
		const answer = await exchange(
			ctx,
			reader,
			nothingFrame(READ_EQ_VALUES, [0], nextOperation(ctx.transport)),
			EQ_VALUES
		);
		return { ...decodeNothingBands(answer), slot: custom };
	},

	async push(ctx, request) {
		const [frame] = nothingCodec.encode(request, {
			...ctx.options,
			operation: nextOperation(ctx.transport)
		});
		// Any answer confirms the write; its command id isn't documented.
		await exchange(ctx, new StreamReader(ctx.transport), frame!);
		return { reconnect: false };
	},

	async currentSlot(ctx) {
		return readMode(ctx, new StreamReader(ctx.transport));
	}
};
