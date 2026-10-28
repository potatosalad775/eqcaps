// Walkplay-chipset USB DACs and dongles, every scheme group (devicePEQ walkplayHidHandler.js,
// 0BSD, at 0617f38).
//
// Report 0x4B; requests [0x80 read | 0x01 write, <cmd>, …]. A band write (cmd 0x09) carries the
// band twice: as Q2.30 biquad coefficients at 96 kHz (bytes 7–26), and as metadata from byte 27:
// freq u16 LE, q u16 LE ×256, gain s16 LE ×256, type, 0, slot. Reads answer in the same layout.
// Both forms carry the frequency as given, in Hz. Some firmware is reported to place a band off
// that frequency (SchemeNo11 about 2.25% low); the codec doesn't correct for it (D39).
// Preamp: cmd 0x03, s8 dB. A write ends with a commit: [1,5,0], [1,0x17,0], [1,0x0A,4,0,0,FF,FF,0],
// [1,1,1,0] (persist, PEQ on). A push then reads its bands back and sends a lost one again.
//
// Firmware (0x0C) and the device controls come from NICEHCK's web app (app.nicehck.cn), which
// drives its Walkplay devices with the same requests: the version is ASCII from byte 3; a control
// is one byte at byte 3 of its answer, except the mic gain (0x02) and the per-channel gain (0x16,
// channel at byte 3), which are written as s16 LE ×256 dB. The device only overwrites the bytes
// it fills in an answer: a 0x16 answer carries the whole dB at byte 5 and leaves byte 4 as it was
// (PureAural, test/recordings/2026-10-28-nicehck-pureaural.json).

import type { Filter } from '@potatosalad775/eqcaps-core';
import { biquadQ30, coefficientBytes } from '../biquad.ts';
import { field, grid, I16, I8, le16, readI16le, readI8, readU16le, U8 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type {
	Codec,
	HandlerContext,
	HandlerControl,
	HidFrame,
	HidHandler,
	WriteState
} from '../handler.ts';
import { hidFrame, hidRequest, sendFrame, typeCodes, waitForInput } from '../io.ts';
import type { HidTransport } from '../transport.ts';

export interface WalkplayHidOptions {
	/** Slot byte of a write that names no slot. Default 101 ("Custom"). */
	defaultSlot?: number;
	/**
	 * Whether [1,1,0,…] turns the EQ off (`setEnabled`). Default true; false where it doesn't:
	 * the NICEHCK PureAural keeps its EQ, and NICEHCK's app calls the frame "save to flash".
	 */
	enableCommand?: boolean;
}

const REPORT_ID = 0x4b;
const READ = 0x80;
const WRITE = 0x01;
const BAND = 0x09;
const PREAMP = 0x03;
const MIC_GAIN = 0x02;
const DAC_DONE = 0x04;
const FIRMWARE = 0x0c;
const CHANNEL_GAIN = 0x16;
const COMMIT = [
	[WRITE, 0x05, 0x00],
	[WRITE, 0x17, 0x00],
	[WRITE, 0x0a, 0x04, 0x00, 0x00, 0xff, 0xff, 0x00],
	[WRITE, 0x01, 0x01, 0x00]
];

export const WALKPLAY_TYPES = typeCodes('walkplay', { PK: 2, LSC: 1, HSC: 3, LPQ: 4, HPQ: 5 });

/** The band of a read answer or write frame; null for an unset band. */
export function decodeWalkplayBand(d: ArrayLike<number>): Filter | null {
	const freq = readU16le(d, 27);
	const q = readU16le(d, 29);
	if (freq === 0 || freq === 0xffff || q === 0) return null;
	return {
		type: WALKPLAY_TYPES.decode(d[33] ?? 0),
		freq,
		q: q / 256,
		gain: readI16le(d, 31) / 256
	};
}

/** 0 and 0xFFFF in freq, and 0 in q, read back as an unset band. */
const FREQ = [1, 0xfffe] as const;
const Q = [1, 0xffff] as const;

/** The band write (cmd 0x09) of `filter` to band `index`, tagged with preset `slot`. */
export function encodeWalkplayBand(index: number, filter: Filter, slot: number): number[] {
	const freq = field(filter.freq, 1, FREQ, 'freq');
	const type = WALKPLAY_TYPES.encode(filter.type);
	const coeffs = biquadQ30(filter.type, freq, filter.gain, filter.q, 96000);
	return [
		WRITE,
		BAND,
		0x18,
		0x00,
		field(index, 1, U8, 'band index'),
		0x00,
		0x00,
		...coefficientBytes(coeffs),
		...le16(freq),
		...le16(field(filter.q, 256, Q, 'q')),
		...le16(field(filter.gain, 256, I16, 'gain') & 0xffff),
		type,
		0x00,
		field(slot, 1, U8, 'slot'),
		0x00
	];
}

/** "1.6" from the 0x0C answer: the digits and dots of the ASCII from byte 3, up to a 0 byte. */
export function decodeWalkplayFirmware(d: ArrayLike<number>): string | null {
	if (d.length < 4 || d[0] !== READ || d[1] !== FIRMWARE) return null;
	// The device leaves the rest of its answer buffer as it was, so the version ends at the first
	// byte that isn't printable ASCII. Byte 2 is left over too, not a length.
	let version = '';
	for (let i = 3; i < d.length && d[i]! >= 0x20 && d[i]! < 0x7f; i++) {
		const c = String.fromCharCode(d[i]!);
		if (/[0-9.]/.test(c)) version += c;
	}
	return version || null;
}

export const walkplayHidCodec: Codec<WalkplayHidOptions, HidFrame> = {
	types: WALKPLAY_TYPES.types,
	wire: () => ({
		freq: grid(1, FREQ),
		q: grid(256, Q),
		gain: grid(256, I16),
		preamp: grid(1, I8)
	}),
	encode({ filters, preamp, slot }, o) {
		const slotByte = field(slot ?? o.defaultSlot ?? 101, 1, U8, 'slot');
		const frames = filters.map((f, i) => encodeWalkplayBand(i, f, slotByte));
		if (preamp !== undefined) {
			frames.push([WRITE, PREAMP, 0x02, 0x00, field(preamp, 1, I8, 'preamp') & 0xff]);
		}
		return [...frames, ...COMMIT].map((d) => hidFrame(REPORT_ID, d));
	},
	decode(frames) {
		const state: WriteState = { filters: [] };
		for (const { data: d } of frames) {
			if (d[0] !== WRITE) continue;
			if (d[1] === BAND) {
				state.filters[d[4]!] = decodeWalkplayBand(d);
				state.slot = d[35]!;
			} else if (d[1] === PREAMP) state.preamp = readI8(d, 4);
		}
		return state;
	}
};

type Ctx = HandlerContext<HidTransport, WalkplayHidOptions>;

const send = (ctx: Ctx, bytes: number[]) =>
	ctx.transport.sendReport(REPORT_ID, Uint8Array.from(bytes));

/** Sends the read [0x80, cmd, …rest] and returns the answer that repeats [0x80, cmd]. */
const ask = (ctx: Ctx, cmd: number, rest: number[] = [], also = (_d: Uint8Array) => true) =>
	hidRequest(
		ctx.transport,
		REPORT_ID,
		[READ, cmd, ...rest],
		(d) => d[0] === READ && d[1] === cmd && also(d),
		1000,
		`Walkplay 0x${cmd.toString(16)}`
	);

/**
 * Each control's command, and how its value is carried: one byte, or s16 LE ×256 dB (`db`).
 * `channel` addresses one channel of 0x16; NICEHCK's app sends a mic gain write with 0x04 after it.
 */
export const WALKPLAY_CONTROL_COMMANDS: Readonly<
	Record<string, { cmd: number; db?: true; channel?: number; then?: number }>
> = {
	dacFilter: { cmd: 0x11 },
	gainLevel: { cmd: 0x19 },
	workMode: { cmd: 0x1d },
	volume: { cmd: 0x85 },
	micGain: { cmd: MIC_GAIN, db: true, then: DAC_DONE },
	leftGain: { cmd: CHANNEL_GAIN, db: true, channel: 0 },
	rightGain: { cmd: CHANNEL_GAIN, db: true, channel: 1 }
};

/** The write frame for a control (report id stripped): [0x01, cmd, length, (channel), value]. */
export function encodeWalkplayControl(id: string, value: number): number[] {
	const c = WALKPLAY_CONTROL_COMMANDS[id];
	if (!c) throw new BridgeError('invalid-request', `Walkplay: no control ${id}`);
	const lead = c.channel === undefined ? [] : [c.channel];
	const data = c.db
		? le16(field(value, 256, I16, id) & 0xffff)
		: [field(value, 1, U8, 'control value')];
	// 0x16 always says 4, as in its read; the others say how many bytes follow.
	const length = c.channel === undefined ? data.length : 4;
	return [WRITE, c.cmd, length, ...lead, ...data];
}

function control(id: string): HandlerControl<HidTransport, WalkplayHidOptions> {
	const c = WALKPLAY_CONTROL_COMMANDS[id]!;
	const channel = c.channel;
	// The value follows the channel byte (3) where there is one.
	const at = channel === undefined ? 3 : 4;
	return {
		async read(ctx) {
			const d =
				channel === undefined
					? await ask(ctx, c.cmd)
					: await ask(ctx, c.cmd, [4, channel], (a) => a[3] === channel);
			if (d.length < at + (c.db ? 2 : 1)) {
				throw new BridgeError('bad-response', `Walkplay: short answer to ${id}`);
			}
			// A 0x16 answer sets only the whole dB (byte 5); byte 4 is left from an earlier answer.
			if (channel !== undefined) return readI8(d, at + 1);
			return c.db ? readI16le(d, at) / 256 : d[at]!;
		},
		async write(ctx, value) {
			await send(ctx, encodeWalkplayControl(id, value));
			if (c.then !== undefined) {
				await ctx.sleep(20);
				await send(ctx, [WRITE, c.then]);
			}
			await ctx.sleep(30);
		}
	};
}

/** Band `index` as the device reads it back; undefined if it doesn't answer. */
async function readBand(ctx: HandlerContext<HidTransport, WalkplayHidOptions>, index: number) {
	try {
		const answer = await hidRequest(
			ctx.transport,
			REPORT_ID,
			[READ, BAND, 0x00, 0x00, index, 0x00],
			(d) => d[1] === BAND && d[4] === index && d.length >= 34,
			300,
			`Walkplay band ${index}`
		);
		return decodeWalkplayBand(answer);
	} catch (error) {
		ctx.log(`Walkplay: band ${index} not read back (${String(error)})`);
		return undefined;
	}
}

const sameBand = (a: Filter | null, b: Filter | null) =>
	a === b ||
	(a !== null &&
		b !== null &&
		a.type === b.type &&
		a.freq === b.freq &&
		a.q === b.q &&
		a.gain === b.gain);

/**
 * The band frames the device didn't take, from reading each back. A PureAural lost the first
 * band write after it had been idle for some minutes, and once just after a replug. If a band
 * isn't read back, the rest aren't checked and count as taken: a device that doesn't answer reads
 * is written to as before.
 */
async function untaken(ctx: HandlerContext<HidTransport, WalkplayHidOptions>, frames: HidFrame[]) {
	const out: HidFrame[] = [];
	for (const frame of frames) {
		if (frame.data[1] !== BAND) continue;
		const read = await readBand(ctx, frame.data[4]!);
		if (read === undefined) break;
		if (!sameBand(read, decodeWalkplayBand(frame.data))) out.push(frame);
	}
	return out;
}

async function sendFrames(
	ctx: HandlerContext<HidTransport, WalkplayHidOptions>,
	frames: readonly HidFrame[]
) {
	for (const frame of frames) {
		await sendFrame(ctx.transport, frame);
		await ctx.sleep(frame.data[1] === BAND ? 20 : 50);
	}
}

export const walkplayHid: HidHandler<WalkplayHidOptions> = {
	id: 'walkplay-hid',
	transport: 'hid',
	codec: walkplayHidCodec,

	capabilities: (_t, o) => ({
		canRead: true,
		canWrite: true,
		readsPreamp: true,
		readsSlot: false,
		writesPreamp: true,
		writesSlot: true,
		needsBandCount: true,
		readsCurrentSlot: true,
		canEnable: o.enableCommand ?? true
	}),

	async pull(ctx, { bands = 0 }) {
		const filters: (Filter | null)[] = [];
		for (let i = 0; i < bands; i++) {
			const answer = await hidRequest(
				ctx.transport,
				REPORT_ID,
				[READ, BAND, 0x00, 0x00, i, 0x00],
				(d) => d[1] === BAND && d[4] === i && d.length >= 34,
				2000,
				`Walkplay band ${i}`
			);
			filters.push(decodeWalkplayBand(answer));
		}
		const result: { filters: (Filter | null)[]; preamp?: number } = { filters };
		try {
			const answer = await hidRequest(
				ctx.transport,
				REPORT_ID,
				[READ, PREAMP, 0x00],
				(d) => d[0] === READ && d[1] === PREAMP,
				1000,
				'Walkplay preamp'
			);
			result.preamp = readI8(answer, 4);
		} catch (error) {
			ctx.log(`Walkplay: no preamp (${String(error)})`);
		}
		return result;
	},

	async push(ctx, request) {
		const frames = walkplayHidCodec.encode(request, ctx.options);
		await sendFrames(ctx, frames);
		// A band the device lost is sent again with the commit, once.
		const commit = frames.filter((f) => f.data[1] !== BAND);
		let lost = await untaken(ctx, frames);
		if (lost.length) {
			ctx.log(`Walkplay: band(s) ${lost.map((f) => f.data[4]).join(', ')} not taken, sent again`);
			await sendFrames(ctx, [...lost, ...commit]);
			lost = await untaken(ctx, lost);
		}
		if (lost.length) {
			throw new BridgeError(
				'rejected',
				`Walkplay: band(s) ${lost.map((f) => f.data[4]).join(', ')} not taken`
			);
		}
		return { reconnect: false };
	},

	async currentSlot(ctx) {
		const answer = waitForInput(ctx.transport, (d) => d[1] === BAND, 2000, 'Walkplay slot');
		answer.catch(() => {});
		await send(ctx, [READ, BAND, 0x00]);
		// Byte 36 of the full report; the transport strips the report id.
		const slot = (await answer)[35];
		if (slot === undefined) throw new BridgeError('bad-response', 'Walkplay: short slot answer');
		return slot;
	},

	async setEnabled(ctx, enabled, slot) {
		const id = enabled ? (slot ?? ctx.options.defaultSlot ?? 101) : 0;
		await send(ctx, [WRITE, 0x01, enabled ? 1 : 0, field(id, 1, U8, 'slot'), 0x00]);
	},

	async firmware(ctx) {
		return decodeWalkplayFirmware(await ask(ctx, FIRMWARE, [0x00]));
	},

	controls: Object.fromEntries(
		Object.keys(WALKPLAY_CONTROL_COMMANDS).map((id) => [id, control(id)])
	)
};
