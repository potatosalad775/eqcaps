// Moondrop Old Fashioned: register reads and writes over HID report 75 (devicePEQ
// moondropOldFashionedUsbHidHandler.js, 0BSD, at 0617f38).
//
// 10-byte packets [register, 0, 0, 0, 'W' | 'R' | 'S', 0, data…]. Band i has two registers:
// 38 + 2i (gain s8 ×10 at byte 6, freq u16 LE at byte 8) and 39 + 2i (q s16 LE ×1000 at byte 6).
// The device answers a read with its next input report. Peaking only; no preamp, no slots.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { field, grid, I16, I8, le16, readI16le, readI8, readU16le, U16 } from '../bytes.ts';
import type { Codec, HidFrame, HidHandler, WriteState } from '../handler.ts';
import { hidFrame, hidRequest, refuseUncarried, sendFrame, typeCodes } from '../io.ts';

const REPORT_ID = 75;
const BASE = 38;
const WRITE = 0x57;
const SAVE = 0x53;
const READ = 0x52;
const DELAY = 100;

const TYPES = typeCodes('moondrop-old-fashioned', { PK: 0 });

function packet(register: number, command: number, at = 0, data: number[] = []) {
	const bytes = new Array<number>(10).fill(0);
	bytes[0] = register;
	bytes[4] = command;
	data.forEach((b, i) => (bytes[at + i] = b));
	return bytes;
}

export const oldFashionedCodec: Codec<object, HidFrame> = {
	types: TYPES.types,
	wire: () => ({ freq: grid(1, U16), q: { ...grid(1000, I16), min: 0.001 }, gain: grid(10, I8) }),
	encode(request) {
		refuseUncarried('moondrop-old-fashioned-hid', request, {});
		const { filters } = request;
		const frames = filters.flatMap((f, i) => {
			TYPES.encode(f.type);
			const reg = BASE + 2 * i;
			return [
				packet(reg, WRITE, 6, [
					field(f.gain, 10, I8, 'gain') & 0xff,
					0,
					...le16(field(f.freq, 1, U16, 'freq'))
				]),
				packet(reg + 1, WRITE, 6, le16(field(f.q, 1000, I16, 'q') & 0xffff))
			];
		});
		return [...frames, packet(0, SAVE)].map((d) => hidFrame(REPORT_ID, d));
	},
	decode(frames) {
		const state: WriteState = { filters: [] };
		for (const { data: d } of frames) {
			if (d[4] !== WRITE || d[0]! < BASE) continue;
			const band = (d[0]! - BASE) >> 1;
			const f = (state.filters[band] ??= { type: 'PK', freq: 0, q: 0, gain: 0 });
			if ((d[0]! - BASE) % 2 === 0) {
				f.gain = readI8(d, 6) / 10;
				f.freq = readU16le(d, 8);
			} else f.q = readI16le(d, 6) / 1000;
		}
		return state;
	}
};

export const moondropOldFashionedHid: HidHandler = {
	id: 'moondrop-old-fashioned-hid',
	transport: 'hid',
	codec: oldFashionedCodec,

	capabilities: () => ({
		canRead: true,
		canWrite: true,
		readsPreamp: false,
		readsSlot: false,
		writesPreamp: false,
		writesSlot: false,
		needsBandCount: true,
		readsCurrentSlot: false,
		canEnable: false
	}),

	async pull(ctx, { bands = 0 }) {
		const read = async (register: number) => {
			const answer = await hidRequest(
				ctx.transport,
				REPORT_ID,
				packet(register, READ),
				() => true,
				1000,
				`register ${register}`
			);
			await ctx.sleep(DELAY);
			return answer;
		};
		const filters: Filter[] = [];
		for (let i = 0; i < bands; i++) {
			const a = await read(BASE + 2 * i);
			const b = await read(BASE + 2 * i + 1);
			filters.push({
				type: 'PK',
				freq: readU16le(a, 8),
				q: readI16le(b, 6) / 1000,
				gain: readI8(a, 6) / 10
			});
		}
		return { filters };
	},

	async push(ctx, request) {
		for (const frame of oldFashionedCodec.encode(request, {})) {
			await sendFrame(ctx.transport, frame);
			await ctx.sleep(DELAY);
		}
		return { reconnect: false };
	}
};
