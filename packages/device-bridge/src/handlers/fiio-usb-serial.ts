// FiiO DSP dongle over USB serial: FiiO's HID frames as a byte stream, one answer per command
// (devicePEQ fiioUsbSerialHandler.js, 0BSD, at 0617f38). Band layout as in fiio-usb-hid.ts; no
// band count command on writes.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { be16, field, I16, readI16be, U8 } from '../bytes.ts';
import { isBridgeError } from '../errors.ts';
import type { Codec, HandlerContext, StreamHandler, WriteState } from '../handler.ts';
import { StreamReader } from '../io.ts';
import type { StreamTransport } from '../transport.ts';
import { decodeFiioBand, encodeFiioBand, FIIO_TYPES, FIIO_WIRE } from './fiio-usb-hid.ts';

export interface FiioUsbSerialOptions {
	/** Command that saves to a preset. Default 0x19. */
	saveCommand?: number;
}

const BAND = 0x15;
const PRESET = 0x16;
const PREAMP = 0x17;
const COUNT = 0x18;
const SAVE = 0x19;
const EQ_SWITCH = 0x1a;
const END = 0xee;

export function fiioSerialFrame(get: boolean, cmd: number, data: number[] = []): Uint8Array {
	const head = get ? [0xbb, 0x0b] : [0xaa, 0x0a];
	return Uint8Array.from([...head, 0, 0, cmd, data.length, ...data, 0, END]);
}

export const fiioUsbSerialCodec: Codec<FiioUsbSerialOptions, Uint8Array> = {
	types: FIIO_TYPES.types,
	wire: () => FIIO_WIRE,
	encode({ filters, preamp, slot }, o) {
		const frames: Uint8Array[] = [];
		if (preamp !== undefined) {
			frames.push(fiioSerialFrame(false, PREAMP, be16(field(preamp, 10, I16, 'preamp') & 0xffff)));
		}
		filters.forEach((f, i) => frames.push(fiioSerialFrame(false, BAND, [i, ...encodeFiioBand(f)])));
		if (slot !== undefined) {
			frames.push(fiioSerialFrame(false, o.saveCommand ?? SAVE, [field(slot, 1, U8, 'slot')]));
		}
		return frames;
	},
	decode(frames, o) {
		const state: WriteState = { filters: [] };
		for (const d of frames) {
			if (d[4] === BAND) state.filters[d[6]!] = decodeFiioBand(d, 7);
			else if (d[4] === PREAMP) state.preamp = readI16be(d, 6) / 10;
			else if (d[4] === (o.saveCommand ?? SAVE)) state.slot = d[6]!;
		}
		return state;
	}
};

type Ctx = HandlerContext<StreamTransport, FiioUsbSerialOptions>;

/** [AA 0A | BB 0B, 0, 0, cmd, len, data…, 0, EE]; bytes before the header are skipped. */
function frameAt(buf: readonly number[]): [number, number] | null {
	const start = buf.findIndex(
		(b, i) => (b === 0xaa && buf[i + 1] === 0x0a) || (b === 0xbb && buf[i + 1] === 0x0b)
	);
	if (start < 0 || buf.length < start + 6) return null;
	const end = start + 6 + buf[start + 5]! + 2;
	return buf.length >= end && buf[end - 1] === END ? [start, end] : null;
}

/** Sends `frame` and returns the answer to its command (and band, for a band read). */
async function command(ctx: Ctx, reader: StreamReader, frame: Uint8Array, timeoutMs = 5000) {
	const cmd = frame[4]!;
	const what = `FiiO command 0x${cmd.toString(16)}`;
	const bandRead = frame[0] === 0xbb && cmd === BAND;
	const deadline = Date.now() + timeoutMs;
	await reader.send(frame);
	for (;;) {
		const answer = await reader.readFrame(frameAt, deadline - Date.now(), what);
		if (answer[4] === cmd && (!bandRead || answer[6] === frame[6])) return answer;
		ctx.log(`FiiO serial: skipped an answer to command 0x${answer[4]!.toString(16)}`);
	}
}

/** Writes are acknowledged, but a missing answer doesn't mean the write failed. */
async function write(ctx: Ctx, reader: StreamReader, frame: Uint8Array) {
	try {
		await command(ctx, reader, frame, 2000);
	} catch (error) {
		if (!isBridgeError(error, 'timeout')) throw error;
		ctx.log(`FiiO serial: no answer to command 0x${frame[4]!.toString(16)}`);
	}
}

export const fiioUsbSerial: StreamHandler<FiioUsbSerialOptions> = {
	id: 'fiio-usb-serial',
	transport: 'serial',
	codec: fiioUsbSerialCodec,

	capabilities: () => ({
		canRead: true,
		canWrite: true,
		readsPreamp: true,
		readsSlot: false,
		writesPreamp: true,
		writesSlot: true,
		needsBandCount: false,
		readsCurrentSlot: true,
		canEnable: true
	}),

	async pull(ctx) {
		const reader = new StreamReader(ctx.transport);
		const count = (await command(ctx, reader, fiioSerialFrame(true, COUNT)))[6] ?? 0;
		const preamp = readI16be(await command(ctx, reader, fiioSerialFrame(true, PREAMP)), 6) / 10;
		const filters: (Filter | null)[] = [];
		for (let i = 0; i < count; i++) {
			filters.push(decodeFiioBand(await command(ctx, reader, fiioSerialFrame(true, BAND, [i])), 7));
		}
		return { filters, preamp };
	},

	async push(ctx, request) {
		const reader = new StreamReader(ctx.transport);
		for (const frame of fiioUsbSerialCodec.encode(request, ctx.options))
			await write(ctx, reader, frame);
		return { reconnect: false };
	},

	async currentSlot(ctx) {
		const answer = await command(
			ctx,
			new StreamReader(ctx.transport),
			fiioSerialFrame(true, PRESET)
		);
		return answer[6] ?? null;
	},

	async setEnabled(ctx, enabled, slot) {
		const reader = new StreamReader(ctx.transport);
		await write(ctx, reader, fiioSerialFrame(false, EQ_SWITCH, [enabled ? 1 : 0]));
		if (enabled && slot !== undefined) {
			await write(ctx, reader, fiioSerialFrame(false, PRESET, [field(slot, 1, U8, 'slot')]));
		}
	}
};
