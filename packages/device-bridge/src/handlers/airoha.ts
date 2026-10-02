// Airoha-chipset headphones (Audeze Maxwell) over Bluetooth SPP or BLE GATT, 10 bands, 4 presets
// (devicePEQ airohaUsbSerialHandler.js and airohaBleHandler.js, 0BSD, at 0617f38).
//
// Read preset: 05 5A 06 00 00 0A <preset> EF E8 03, answered by 193 bytes starting 05 5B BD:
// band count at 5, then 18-byte records from 13: 01, type, freq u32 LE ×100, gain s32 LE ×100,
// bandwidth u32, q u32 LE ×100. The two transports write differently:
// - SPP: 05 5A 4F <length u16 LE> 03 0E 00 <preset u32 LE> 06, then six sections (one per sample
//   rate) of 00 67 00 0A 00 <rate u32 LE> and 10 records [01, type, freq, gain, q, C8 00 00 00].
//   All fields are 32-bit (devicePEQ wrote the frequency as 16 bits, which overflows above
//   655.35 Hz).
// - BLE: 05 5A BD 00 01 0A 00 EF 01 00 00 00 00, then 10 records in the read layout. This write
//   carries no preset number.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { field, grid, I32, le16, le32, readI32le, readU32le, U32 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import { SPP, type Codec, type StreamHandler, type WriteState } from '../handler.ts';
import { refuseUncarried, StreamReader, typeCodes } from '../io.ts';

export interface AirohaOptions {
	/** Write in the BLE layout. The session sets it from the transport. */
	ble?: boolean;
}

const BANDS = 10;
const ANSWER_LENGTH = 193;
const SAMPLE_RATES = [44100, 48000, 88200, 96000, 44100, 48000];
const BLE_HEADER = [0x05, 0x5a, 0xbd, 0x00, 0x01, 0x0a, 0x00, 0xef, 0x01, 0, 0, 0, 0];

export const AIROHA_TYPES = typeCodes('airoha', { PK: 2, LSC: 3, HSC: 4 });

/** Records in the read layout from byte 13 (the read answer, or a BLE write). */
export function decodeAirohaRecords(d: ArrayLike<number>, count: number): Filter[] {
	return Array.from({ length: Math.min(BANDS, count) }, (_, i) => {
		const o = 13 + i * 18;
		return {
			type: AIROHA_TYPES.decode(d[o + 1]!),
			freq: readU32le(d, o + 2) / 100,
			gain: readI32le(d, o + 6) / 100,
			q: readU32le(d, o + 14) / 100
		};
	});
}

function checkPreset(slot: number) {
	if (!Number.isInteger(slot) || slot < 0 || slot > 3) {
		throw new BridgeError('invalid-request', `Airoha: preset ${slot}, the device has 0-3`);
	}
	return slot;
}

export const airohaCodec: Codec<AirohaOptions, Uint8Array> = {
	types: AIROHA_TYPES.types,
	wire: () => ({ freq: grid(100, U32), q: grid(100, U32), gain: grid(100, I32) }),
	encode(request, o) {
		refuseUncarried('airoha', request, { slot: !o.ble });
		const { filters, slot } = request;
		if (filters.length !== BANDS) {
			throw new BridgeError('invalid-request', `Airoha: the write carries exactly ${BANDS} bands`);
		}
		const records = filters.map((f) => ({
			type: AIROHA_TYPES.encode(f.type),
			freq: le32(field(f.freq, 100, U32, 'freq')),
			gain: le32(field(f.gain, 100, I32, 'gain')),
			q: le32(field(f.q, 100, U32, 'q'))
		}));
		if (o.ble) {
			const out = [...BLE_HEADER];
			for (const r of records) out.push(0x01, r.type, ...r.freq, ...r.gain, 0, 0, 0, 0, ...r.q);
			return [Uint8Array.from(out)];
		}
		const body = [0x03, 0x0e, 0x00, ...le32(checkPreset(slot ?? 0)), 0x06];
		for (const rate of SAMPLE_RATES) {
			body.push(0x00, 0x67, 0x00, 0x0a, 0x00, ...le32(rate));
			for (const r of records) body.push(0x01, r.type, ...r.freq, ...r.gain, ...r.q, 0xc8, 0, 0, 0);
		}
		return [Uint8Array.from([0x05, 0x5a, 0x4f, ...le16(body.length + 2), ...body])];
	},
	decode(frames): WriteState {
		const d = frames[0];
		if (!d) return { filters: [] };
		if (d[2] === 0xbd) return { filters: decodeAirohaRecords(d, BANDS) };
		// SPP: the first sample-rate section's records, 18 bytes each after a 9-byte header.
		const filters = Array.from({ length: BANDS }, (_, i): Filter => {
			const o = 13 + 9 + i * 18;
			return {
				type: AIROHA_TYPES.decode(d[o + 1]!),
				freq: readU32le(d, o + 2) / 100,
				gain: readI32le(d, o + 6) / 100,
				q: readU32le(d, o + 10) / 100
			};
		});
		return { filters, slot: readU32le(d, 8) };
	}
};

function frameAt(buf: readonly number[]): [number, number] | null {
	for (let i = 0; i + 2 < buf.length; i++) {
		if (buf[i] === 0x05 && buf[i + 1] === 0x5b && buf[i + 2] === 0xbd) {
			return buf.length >= i + ANSWER_LENGTH ? [i, i + ANSWER_LENGTH] : null;
		}
	}
	return null;
}

export const airoha: StreamHandler<AirohaOptions> = {
	id: 'airoha',
	transport: ['serial', 'ble'],
	codec: airohaCodec,
	sppServiceClass: SPP,
	gatt: {
		service: '5052494d-2dab-0341-6972-6f6861424c45',
		tx: '43484152-2dab-3241-6972-6f6861424c45',
		rx: '43484152-2dab-3141-6972-6f6861424c45'
	},

	capabilities: (t, o) => ({
		canRead: true,
		canWrite: true,
		readsPreamp: false,
		writesPreamp: false,
		writesSlot: t.kind !== 'ble' && !o.ble,
		bands: BANDS,
		needsBandCount: false,
		readsCurrentSlot: false,
		canEnable: false
	}),

	async pull(ctx, { slot }) {
		const preset = checkPreset(slot ?? 0);
		const reader = new StreamReader(ctx.transport);
		await reader.send(
			Uint8Array.from([0x05, 0x5a, 0x06, 0x00, 0x00, 0x0a, preset, 0xef, 0xe8, 0x03])
		);
		const answer = await reader.readFrame(frameAt, 5000, 'Airoha preset');
		return { filters: decodeAirohaRecords(answer, answer[5] ?? 0), slot: preset };
	},

	async push(ctx, request) {
		const frames = airohaCodec.encode(request, {
			...ctx.options,
			ble: ctx.transport.kind === 'ble'
		});
		for (const frame of frames) await ctx.transport.write(frame);
		return { reconnect: false };
	}
};
