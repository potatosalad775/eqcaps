// What the two Qudelix handlers share, as Qudelix's app for Chrome (version 4.0.3.1) drives the
// devices over USB HID: the framing, the session that opens a device, the models and their EQ
// groups, the stored-preset layouts and the filter codes. The 5K and T71 speak the first protocol
// (`qudelix-usb-hid`), the 5K Plus the second (`qudelix-v2-usb-hid`). A device says which, and
// which model it is, in its answer to the opening request; the USB ids only pick the framing.
//
// Framing, by USB vendor id, on the vendor collection (usage page 0xFF00). A packet is
// [command u16 BE, data…] and n its length:
//   0x0a12: out on report 8, or 7 when the descriptor has no report 8: [n + 1, 0x80, packet…];
//           in on reports 2 and 9: [n, packet…].
//   0x1fc9: out on report 2: [0x00, n u16 BE, packet…]; in on report 1: [x, n u16 BE, packet…].
// Out reports are zero-padded to their size in the descriptor, and a packet that doesn't fit isn't
// sent. No checksums, no sequence numbers, no waits between packets.
//
// Session: input is dropped until 20 ms pass without any; then the opening request 0x0100
// [0x20, 0x00, 0x04], answered within 5 s by 0x0101 [device id u16 BE, 3 = ready, firmware, …]
// on the first protocol (other states are waited past) or 0x9000 on the second (elements 1, the
// device id, and 2, the protocol version [major, minor, revision, packet size]). Device ids: 1 the
// 5K, 2 the 5K Plus, 0x100 the T71.
//
// Second protocol: a packet is [command u16 BE, header, slice of the message], the header the
// fragment id (0–31, from 0 in each message) with 0x80 on the last fragment. A message is
// elements [id, size in 4-byte words, data padded to that size], at most 1022 bytes. The sender
// waits for an ack 0x9001 [fragment id, 0 = ok] after every fragment but the last.
//
// Groups: each model has a user EQ (0) and a speaker (headphone) EQ (1), each with its own bands,
// pre-gain, switch, headroom and presets; the 5K and 5K Plus have a single-EQ mode where one
// all-band EQ (2) replaces both. Preset indexes: 0–21 the built-in curves, 22 on the custom
// presets, 255 an edited EQ. A profile's slot ids are these indexes.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { be16, grid, I16, readU16be, U16 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type { HandlerContext, HidFrame, PullResult, WireGrid } from '../handler.ts';
import { decimals, hidFrame, sendFrame, typeCodes } from '../io.ts';
import { after } from '../platform.ts';
import type { HidCollectionInfo, HidTransport } from '../transport.ts';

// --- Framing ---------------------------------------------------------------------------------------

interface Stack {
	/** Output reports, the preferred first. */
	outputs: readonly number[];
	inputs: readonly number[];
	wrap(packet: readonly number[]): number[];
	/** The packet in an input report; empty when it holds none. */
	unwrapIn(data: Uint8Array): Uint8Array;
	/** The packet in an output report (`wrap` undone). */
	unwrapOut(data: Uint8Array): Uint8Array;
}

const lengthFirst = (d: Uint8Array) => {
	const n = readU16be(d, 1);
	return n > d.length - 3 ? new Uint8Array(0) : d.subarray(3, 3 + n);
};

const STACKS: Readonly<Record<number, Stack>> = {
	0x0a12: {
		outputs: [8, 7],
		inputs: [2, 9],
		wrap: (p) => [p.length + 1, 0x80, ...p],
		unwrapIn: (d) => d.subarray(1, Math.min(d.length, (d[0] ?? 0) + 1)),
		unwrapOut: (d) => d.subarray(2, Math.min(d.length, (d[0] ?? 0) + 1))
	},
	0x1fc9: {
		outputs: [2],
		inputs: [1],
		wrap: (p) => [0, ...be16(p.length), ...p],
		unwrapIn: lengthFirst,
		unwrapOut: lengthFirst
	}
};

/** Where a device's packets go: its vendor id (which names the framing) and output report. */
export interface QudelixLink {
	vendorId: number;
	reportId: number;
	/** The output report's size, report id excluded. */
	reportSize: number;
}

/** What a codec assumes without a device: a 0x0a12 device's report 8, 63 bytes on a 5K. */
export const OFFLINE_LINK: QudelixLink = { vendorId: 0x0a12, reportId: 8, reportSize: 63 };

function stackOf(vendorId: number): Stack {
	const stack = STACKS[vendorId];
	if (!stack) {
		throw new BridgeError(
			'unsupported',
			`Qudelix: no framing for vendor id 0x${vendorId.toString(16).padStart(4, '0')}`
		);
	}
	return stack;
}

/** The transport's link. The audio interface, which has no vendor collection, is refused. */
export function linkOf(t: HidTransport): QudelixLink {
	const stack = stackOf(t.vendorId);
	const vendor = (cs: readonly HidCollectionInfo[]): HidCollectionInfo[] =>
		cs.flatMap((c) => [...(c.usagePage === 0xff00 ? [c] : []), ...vendor(c.children)]);
	const collections = vendor(t.collections);
	if (!collections.length) {
		throw new BridgeError(
			'transport',
			'Qudelix: this is the audio interface; connect the control interface (usage page 0xFF00)'
		);
	}
	const reports = collections.flatMap((c) => c.outputReports);
	for (const reportId of stack.outputs) {
		const size = reports.find((r) => r.reportId === reportId)?.size;
		if (size) return { vendorId: t.vendorId, reportId, reportSize: size };
	}
	throw new BridgeError(
		'unsupported',
		`Qudelix: the control interface declares no output report ${stack.outputs.join(' or ')}`
	);
}

/** `packet` as an output report of `link`, zero-padded to its size. */
export function hidOut(link: QudelixLink, packet: readonly number[]): HidFrame {
	const bytes = stackOf(link.vendorId).wrap(packet);
	if (bytes.length > link.reportSize) {
		throw new BridgeError(
			'unsupported',
			`Qudelix: a ${packet.length}-byte packet doesn't fit report ${link.reportId} (${link.reportSize} bytes)`
		);
	}
	const data = new Uint8Array(link.reportSize);
	data.set(bytes);
	return hidFrame(link.reportId, data);
}

/** The packet an output report of `link` carries. */
export const sentPacket = (link: QudelixLink, frame: HidFrame): Uint8Array =>
	stackOf(link.vendorId).unwrapOut(frame.data);

/** A packet: the command, big-endian, and its data. */
export const packet = (command: number, data: readonly number[] = []): number[] => [
	...be16(command),
	...data
];

// --- Bit fields --------------------------------------------------------------------------------------

/** A packed field: its name ('' for padding), width in bits, and whether it is two's complement. */
type Field<K extends string> = readonly [name: K, bits: number, signed?: 'signed'];

export function readBits(bytes: ArrayLike<number>, at: number, width: number, signed = false) {
	let value = 0;
	for (let i = 0; i < width; i++) {
		const bit = at + i;
		if (((bytes[bit >> 3] ?? 0) >> (bit & 7)) & 1) value += 2 ** i;
	}
	return signed && value >= 2 ** (width - 1) ? value - 2 ** width : value;
}

export function writeBits(bytes: Uint8Array, at: number, width: number, value: number) {
	const raw = value < 0 ? value + 2 ** width : value;
	for (let i = 0; i < width; i++) {
		const bit = at + i;
		const mask = 1 << (bit & 7);
		const byte = bytes[bit >> 3] ?? 0;
		bytes[bit >> 3] = Math.floor(raw / 2 ** i) % 2 ? byte | mask : byte & ~mask;
	}
}

/** Fields packed one after another, least significant bit first; `at` is a bit offset. */
export interface Struct<K extends string = string> {
	readonly bits: number;
	has(name: string): boolean;
	read(bytes: ArrayLike<number>, at?: number): Record<K, number>;
	/** Writes the fields named in `values`, leaving the others as they are. */
	write(bytes: Uint8Array, values: Partial<Record<K, number>>, at?: number): void;
}

export function struct<const K extends string>(
	...fields: readonly Field<K>[]
): Struct<Exclude<K, ''>> {
	const named = new Map<string, { at: number; bits: number; signed: boolean }>();
	let bits = 0;
	for (const [name, width, signed] of fields) {
		if (name) named.set(name, { at: bits, bits: width, signed: signed === 'signed' });
		bits += width;
	}
	return {
		bits,
		has: (name) => named.has(name),
		read(bytes, at = 0) {
			const out: Record<string, number> = {};
			for (const [name, f] of named) out[name] = readBits(bytes, at + f.at, f.bits, f.signed);
			return out as Record<Exclude<K, ''>, number>;
		},
		write(bytes, values, at = 0) {
			for (const [name, value] of Object.entries(values) as [string, number | undefined][]) {
				const f = named.get(name);
				if (f && value !== undefined) writeBits(bytes, at + f.at, f.bits, value);
			}
		}
	};
}

/** A copy of `bytes` with some fields of `layout` changed. */
export function withFields<K extends string>(
	bytes: Uint8Array,
	layout: Struct<K>,
	values: Partial<Record<K, number>>
): Uint8Array {
	const out = bytes.slice();
	layout.write(out, values);
	return out;
}

// --- Models and their EQ groups -------------------------------------------------------------------

/** The EQ a profile drives: the user EQ or the speaker (headphone) EQ. */
export type QudelixGroupName = 'usr' | 'spk';

export interface QudelixGroup {
	/** The group byte: 0 the user EQ, 1 the speaker EQ, 2 the all-band EQ of single-EQ mode. */
	id: 0 | 1 | 2;
	name: string;
	bands: number;
	/** The channel counts the bridge drives. Where there are several, the stored preset says. */
	channels: readonly number[];
	/**
	 * Left and right are written together, one frame with both bits, as the app sends them when its
	 * channel selector is on both; else each channel gets its own frame.
	 */
	stereo: boolean;
	/** It may be a graphic EQ (the app's type selector), so a push makes it parametric. */
	graphic: boolean;
	/** Custom presets, from index 22. */
	customs: number;
	/** u16 frequencies stored ahead of the band records; 0 where each record holds its own. */
	freqs: number;
}

/** A stored preset: the fields ahead of the pre-gains, the s16 pre-gains, one record per band. */
export interface PresetLayout {
	/** The T71's says its channel and band counts (`channels`, `bands`). */
	head: Struct;
	preGains: number;
	/** Per channel, then band; holds `freq` where the group stores no frequencies apart. */
	band: Struct;
}

export interface QudelixModel {
	name: string;
	protocol: 1 | 2;
	usr: QudelixGroup;
	spk: QudelixGroup;
	/** The one EQ of single-EQ mode, on a model that has the mode. */
	all?: QudelixGroup;
	preset: PresetLayout;
	/** A group's configuration: its switch, headroom and current preset. */
	groupConfig: Struct<'enable' | 'preset'>;
}

const user = (bands: number, customs: number, freqs: number, channels = [1]): QudelixGroup => ({
	id: 0,
	name: 'user EQ',
	bands,
	channels,
	stereo: false,
	graphic: true,
	customs,
	freqs
});
const speaker = (bands: number, freqs: number): QudelixGroup => ({
	id: 1,
	name: 'speaker EQ',
	bands,
	channels: [2],
	stereo: true,
	graphic: false,
	customs: 20,
	freqs
});
const allBand = (bands: number): QudelixGroup => ({
	id: 2,
	name: `${bands}-band EQ`,
	bands,
	channels: [1],
	stereo: false,
	graphic: true,
	customs: 20,
	freqs: bands
});

export const FIVE_K = 1;
export const FIVE_K_PLUS = 2;
export const T71 = 0x100;

/** By device id. */
export const QUDELIX_MODELS: Readonly<Record<number, QudelixModel>> = {
	[FIVE_K]: {
		name: '5K',
		protocol: 1,
		// The 5K stores 20 frequencies whatever the group: two rows of 10, or one of 20.
		usr: user(10, 20, 20),
		spk: speaker(10, 20),
		all: allBand(20),
		preset: {
			head: struct(['type', 1], ['impedance', 14], ['sensitivity', 11], ['xfeed', 6]),
			preGains: 2,
			band: struct(['filter', 4], ['gain', 10, 'signed'], ['q', 14], ['', 4])
		},
		groupConfig: struct(
			['headroom', 8, 'signed'],
			['preset', 8],
			['enable', 1],
			['autoHeadroom', 1],
			['', 14]
		)
	},
	[T71]: {
		name: 'T71',
		protocol: 1,
		usr: user(10, 10, 0, [1, 5]),
		spk: speaker(10, 0),
		preset: {
			head: struct(
				['channels', 8],
				['bands', 8],
				['muteMask', 8],
				['xfeedFront', 7],
				['type', 1],
				['xfeedBack', 7],
				['impedance', 14],
				['sensitivity', 11]
			),
			preGains: 8,
			band: struct(['filter', 4], ['gain', 10, 'signed'], ['freq', 15], ['q', 14], ['', 5])
		},
		groupConfig: struct(
			['version', 4],
			['headroom', 8, 'signed'],
			['preset', 8],
			['enable', 1],
			['invertMask', 8],
			['', 3]
		)
	},
	[FIVE_K_PLUS]: {
		name: '5K Plus',
		protocol: 2,
		usr: user(10, 20, 10),
		spk: speaker(20, 40),
		all: allBand(30),
		preset: {
			head: struct(
				['type', 1],
				['impedance', 14],
				['sensitivity', 11],
				['xfeed', 6],
				['xspace', 6],
				['geqMode', 3],
				['', 23],
				['', 32]
			),
			preGains: 2,
			band: struct(['filter', 4], ['gain', 10, 'signed'], ['q', 16], ['', 2])
		},
		groupConfig: struct(
			['version', 4],
			['enable', 1],
			['', 11],
			['headroom', 8, 'signed'],
			['preset', 8]
		)
	}
};

/**
 * The EQ `name` drives in the device's mode: the user EQ is the all-band EQ in single-EQ mode,
 * which has no speaker EQ.
 */
export function groupOf(model: QudelixModel, name: QudelixGroupName, single: boolean) {
	if (!single) return model[name];
	if (name === 'usr' && model.all) return model.all;
	throw new BridgeError(
		'unsupported',
		`Qudelix ${model.name}: the device is in single-EQ mode (one ${model.all?.bands ?? 0}-band EQ), which has no speaker EQ`
	);
}

/** Refuses a channel count the bridge doesn't drive. */
function checkChannels(group: QudelixGroup, channels: number) {
	if (group.channels.includes(channels)) return;
	throw new BridgeError(
		'unsupported',
		group.stereo
			? `Qudelix: the speaker EQ has ${channels} channels, which the app treats as drivers; the bridge writes one left and right pair`
			: `Qudelix: the ${group.name} has ${channels} channels; the bridge drives ${group.channels.join(' or ')}`
	);
}

/** The channel masks a write goes out on: each channel alone, or left and right together. */
export function channelMasks(group: QudelixGroup, channels: number): number[] {
	checkChannels(group, channels);
	return group.stereo
		? Array.from({ length: channels / 2 }, (_, i) => 3 << (2 * i))
		: Array.from({ length: channels }, (_, i) => 1 << i);
}

// --- Presets and filters ----------------------------------------------------------------------------

export const CUSTOM = 22;
export const EDITED = 255;
export const PARAMETRIC = 1;

/** Which custom preset, from 0, the preset index `slot` is; a built-in or one past the group's is refused. */
export function customOf(group: QudelixGroup, slot: number): number {
	const n = slot - CUSTOM;
	if (!Number.isInteger(slot) || n < 0 || n >= group.customs) {
		throw new BridgeError(
			'invalid-request',
			`Qudelix: the ${group.name} saves to presets ${CUSTOM}–${CUSTOM + group.customs - 1}, not ${slot}`
		);
	}
	return n;
}

/** Filter codes. 0 is a band switched off (bypass), which reads as no filter. */
export const QUDELIX_TYPES = typeCodes('qudelix', { LPQ: 1, HPQ: 2, LSC: 3, HSC: 4, PK: 5 });
const BYPASS = 0;

/** The band write's fields: freq u16 Hz, gain s16 ×10, q u16 ×1024; pre-gain s16 ×10. */
export const QUDELIX_WIRE: WireGrid = {
	freq: grid(1, U16),
	q: { ...grid(1024, U16), min: 1 / 1024 },
	gain: grid(10, I16),
	preamp: grid(10, I16)
};

export interface RawBand {
	filter: number;
	freq: number;
	/** ×10 */
	gain: number;
	/** ×1024 */
	q: number;
}

export function filterOf(b: RawBand): Filter | null {
	if (b.filter === BYPASS) return null;
	return {
		type: QUDELIX_TYPES.decode(b.filter),
		freq: b.freq,
		gain: decimals(b.gain / 10, 1),
		q: b.q / 1024
	};
}

/** A stored preset, per channel: the pre-gain (×10) and the bands. */
export type StoredPreset = { preGain: number; bands: RawBand[] }[];

export function presetSize(model: QudelixModel, group: QudelixGroup, channels: number): number {
	const { head, preGains, band } = model.preset;
	return (head.bits + 16 * (preGains + group.freqs) + channels * group.bands * band.bits) / 8;
}

/** Decodes a stored preset of `group`. A channel count the bridge doesn't drive is `unsupported`. */
export function readPreset(
	model: QudelixModel,
	group: QudelixGroup,
	bytes: Uint8Array
): StoredPreset {
	const { head, preGains, band } = model.preset;
	const h: Partial<Record<string, number>> = head.read(bytes);
	const channels = h.channels ?? group.channels[0]!;
	const size = presetSize(model, group, channels);
	if ((h.bands ?? group.bands) !== group.bands || bytes.length !== size) {
		throw new BridgeError(
			'bad-response',
			`Qudelix ${model.name}: a ${bytes.length}-byte ${group.name} preset, not the ${size} its layout gives`
		);
	}
	checkChannels(group, channels);
	const gainsAt = head.bits;
	const freqsAt = gainsAt + 16 * preGains;
	const bandsAt = freqsAt + 16 * group.freqs;
	return Array.from({ length: channels }, (_, ch) => ({
		preGain: readBits(bytes, gainsAt + 16 * ch, 16, true),
		bands: Array.from({ length: group.bands }, (_, i) => {
			const at = ch * group.bands + i;
			const r: Partial<Record<string, number>> = band.read(bytes, bandsAt + at * band.bits);
			return {
				filter: r.filter ?? 0,
				gain: r.gain ?? 0,
				q: r.q ?? 0,
				freq: group.freqs ? readBits(bytes, freqsAt + 16 * at, 16) : (r.freq ?? 0)
			};
		})
	}));
}

const sameBand = (a: RawBand, b: RawBand) =>
	a.filter === b.filter && a.freq === b.freq && a.gain === b.gain && a.q === b.q;

/**
 * What a pull returns: the first channel (the left one of a speaker EQ). Another channel that
 * differs from it is reported through `log`, since a profile has one set of filters.
 */
export function pullResult(
	log: (message: string) => void,
	model: QudelixModel,
	group: QudelixGroup,
	preset: StoredPreset,
	index: number
): PullResult {
	const first = preset[0]!;
	preset.slice(1).forEach((other, i) => {
		if (
			other.preGain !== first.preGain ||
			other.bands.some((b, k) => !sameBand(b, first.bands[k]!))
		) {
			log(
				`Qudelix ${model.name}: the ${group.name}'s channel ${i + 1} differs from channel 0, which is what the pull returns`
			);
		}
	});
	return {
		filters: first.bands.map(filterOf),
		preamp: decimals(first.preGain / 10, 1),
		...(index === EDITED ? {} : { slot: index })
	};
}

// --- Second-protocol messages -------------------------------------------------------------------

export const INIT_RSP = 0x9000;
export const ACK = 0x9001;
export const REQ = 0x9002;
export const RSP = 0x9003;
export const SET = 0x9004;
export const NOTI = 0x9005;
export const ACTION = 0x9006;
const MAX_MESSAGE = 1022;

export interface Element {
	id: number;
	data: Uint8Array;
}

/** The elements of a message; null when one runs past its end. */
export function elementsOf(payload: Uint8Array): Element[] | null {
	const out: Element[] = [];
	for (let at = 0; at < payload.length;) {
		const size = (payload[at + 1] ?? 0) * 4;
		if (at + 2 > payload.length || at + 2 + size > payload.length) return null;
		out.push({ id: payload[at]!, data: payload.subarray(at + 2, at + 2 + size) });
		at += 2 + size;
	}
	return out;
}

/** One element's bytes, its data zero-padded to whole words. */
export function elementBytes(id: number, data: ArrayLike<number>): number[] {
	const words = Math.ceil(data.length / 4);
	return [id, words, ...Array.from(data), ...new Array<number>(words * 4 - data.length).fill(0)];
}

/**
 * Second-protocol packets back into messages, as the app reassembles them: one message at a time,
 * and a fragment out of order, repeated or of another command drops it.
 */
export class Reassembly {
	#command = -1;
	#last = -1;
	#parts = new Map<number, Uint8Array>();
	#size = 0;

	#reset(): undefined {
		this.#command = -1;
		this.#last = -1;
		this.#parts.clear();
		this.#size = 0;
		return undefined;
	}

	/** One packet's [header, slice…]; the message once its fragments are all in. */
	push(command: number, body: Uint8Array): Uint8Array | undefined {
		const header = body[0];
		if (header === undefined || header & 0x60) return this.#reset();
		const id = header & 0x1f;
		const data = body.slice(1);
		if (this.#command < 0) this.#command = command;
		else if (this.#command !== command) return this.#reset();
		if (this.#parts.has(id) || (this.#last >= 0 && id > this.#last)) return this.#reset();
		if (header & 0x80) {
			if (this.#last >= 0 || [...this.#parts.keys()].some((k) => k > id)) return this.#reset();
			this.#last = id;
		}
		if (this.#size + data.length > MAX_MESSAGE) return this.#reset();
		this.#parts.set(id, data);
		this.#size += data.length;
		if (this.#last < 0) return undefined;
		const out = new Uint8Array(this.#size);
		let at = 0;
		for (let i = 0; i <= this.#last; i++) {
			const part = this.#parts.get(i);
			if (!part) return undefined;
			out.set(part, at);
			at += part.length;
		}
		this.#reset();
		return out;
	}
}

// --- Session -------------------------------------------------------------------------------------

export interface QudelixMessage {
	command: number;
	payload: Uint8Array;
}

export interface QudelixDevice {
	id: number;
	model: QudelixModel | undefined;
	/** [major, minor, revision], from the first protocol's opening answer. */
	firmware: [number, number, number] | null;
	/** The second protocol's packet size, 40 to 120. */
	packetSize: number;
}

const OPEN_REQUEST = packet(0x0100, [0x20, 0x00, 0x04]);
const INIT_DATA = 0x0101;
const READY = 3;
const QUIET_MS = 20;
const OPEN_TIMEOUT = 5000;
const FIRMWARE = struct(['major', 6], ['minor', 6], ['revision', 4]);
const DEVICE_ID = 1;
const PROTOCOL = 2;
const isSecond = (command: number) => command >= INIT_RSP && command <= ACTION;

const opening = (m: QudelixMessage) => {
	if (m.command === INIT_DATA) return m.payload[2] === READY;
	const ids = m.command === INIT_RSP ? elementsOf(m.payload)?.map((e) => e.id) : undefined;
	return !!ids && ids.includes(DEVICE_ID) && ids.includes(PROTOCOL);
};

/** A transport's open session: one input listener, which reassembles and dispatches messages. */
export class QudelixSession {
	readonly transport: HidTransport;
	readonly link: QudelixLink;
	device: QudelixDevice = { id: 0, model: undefined, firmware: null, packetSize: 0 };
	/** The second protocol's elements, latest first: the opening answer, answers, notifications. */
	readonly elements = new Map<number, Uint8Array>();
	#waiters = new Set<(m: QudelixMessage) => void>();
	#reassembly = new Reassembly();
	#heard = 0;
	#draining = true;
	#open = false;
	#unsubscribe: () => void;

	constructor(transport: HidTransport, link: QudelixLink) {
		this.transport = transport;
		this.link = link;
		const stack = stackOf(link.vendorId);
		this.#unsubscribe = transport.onInputReport((reportId, data) => {
			this.#heard++;
			if (this.#draining || !stack.inputs.includes(reportId)) return;
			const p = stack.unwrapIn(data);
			if (p.length < 2) return;
			const command = readU16be(p, 0);
			const payload = isSecond(command)
				? this.#reassembly.push(command, p.subarray(2))
				: p.slice(2);
			if (payload) this.#dispatch({ command, payload });
		});
	}

	#dispatch(m: QudelixMessage) {
		if (this.#open && (m.command === RSP || m.command === NOTI)) this.#keep(m.payload);
		for (const waiter of [...this.#waiters]) waiter(m);
	}

	#keep(payload: Uint8Array) {
		for (const e of elementsOf(payload) ?? []) this.elements.set(e.id, e.data.slice());
	}

	/** Waits until 20 ms pass without input, as the app does before it opens a device. */
	async drain(sleep: (ms: number) => Promise<void>) {
		for (let waited = 0; ; waited += QUIET_MS) {
			const heard = this.#heard;
			await sleep(QUIET_MS);
			if (this.#heard === heard) break;
			if (waited >= OPEN_TIMEOUT) {
				throw new BridgeError(
					'timeout',
					'Qudelix: the device never went quiet long enough to open'
				);
			}
		}
		this.#draining = false;
	}

	/** The device the opening answer describes. */
	opened(m: QudelixMessage) {
		const p = m.payload;
		if (m.command === INIT_DATA) {
			const id = readU16be(p, 0);
			const { major, minor, revision } = FIRMWARE.read(p, 24);
			this.device = {
				id,
				model: QUDELIX_MODELS[id],
				firmware: [major, minor, revision],
				packetSize: 0
			};
		} else {
			const elements = new Map(elementsOf(p)!.map((e) => [e.id, e.data]));
			const [major = 0, minor = 0, revision = 0, size = 0] = elements.get(PROTOCOL)!;
			if (major !== 2) {
				throw new BridgeError(
					'unsupported',
					`Qudelix: the device speaks protocol ${major}.${minor}.${revision}; the app and this bridge speak 2.x`
				);
			}
			const id = readBits(elements.get(DEVICE_ID)!, 0, 16);
			this.device = {
				id,
				model: QUDELIX_MODELS[id],
				firmware: null,
				packetSize: Math.min(Math.max(size, 40), 120)
			};
			this.#keep(p);
		}
		this.#open = true;
	}

	/** The first message `match` accepts within `timeoutMs`. Call it before sending the request. */
	expect(match: (m: QudelixMessage) => boolean, timeoutMs: number, what: string) {
		return new Promise<QudelixMessage>((resolve, reject) => {
			const waiter = (m: QudelixMessage) => {
				if (!match(m)) return;
				cancel();
				this.#waiters.delete(waiter);
				resolve(m);
			};
			const cancel = after(timeoutMs, () => {
				this.#waiters.delete(waiter);
				reject(new BridgeError('timeout', `Qudelix: no answer to ${what} within ${timeoutMs} ms`));
			});
			this.#waiters.add(waiter);
		});
	}

	/** Sends `packet` and waits for the answer `match` accepts. */
	async ask(
		data: readonly number[],
		match: (m: QudelixMessage) => boolean,
		timeoutMs: number,
		what: string
	) {
		const answer = this.expect(match, timeoutMs, what);
		// Keeps a send failure from leaving the wait's rejection unhandled.
		answer.catch(() => {});
		await this.send(data);
		return answer;
	}

	send(data: readonly number[]) {
		return sendFrame(this.transport, hidOut(this.link, data));
	}

	close() {
		this.#unsubscribe();
	}
}

const sessions = new WeakMap<HidTransport, Promise<QudelixSession>>();

async function openSession(ctx: HandlerContext<HidTransport, unknown>) {
	const session = new QudelixSession(ctx.transport, linkOf(ctx.transport));
	try {
		await session.drain(ctx.sleep);
		session.opened(await session.ask(OPEN_REQUEST, opening, OPEN_TIMEOUT, 'the opening request'));
		return session;
	} catch (error) {
		session.close();
		throw error;
	}
}

/**
 * The transport's session, opened on first use. One that fails to open is forgotten, so the next
 * operation opens it again.
 */
export function qudelixSession(ctx: HandlerContext<HidTransport, unknown>) {
	const t = ctx.transport;
	const known = sessions.get(t);
	if (known) return known;
	const opening = openSession(ctx);
	sessions.set(t, opening);
	opening.catch(() => {
		if (sessions.get(t) === opening) sessions.delete(t);
	});
	return opening;
}

/** Closes and forgets a session, as the app reconnects after a failed transfer. */
export function dropSession(session: QudelixSession) {
	session.close();
	sessions.delete(session.transport);
}

/** Refuses a device the handler doesn't drive, naming the handler that does. */
export function modelFor(session: QudelixSession, protocol: 1 | 2): QudelixModel {
	const { id, model } = session.device;
	if (model?.protocol === protocol) return model;
	const hex = `0x${id.toString(16).padStart(4, '0')}`;
	throw new BridgeError(
		'unsupported',
		model
			? `Qudelix: this is a ${model.name}, which speaks the ${model.protocol === 1 ? 'first protocol (qudelix-usb-hid)' : 'second protocol (qudelix-v2-usb-hid)'}`
			: `Qudelix: device id ${hex} is no model this bridge knows`
	);
}
