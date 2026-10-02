// Fosi Audio DS3: 63-byte commands [0x77, cmd, …] as feature reports, answers read back from the
// feature report (devicePEQ fosiAudioUsbHidHandler.js, 0BSD, at 0617f38).
//
// Band (0x8D): [0x77, 0x8D, preset, band, type, freq f32 LE, q f32 LE, bandwidth f32 LE,
// gain f32 LE]; 0x8E reads a band as a feature request and commits it as an output report. Type
// codes are the vendor app's. 0x8A selects a preset, 0x92 saves it, 0x91 opens a write. EQ on/off
// (0x9D, answered on the feature report) is separate, persistent state that writing a preset
// doesn't change, so a push also switches it on.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { f32le, F32_FIELD, field, readF32le, tidyF32, U8 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type { Codec, HandlerContext, HidFrame, HidHandler, WriteState } from '../handler.ts';
import { hidFrame, refuseUncarried, sendFrame, typeCodes } from '../io.ts';
import type { HidTransport } from '../transport.ts';

export interface FosiAudioHidOptions {
	/** Default 1. */
	reportId?: number;
	/** Written to the band's bandwidth field. Default 0. */
	bandwidth?: number;
	/** Preset of a write that names none. Default 7 ("Custom 1"). */
	defaultSlot?: number;
}

const HEADER = 0x77;
const SET_EQ_MODE = 0x8a;
const SET_EQ_PARAMS = 0x8d;
const GET_EQ_PARAMS = 0x8e;
const OPEN = 0x91;
const SAVE = 0x92;
const SET_EQ_ENABLE = 0x9d;
const GET_EQ_ENABLE = 0x9e;
const BYPASS = 0;

export const FOSI_TYPES = typeCodes('fosi-audio', {
	AP: 1,
	PK: 2,
	LPQ: 3,
	HPQ: 4,
	BP: 5,
	NO: 7,
	LSC: 9,
	HSC: 10
});

const reportId = (o: FosiAudioHidOptions) => o.reportId ?? 1;
const preset = (o: FosiAudioHidOptions, slot?: number) =>
	field(slot ?? o.defaultSlot ?? 7, 1, U8, 'slot');

function command(cmd: number, ...data: number[]) {
	const packet = new Uint8Array(63);
	packet.set([HEADER, cmd, ...data]);
	return packet;
}

/** A band in the 0x8D / 0x8E layout (report id stripped); null for a bypassed or empty band. */
export function decodeFosiBand(
	d: ArrayLike<number>
): { band: number; filter: Filter | null } | null {
	if (d.length < 21 || d[0] !== HEADER) return null;
	const typeCode = d[4]!;
	const freq = tidyF32(readF32le(d, 5));
	const q = tidyF32(readF32le(d, 9));
	const gain = tidyF32(readF32le(d, 17));
	const off = typeCode === BYPASS || (gain === 0 && freq === 0);
	return { band: d[3]!, filter: off ? null : { type: FOSI_TYPES.decode(typeCode), freq, q, gain } };
}

export const fosiAudioCodec: Codec<FosiAudioHidOptions, HidFrame> = {
	types: FOSI_TYPES.types,
	wire: () => ({ freq: F32_FIELD, q: F32_FIELD, gain: F32_FIELD }),
	encode(request, o) {
		refuseUncarried('fosi-audio-usb-hid', request, { slot: true });
		const { filters, slot } = request;
		const id = reportId(o);
		const p = preset(o, slot);
		const frames = [
			hidFrame(id, command(OPEN, 0), true),
			hidFrame(id, command(SET_EQ_MODE, p), true)
		];
		filters.forEach((f, i) => {
			const band = command(
				SET_EQ_PARAMS,
				p,
				field(i, 1, U8, 'band index'),
				FOSI_TYPES.encode(f.type)
			);
			band.set(
				[
					...f32le(f.freq, 'freq'),
					...f32le(f.q, 'q'),
					...f32le(o.bandwidth ?? 0),
					...f32le(f.gain, 'gain')
				],
				5
			);
			frames.push(hidFrame(id, band, true), hidFrame(id, command(GET_EQ_PARAMS, p, i)));
		});
		frames.push(hidFrame(id, command(SAVE, p), true));
		return frames;
	},
	decode(frames) {
		const state: WriteState = { filters: [] };
		for (const frame of frames) {
			if (!frame.feature || frame.data[1] !== SET_EQ_PARAMS) continue;
			const band = decodeFosiBand(frame.data);
			if (band) state.filters[band.band] = band.filter;
			state.slot = frame.data[2]!;
		}
		return state;
	}
};

type Ctx = HandlerContext<HidTransport, FosiAudioHidOptions>;

/** WebHID prepends the report id to numbered feature reports; the vendor app strips it. */
async function readFeature(ctx: Ctx) {
	const id = reportId(ctx.options);
	const d = await ctx.transport.receiveFeatureReport(id);
	return d[0] === id && d[1] === HEADER ? d.subarray(1) : d;
}

async function ack(ctx: Ctx, cmd: number) {
	const d = await readFeature(ctx);
	return d[0] === HEADER && d[1] === cmd ? d : null;
}

async function setEnabled(ctx: Ctx, enabled: boolean, slot?: number) {
	const id = reportId(ctx.options);
	await ctx.transport.sendReport(id, command(SET_EQ_ENABLE, enabled ? 1 : 0));
	const answer = await ack(ctx, SET_EQ_ENABLE);
	if (answer && answer[2] !== 0) {
		throw new BridgeError('rejected', `Fosi Audio: EQ switch rejected (status ${answer[2]})`);
	}
	await ctx.sleep(30);
	if (enabled && slot !== undefined) {
		await ctx.transport.sendFeatureReport(id, command(SET_EQ_MODE, preset(ctx.options, slot)));
		await ctx.sleep(30);
	}
	await ctx.transport.sendReport(id, command(GET_EQ_ENABLE));
	const state = await ack(ctx, GET_EQ_ENABLE);
	if (state && (state[2] === 1) !== enabled) ctx.log(`Fosi Audio: EQ switch did not take`);
}

export const fosiAudioUsbHid: HidHandler<FosiAudioHidOptions> = {
	id: 'fosi-audio-usb-hid',
	transport: 'hid',
	codec: fosiAudioCodec,

	capabilities: () => ({
		canRead: true,
		canWrite: true,
		readsPreamp: false,
		writesPreamp: false,
		writesSlot: true,
		needsBandCount: true,
		readsCurrentSlot: false,
		canEnable: true
	}),

	async pull(ctx, { slot, bands = 0 }) {
		const id = reportId(ctx.options);
		const p = preset(ctx.options, slot);
		await ctx.transport.sendFeatureReport(id, command(SET_EQ_MODE, p));
		const filters: (Filter | null)[] = [];
		for (let i = 0; i < bands; i++) {
			await ctx.transport.sendFeatureReport(id, command(GET_EQ_PARAMS, p, i));
			const band = decodeFosiBand(await readFeature(ctx));
			if (!band || band.band !== i) {
				throw new BridgeError('bad-response', `Fosi Audio: no answer for band ${i}`);
			}
			filters.push(band.filter);
			await ctx.sleep(20);
		}
		return { filters, slot: p };
	},

	async push(ctx, request) {
		for (const frame of fosiAudioCodec.encode(request, ctx.options)) {
			await sendFrame(ctx.transport, frame);
			await ctx.sleep(frame.data[1] === SET_EQ_MODE || frame.data[1] === OPEN ? 50 : 20);
		}
		await setEnabled(ctx, true, request.slot ?? ctx.options.defaultSlot ?? 7);
		return { reconnect: false };
	},

	setEnabled
};
