// Qudelix 5K over USB HID, write-only: the device declares input reports but never sends them
// over USB (devicePEQ qudelixUsbHidHandler.js, 0BSD, at 0617f38).
//
// Frame: [payload length + 1, 0x80, cmd hi, cmd lo, data…], padded to the report size, on report 8
// (7 on older firmware) of the vendor collection (usage page 0xFF00). Band (0x070F): [group 0,
// channels 3, band, type, freq u16 BE, gain s16 BE ×10, q s16 BE ×1024]. Preamp (0x0703):
// [0, 3, 0, gain s16 BE ×10].

import { be16, field, grid, I16, readI16be, readU16be, U16, U8 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type { Codec, HandlerContext, HidFrame, HidHandler, WriteState } from '../handler.ts';
import { hidFrame, sendFrame, typeCodes } from '../io.ts';
import type { HidTransport } from '../transport.ts';

/** Derived from the transport's descriptor; tests and offline use pass them directly. */
export interface QudelixOptions {
	reportId?: number;
	reportSize?: number;
}

const ENABLE = 0x0700;
const TYPE = 0x0701;
const PRE_GAIN = 0x0703;
const SAVE = 0x0708;
const LOAD = 0x0709;
const BAND = 0x070f;
const USER = 0;
const BOTH = 0x03;

export const QUDELIX_TYPES = typeCodes('qudelix', { LPQ: 1, HPQ: 2, LSC: 3, HSC: 4, PK: 5 });

/** The PEQ output report of the vendor collection; null on the audio interface. */
export function qudelixReport(
	transport: HidTransport
): { reportId: number; reportSize: number } | null {
	const reports = (cs: HidTransport['collections']): { id: number; size: number }[] =>
		cs.flatMap((c) => [
			...(c.usagePage === 0xff00
				? c.outputReports.map((r) => ({ id: r.reportId, size: r.size ?? 0 }))
				: []),
			...reports(c.children)
		]);
	const all = reports(transport.collections);
	const pick = all.find((r) => r.id === 8 && r.size) ?? all.find((r) => r.id === 7 && r.size);
	if (pick) return { reportId: pick.id, reportSize: pick.size };
	return transport.collections.some((c) => c.usagePage === 0xff00)
		? { reportId: 8, reportSize: 64 }
		: null;
}

function frame(o: QudelixOptions, cmd: number, data: number[]) {
	const bytes = new Uint8Array(o.reportSize ?? 64);
	bytes.set([data.length + 3, 0x80, ...be16(cmd), ...data]);
	return hidFrame(o.reportId ?? 8, bytes);
}

const int16 = (v: number, scale: number, what: string) => be16(field(v, scale, I16, what) & 0xffff);

export const qudelixCodec: Codec<QudelixOptions, HidFrame> = {
	types: QUDELIX_TYPES.types,
	wire: () => ({
		freq: grid(1, U16),
		q: { ...grid(1024, I16), min: 1 / 1024 },
		gain: grid(10, I16),
		preamp: grid(10, I16)
	}),
	encode({ filters, preamp, slot }, o) {
		const frames = [frame(o, ENABLE, [USER, 1]), frame(o, TYPE, [USER, 1])]; // 1 = parametric
		if (preamp !== undefined)
			frames.push(frame(o, PRE_GAIN, [USER, BOTH, 0, ...int16(preamp, 10, 'preamp')]));
		filters.forEach((f, i) =>
			frames.push(
				frame(o, BAND, [
					USER,
					BOTH,
					field(i, 1, U8, 'band index'),
					QUDELIX_TYPES.encode(f.type),
					...be16(field(f.freq, 1, U16, 'freq')),
					...int16(f.gain, 10, 'gain'),
					...int16(f.q, 1024, 'q')
				])
			)
		);
		if (slot !== undefined) frames.push(frame(o, SAVE, [field(slot, 1, U8, 'slot')]));
		return frames;
	},
	decode(frames) {
		const state: WriteState = { filters: [] };
		for (const { data: d } of frames) {
			const cmd = readU16be(d, 2);
			if (cmd === BAND) {
				state.filters[d[6]!] = {
					type: QUDELIX_TYPES.decode(d[7]!),
					freq: readU16be(d, 8),
					gain: readI16be(d, 10) / 10,
					q: readI16be(d, 12) / 1024
				};
			} else if (cmd === PRE_GAIN) state.preamp = readI16be(d, 7) / 10;
			else if (cmd === SAVE) state.slot = d[4]!;
		}
		return state;
	}
};

function options(ctx: HandlerContext<HidTransport, QudelixOptions>): QudelixOptions {
	const report = qudelixReport(ctx.transport);
	if (!report) {
		throw new BridgeError(
			'transport',
			'Qudelix: this is the audio interface; connect the PEQ control interface (usage page 0xFF00)'
		);
	}
	return { ...report, ...ctx.options };
}

export const qudelixUsbHid: HidHandler<QudelixOptions> = {
	id: 'qudelix-usb-hid',
	transport: 'hid',
	codec: qudelixCodec,

	capabilities: () => ({
		canRead: false,
		canWrite: true,
		readsPreamp: false,
		readsSlot: false,
		writesPreamp: true,
		writesSlot: true,
		needsBandCount: false,
		readsCurrentSlot: false,
		canEnable: true
	}),

	async pull() {
		throw new BridgeError('unsupported', 'Qudelix: the USB interface sends no input reports');
	},

	async push(ctx, request) {
		for (const f of qudelixCodec.encode(request, options(ctx))) {
			await sendFrame(ctx.transport, f);
			await ctx.sleep(15);
		}
		return { reconnect: false };
	},

	async setEnabled(ctx, enabled, slot) {
		const o = options(ctx);
		await sendFrame(ctx.transport, frame(o, ENABLE, [USER, enabled ? 1 : 0]));
		if (enabled && slot !== undefined) {
			await sendFrame(ctx.transport, frame(o, LOAD, [field(slot, 1, U8, 'slot')]));
		}
	}
};
