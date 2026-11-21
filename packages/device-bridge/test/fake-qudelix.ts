// Qudelix devices simulated from the reading of Qudelix's app for Chrome (version 4.0.3.1): what
// the app sends and what it expects back, for the 5K and T71 (first protocol) and the 5K Plus
// (second protocol). No device answered any of this. The fakes show that the handlers agree with
// that reading of the app, not that a device behaves so. Their stored-preset layouts are written
// out here field by field, apart from the bridge's tables, so the two check each other.

import type { HidCollectionInfo, HidTransport } from '../src/index.ts';

/** Bits packed least significant first. */
class Bits {
	readonly bytes: Uint8Array;
	at = 0;
	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
	}
	put(value: number, width: number) {
		const raw = value < 0 ? value + 2 ** width : value;
		for (let i = 0; i < width; i++, this.at++) {
			if (Math.floor(raw / 2 ** i) % 2) this.bytes[this.at >> 3]! |= 1 << (this.at & 7);
		}
		return this;
	}
	get(width: number, signed = false) {
		let v = 0;
		for (let i = 0; i < width; i++, this.at++) {
			if ((this.bytes[this.at >> 3]! >> (this.at & 7)) & 1) v += 2 ** i;
		}
		return signed && v >= 2 ** (width - 1) ? v - 2 ** width : v;
	}
}

/** A band as the device holds it: gain ×10, q ×1024. */
export interface FakeBand {
	filter: number;
	freq: number;
	gain: number;
	q: number;
}

/** One EQ group's state. */
export interface FakeEq {
	enable: number;
	/** The current preset index; 255 once edited. */
	preset: number;
	headroom: number;
	type: number;
	/** ×10 ohms, in the stored preset's attributes. */
	impedance: number;
	/** Per channel, ×10. */
	preGain: number[];
	/** [channel][band]. */
	bands: FakeBand[][];
	/** Saved custom presets, by preset index. */
	saved: Map<number, { preGain: number[]; bands: FakeBand[][] }>;
	/** Names, by custom preset number from 0. */
	names: Map<number, string>;
}

const CENTRES = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** A flat EQ: peaking bands at 0 dB, Q 1.414. */
export function flatEq(channels: number, bands: number): FakeEq {
	return {
		enable: 1,
		preset: 0,
		headroom: 0,
		type: 1,
		impedance: 0,
		preGain: new Array<number>(channels).fill(0),
		bands: Array.from({ length: channels }, () =>
			Array.from({ length: bands }, (_, i) => ({
				filter: 5,
				freq: bands === 10 ? CENTRES[i]! : Math.round(25 * 2 ** (i / 3)),
				gain: 0,
				q: 1448
			}))
		),
		saved: new Map(),
		names: new Map()
	};
}

const copy = (bands: FakeBand[][]) => bands.map((ch) => ch.map((b) => ({ ...b })));
const s16be = (d: ArrayLike<number>, i: number) => (((d[i]! << 8) | d[i + 1]!) << 16) >> 16;
const u16be = (d: ArrayLike<number>, i: number) => (d[i]! << 8) | d[i + 1]!;
const utf8 = (bytes: ArrayLike<number>) => Buffer.from(Uint8Array.from(bytes)).toString('utf8');

interface FakeOptions {
	deviceId?: number;
	firmware?: [number, number, number];
	/** Output reports the vendor collection declares; default the model's. */
	outputs?: { reportId: number; size: number }[];
	/** No vendor collection: the audio interface. */
	audioOnly?: boolean;
}

/** Common to both fakes: identity, descriptor, framing, and the record of what was sent. */
abstract class FakeHid implements HidTransport {
	readonly kind = 'hid' as const;
	readonly vendorId: number;
	readonly productId: number;
	readonly productName: string;
	readonly collections: HidCollectionInfo[];
	/** Every output report, as sent. */
	readonly sent: { reportId: number; data: number[] }[] = [];
	/** What the fake could not make sense of: a wrong group, mask, length or order. */
	readonly errors: string[] = [];
	/** Answers the opening request. */
	answerOpening = true;
	/** Echoes each band write in a notification, as a 5K does (recorded 2026-11-20). */
	echoes = true;
	deviceId: number;
	readonly #listeners = new Set<(reportId: number, data: Uint8Array) => void>();
	readonly #inputId: number;
	readonly #inputSize: number;

	constructor(
		ids: { vendorId: number; productId: number; productName: string },
		reports: { input: number; output: { reportId: number; size: number }[]; size: number },
		deviceId: number,
		o: FakeOptions
	) {
		this.vendorId = ids.vendorId;
		this.productId = ids.productId;
		this.productName = ids.productName;
		this.deviceId = o.deviceId ?? deviceId;
		this.#inputId = reports.input;
		this.#inputSize = reports.size;
		this.collections = o.audioOnly
			? [
					{
						usagePage: 0x0c,
						usage: 1,
						inputReports: [],
						outputReports: [],
						featureReports: [],
						children: []
					}
				]
			: [
					{
						usagePage: 0xff00,
						usage: 1,
						inputReports: [{ reportId: reports.input, size: reports.size }],
						outputReports: o.outputs ?? reports.output,
						featureReports: [],
						children: []
					}
				];
	}

	get qualcomm() {
		return this.vendorId === 0x0a12;
	}

	/** Reports sent. */
	get count() {
		return this.sent.length;
	}

	/** The packets sent, unwrapped from their reports. */
	packets(): number[][] {
		return this.sent.map(({ data }) =>
			this.qualcomm ? data.slice(2, data[0]! + 1) : data.slice(3, 3 + u16be(data, 1))
		);
	}

	/** The commands sent, in order. */
	commands(): number[] {
		return this.packets().map((p) => u16be(p, 0));
	}

	/** Sends `packet` as an input report. */
	reply(packet: number[]) {
		const head = this.qualcomm ? [packet.length] : [0, packet.length >> 8, packet.length & 255];
		const data = new Uint8Array(this.#inputSize);
		data.set([...head, ...packet]);
		for (const l of [...this.#listeners]) l(this.#inputId, data);
	}

	/** An empty input report, as a device that isn't quiet yet sends. */
	chatter() {
		for (const l of [...this.#listeners]) l(this.#inputId, new Uint8Array(this.#inputSize));
	}

	protected abstract handle(packet: Uint8Array): void;

	async sendReport(reportId: number, data: Uint8Array) {
		this.sent.push({ reportId, data: [...data] });
		const p = this.qualcomm ? data.subarray(2, data[0]! + 1) : data.subarray(3, 3 + u16be(data, 1));
		this.handle(p);
	}
	async sendFeatureReport() {}
	async receiveFeatureReport() {
		return new Uint8Array(64);
	}
	onInputReport(listener: (reportId: number, data: Uint8Array) => void) {
		this.#listeners.add(listener);
		return () => void this.#listeners.delete(listener);
	}
	async close() {}
}

/** Firmware version, 4 bytes: major 6 bits, minor 6, revision 4, then a date. */
const firmwareBytes = ([major, minor, revision]: [number, number, number]) => [
	...new Bits(new Uint8Array(4))
		.put(major, 6)
		.put(minor, 6)
		.put(revision, 4)
		.put(25, 7)
		.put(6, 4)
		.put(1, 5).bytes
];

/**
 * A 5K (firmware 3.x) or T71 speaking the first protocol. The 5K answers on report 9 over
 * 0x0a12's framing, with 56-byte packets; the T71 on report 1 over 0x1fc9's, with 122. A band or
 * pre-gain write changes the channels its mask names and no other, as a 5K with firmware 3.2.9
 * did for masks 1 and 2 (2026-11-21).
 */
export class FakeQudelix extends FakeHid {
	readonly model: '5k' | 't71';
	firmware: [number, number, number];
	/** The 5K's EQ mode: the user and speaker EQs, or the one all-band EQ. */
	single = false;
	/** Opening answers in turn: 3 is ready, 2 waiting. */
	openingStates = [3];
	readonly eqs = new Map<number, FakeEq>();

	constructor(
		model: '5k' | 't71',
		o: FakeOptions & { usrChannels?: number; spkChannels?: number } = {}
	) {
		const t71 = model === 't71';
		super(
			t71
				? { vendorId: 0x1fc9, productId: 0x7100, productName: 'Qudelix T71' }
				: { vendorId: 0x0a12, productId: 0x4005, productName: 'Qudelix-5K USB DAC 48KHz' },
			t71
				? { input: 1, output: [{ reportId: 2, size: 127 }], size: 127 }
				: {
						input: 9,
						output: [
							{ reportId: 7, size: 63 },
							{ reportId: 8, size: 63 }
						],
						size: 63
					},
			t71 ? 0x100 : 1,
			o
		);
		this.model = model;
		this.firmware = o.firmware ?? (t71 ? [1, 5, 9] : [3, 2, 1]);
		this.eqs.set(0, flatEq(o.usrChannels ?? 1, 10));
		this.eqs.set(1, flatEq(o.spkChannels ?? 2, 10));
		if (!t71) this.eqs.set(2, flatEq(1, 20));
	}

	get packetSize() {
		return this.model === 't71' ? 122 : 56;
	}

	/** The groups the device runs now. */
	get active(): number[] {
		return this.single ? [2] : [0, 1];
	}

	#eq(group: number): FakeEq | undefined {
		if (!this.active.includes(group)) {
			this.errors.push(`group ${group} is not active`);
			return undefined;
		}
		return this.eqs.get(group);
	}

	#channels(eq: FakeEq, mask: number): number[] {
		const n = eq.bands.length;
		if (mask === 0 || mask >= 1 << n) {
			this.errors.push(`mask ${mask} on a ${n}-channel group`);
			return [];
		}
		return Array.from({ length: n }, (_, ch) => ch).filter((ch) => mask & (1 << ch));
	}

	/** A group's configuration, 4 bytes, and its preset configuration, 4 bytes. */
	#config(eq: FakeEq): number[] {
		const names = [...eq.saved.keys()].reduce((m, i) => m | (1 << (i - 22)), 0);
		const b = new Bits(new Uint8Array(8));
		if (this.model === 't71') {
			b.put(0, 4).put(eq.headroom, 8).put(eq.preset, 8).put(eq.enable, 1).put(0, 8).put(0, 3);
			b.put(0, 4).put(names, 20).put(0, 8);
		} else {
			b.put(eq.headroom, 8).put(eq.preset, 8).put(eq.enable, 1).put(0, 1).put(0, 14);
			b.put(names, 20).put(0, 12);
		}
		return [...b.bytes];
	}

	/** The stored preset of a group, in the model's layout. */
	presetBytes(group: number): Uint8Array {
		const eq = this.eqs.get(group)!;
		const channels = eq.bands.length;
		const bands = eq.bands[0]!.length;
		if (this.model === 't71') {
			const b = new Bits(new Uint8Array(8 + 16 + channels * bands * 6));
			b.put(channels, 8)
				.put(bands, 8)
				.put(0, 8)
				.put(0, 7)
				.put(eq.type, 1)
				.put(0, 7)
				.put(0, 14)
				.put(0, 11);
			for (let ch = 0; ch < 8; ch++) b.put(eq.preGain[ch] ?? 0, 16);
			for (const ch of eq.bands) {
				for (const x of ch)
					b.put(x.filter, 4).put(x.gain, 10).put(x.freq, 15).put(x.q, 14).put(0, 5);
			}
			return b.bytes;
		}
		// 5K: 88 bytes for the user EQ, 128 for the speaker and all-band EQs.
		const b = new Bits(new Uint8Array(group === 0 ? 88 : 128));
		b.put(eq.type, 1).put(eq.impedance, 14).put(0, 11).put(0, 6);
		for (let ch = 0; ch < 2; ch++) b.put(eq.preGain[ch] ?? 0, 16);
		const [rows, cols] = group === 2 ? [1, 20] : [2, 10];
		for (let r = 0; r < rows; r++)
			for (let c = 0; c < cols; c++) b.put(eq.bands[r]?.[c]?.freq ?? 0, 16);
		for (const ch of eq.bands) {
			for (const x of ch) b.put(x.filter, 4).put(x.gain, 10).put(x.q, 14).put(0, 4);
		}
		return b.bytes;
	}

	protected handle(p: Uint8Array) {
		const command = u16be(p, 0);
		const d = p.subarray(2);
		const g = d[0]!;
		const edited = (eq: FakeEq) => (eq.preset = 255);
		switch (command) {
			case 0x0100: {
				if (!this.answerOpening) return;
				const blob = this.model === 't71' ? [1, 2, 3, 4, 0] : [0, 0, 1, 2, 3, 4, 0];
				for (const state of this.openingStates) {
					this.reply([
						0x01,
						0x01,
						this.deviceId >> 8,
						this.deviceId & 255,
						state,
						...firmwareBytes(this.firmware),
						...blob
					]);
				}
				return;
			}
			case 0x0120: {
				const mask = this.model === 't71' ? 0x40 : 0x80;
				if (g !== mask) return this.reply([0x01, 0x21, g]);
				const block = this.single
					? [2, ...this.#config(this.eqs.get(2)!)]
					: [0, ...this.#config(this.eqs.get(0)!), 1, ...this.#config(this.eqs.get(1)!)];
				return this.reply([0x01, 0x21, mask, ...block]);
			}
			case 0x0123:
				for (const group of this.active) if (g & (1 << group)) this.#sendPreset(group);
				return;
			case 0x0700: {
				const eq = this.#eq(g);
				if (eq) eq.enable = d[1]!;
				return;
			}
			case 0x0701: {
				const eq = this.#eq(g);
				if (eq) eq.type = d[1]!;
				return;
			}
			case 0x0703: {
				const eq = this.#eq(g);
				if (!eq) return;
				for (const ch of this.#channels(eq, d[1]!)) eq.preGain[ch] = s16be(d, 3);
				return edited(eq);
			}
			case 0x070f: {
				const eq = this.#eq(g);
				if (!eq) return;
				if (d.length !== 10) this.errors.push(`band write of ${d.length} bytes`);
				const band = d[2]!;
				for (const ch of this.#channels(eq, d[1]!)) {
					if (!eq.bands[ch]![band]) {
						this.errors.push(`band ${band} past the group's`);
						continue;
					}
					eq.bands[ch]![band] = {
						filter: d[3]!,
						freq: u16be(d, 4),
						gain: s16be(d, 6),
						q: u16be(d, 8)
					};
				}
				edited(eq);
				// 0x2000 [0x89, group, mask, band, 0, type, freq, gain, Q], after the write.
				if (this.echoes) {
					const echo = [0x20, 0x00, 0x89, g, d[1]!, band, 0, ...d.subarray(3, 10)];
					queueMicrotask(() => this.reply(echo));
				}
				return;
			}
			case 0x070a: {
				const eq = this.#eq(g);
				if (eq) eq.names.set(d[1]!, utf8(d.subarray(3, 3 + d[2]!)));
				return;
			}
			case 0x0708: {
				const eq = this.#eq(g);
				if (!eq) return;
				eq.saved.set(d[1]!, { preGain: [...eq.preGain], bands: copy(eq.bands) });
				eq.preset = d[1]!;
				return;
			}
			case 0x0709: {
				const eq = this.#eq(g);
				if (!eq) return;
				const saved = eq.saved.get(d[1]!);
				if (saved) {
					eq.preGain = [...saved.preGain];
					eq.bands = copy(saved.bands);
				}
				eq.preset = d[1]!;
				return;
			}
		}
	}

	/** The stored preset in fragments [group, last << 4 | index, size, offset, bytes…]. */
	#sendPreset(group: number) {
		const bytes = this.presetBytes(group);
		const chunk = this.packetSize - 6;
		const last = Math.ceil(bytes.length / chunk) - 1;
		for (let i = 0; i <= last; i++) {
			const part = bytes.subarray(i * chunk, (i + 1) * chunk);
			this.reply([
				0x01,
				0x28,
				group,
				(last << 4) | i,
				part.length >> 8,
				part.length & 255,
				(i * chunk) >> 8,
				(i * chunk) & 255,
				...part
			]);
		}
	}
}

const ELEMENT_BASE = [0x90, 0xa0, 0xb0];

/** [id, words, data zero-padded to whole words]. */
const element = (id: number, data: number[]) => {
	const words = Math.ceil(data.length / 4);
	return [id, words, ...data, ...new Array<number>(words * 4 - data.length).fill(0)];
};

/**
 * A 5K Plus speaking the second protocol on 0x0a12's framing (report 8 out, 9 in, 63 bytes), in
 * packets of `packetSize` (40 by default, so long messages split). It acks every fragment but
 * the last of a message, reassembles, and answers requests in fragments of its own. It sends no
 * notification but `lateNotifications`'s, so a test that sets its state (`single`, `eqs`) changes
 * the device as another program would, unannounced: an open session on a 5K Plus with firmware
 * 1.0.3 was told nothing of another program's push (2026-11-21).
 */
export class FakeQudelixV2 extends FakeHid {
	packetSize = 40;
	protocolMajor = 2;
	firmware: [number, number, number] = [1, 2, 3];
	single = false;
	/** Elements the opening answer leaves out. */
	readonly omit = new Set<number>();
	/** How fragments are acked: `ok`, not at all (`none`), or with a failure (`bad`). */
	ack: 'ok' | 'none' | 'bad' = 'ok';
	/** Acks sent. */
	acks = 0;
	/** Messages received, reassembled: their command and elements. */
	readonly messages: { command: number; elements: { id: number; data: number[] }[] }[] = [];
	/** The fragments of each message received: [header, slice size]. */
	readonly fragments: [number, number][][] = [];
	/**
	 * Notifies (0x9005) an EQ's whole stored preset when an edit takes the EQ off a stored preset,
	 * holding the EQ as that edit left it, and sends the notification late: after the next request,
	 * a moment before its answer. A 5K Plus with firmware 1.0.3 was seen to (2026-11-21).
	 */
	lateNotifications = false;
	#notifications: number[] = [];
	readonly eqs = new Map<number, FakeEq>([
		[0, flatEq(1, 10)],
		[1, flatEq(2, 20)],
		[2, flatEq(1, 30)]
	]);
	#parts: number[] = [];
	#heads: [number, number][] = [];

	constructor(o: FakeOptions = {}) {
		super(
			{ vendorId: 0x0a12, productId: 0x5000, productName: 'Qudelix-5K Plus USB DAC' },
			{
				input: 9,
				output: [
					{ reportId: 7, size: 63 },
					{ reportId: 8, size: 63 }
				],
				size: 63
			},
			2,
			o
		);
	}

	get active(): number[] {
		return this.single ? [2] : [0, 1];
	}

	/** Sends a message in fragments of `packetSize - 1` bytes. */
	#send(command: number, message: number[]) {
		const size = this.packetSize - 1;
		const last = Math.max(0, Math.ceil(message.length / size) - 1);
		for (let id = 0; id <= last; id++) {
			const header = id | (id === last ? 0x80 : 0);
			this.reply([
				command >> 8,
				command & 255,
				header,
				...message.slice(id * size, (id + 1) * size)
			]);
		}
	}

	/** The stored preset: attributes (12 bytes), 2 pre-gains, frequencies, then bands. */
	presetBytes(group: number): Uint8Array {
		const eq = this.eqs.get(group)!;
		const b = new Bits(new Uint8Array([76, 256, 196][group]!));
		b.put(eq.type, 1).put(eq.impedance, 14).put(0, 11).put(0, 6).put(0, 6).put(0, 3);
		b.put(0, 23).put(0, 32);
		for (let ch = 0; ch < 2; ch++) b.put(eq.preGain[ch] ?? 0, 16);
		for (const ch of eq.bands) for (const x of ch) b.put(x.freq, 16);
		for (const ch of eq.bands) {
			for (const x of ch) b.put(x.filter, 4).put(x.gain, 10).put(x.q, 16).put(0, 2);
		}
		return b.bytes;
	}

	/** An element's data, as the device would answer a request for it. */
	#element(id: number): number[] | undefined {
		const group = ELEMENT_BASE.indexOf(id & 0xf0);
		const eq = this.eqs.get(group);
		if (id === 1) return [this.deviceId & 255, this.deviceId >> 8, 0, 0];
		if (id === 2) return [this.protocolMajor, 0, 0, this.packetSize];
		if (id === 3) return [...this.firmware, 0, 1, 2, 3, 4];
		if (id === 0x80) return [(this.single ? 1 : 0) << 4, 0, 0, 0];
		if (!eq) return undefined;
		if ((id & 15) === 0) return [eq.enable << 4, 0, eq.headroom & 255, eq.preset];
		if ((id & 15) === 3) return [...this.presetBytes(group)];
		return undefined;
	}

	protected handle(p: Uint8Array) {
		const command = u16be(p, 0);
		if (command === 0x0100) {
			// Opened again: a message left half-sent is dropped.
			this.#parts = [];
			this.#heads = [];
			if (!this.answerOpening) return;
			const ids = [1, 2, 3, 0x80, 0x90, 0xa0, 0xb0].filter((id) => !this.omit.has(id));
			return this.#send(
				0x9000,
				ids.flatMap((id) => element(id, this.#element(id)!))
			);
		}
		if (command < 0x9002 || command > 0x9006) return void this.errors.push(`command ${command}`);
		const header = p[2]!;
		const id = header & 31;
		if (id !== this.#heads.length) this.errors.push(`fragment ${id} out of order`);
		this.#heads.push([header, p.length - 3]);
		this.#parts.push(...p.subarray(3));
		if (!(header & 0x80)) {
			if (this.ack === 'none') return;
			this.acks++;
			return this.reply([0x90, 0x01, 0x80, id, this.ack === 'ok' ? 0 : 1]);
		}
		const message = this.#parts;
		this.fragments.push(this.#heads);
		this.#parts = [];
		this.#heads = [];
		const elements: { id: number; data: number[] }[] = [];
		for (let at = 0; at < message.length; at += 2 + message[at + 1]! * 4) {
			elements.push({
				id: message[at]!,
				data: message.slice(at + 2, at + 2 + message[at + 1]! * 4)
			});
		}
		this.messages.push({ command, elements });
		if (command === 0x9002) {
			const answer = elements.flatMap((e) => element(e.id, this.#element(e.id) ?? []));
			if (!this.#notifications.length) return this.#send(0x9003, answer);
			// The answer comes a moment after the notifications, once the bridge could act on them.
			this.#send(0x9005, this.#notifications.splice(0));
			return void setTimeout(() => this.#send(0x9003, answer));
		}
		for (const e of elements) this.#apply(command, e.id, e.data);
	}

	#eq(group: number) {
		if (!this.active.includes(group)) {
			this.errors.push(`group ${group} is not active`);
			return undefined;
		}
		return this.eqs.get(group);
	}

	#apply(command: number, id: number, d: number[]) {
		if (command === 0x9006) {
			const eq = id === 0x30 ? this.#eq(d[0]!) : undefined;
			if (!eq) return void this.errors.push(`action 0x${id.toString(16)}`);
			eq.saved.set(22 + d[1]!, { preGain: [...eq.preGain], bands: copy(eq.bands) });
			eq.preset = 22 + d[1]!;
			return;
		}
		const group = ELEMENT_BASE.indexOf(id & 0xf0);
		const eq = command === 0x9004 ? this.#eq(group) : undefined;
		if (!eq) return void this.errors.push(`element 0x${id.toString(16)} in ${command}`);
		const b = new Bits(Uint8Array.from(d));
		const stored = eq.preset !== 255;
		this.#change(eq, id, b, d, group);
		if (this.lateNotifications && stored && eq.preset === 255) {
			this.#notifications.push(...element((id & 0xf0) + 3, [...this.presetBytes(group)]));
		}
	}

	#change(eq: FakeEq, id: number, b: Bits, d: number[], group: number) {
		switch (id & 15) {
			case 0: {
				b.get(4);
				eq.enable = b.get(1);
				b.get(11);
				eq.headroom = b.get(8, true);
				const preset = b.get(8);
				const saved = eq.saved.get(preset);
				if (preset !== eq.preset && saved) {
					eq.preGain = [...saved.preGain];
					eq.bands = copy(saved.bands);
				}
				eq.preset = preset;
				return;
			}
			case 2:
				eq.type = b.get(1);
				eq.impedance = b.get(14);
				return;
			case 3: {
				if (d.length !== [76, 256, 196][group])
					return void this.errors.push(`preset of ${d.length}`);
				eq.type = b.get(1);
				eq.impedance = b.get(14);
				b.at = 96;
				const gains = [b.get(16, true), b.get(16, true)];
				eq.preGain = eq.preGain.map((_, ch) => gains[ch]!);
				for (const ch of eq.bands) for (const x of ch) x.freq = b.get(16);
				for (const ch of eq.bands) {
					for (const x of ch) {
						x.filter = b.get(4);
						x.gain = b.get(10, true);
						x.q = b.get(16);
						b.get(2);
					}
				}
				eq.preset = 255;
				return;
			}
			case 4:
				if (d[0] !== group) this.errors.push(`a name for group ${d[0]} in group ${group}`);
				eq.names.set(d[1]!, utf8(d.slice(4, 4 + d[2]!)));
				return;
			case 5: {
				const mask = b.get(4);
				const filter = b.get(4);
				const index = b.get(8);
				const band = { filter, freq: b.get(16), gain: b.get(16, true), q: b.get(16) };
				const channels = eq.bands.length;
				if (mask === 0 || mask >= 1 << channels) {
					return void this.errors.push(`mask ${mask} on ${channels} channels`);
				}
				if (index >= eq.bands[0]!.length)
					return void this.errors.push(`band ${index} past the group's`);
				for (let ch = 0; ch < channels; ch++)
					if (mask & (1 << ch)) eq.bands[ch]![index] = { ...band };
				eq.preset = 255;
				return;
			}
		}
		this.errors.push(`element 0x${id.toString(16)}`);
	}
}
