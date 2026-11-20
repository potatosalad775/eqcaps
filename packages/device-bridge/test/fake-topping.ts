// A Topping DAC as Topping's web app (home.toppingaudio.com) talks to it, simulated from what the
// app sends and expects back, for handler tests. Every message is a 16-byte output report; an
// answer is an input report in the same layout, delivered after the request returns.

import type { Filter } from '@potatosalad775/eqcaps-core';
import {
	parseToppingFrame,
	toppingFrame,
	toppingPreampWord,
	type ToppingFamily
} from '../src/handlers/topping-usb-hid.ts';
import type { HidTransport } from '../src/index.ts';

const READ = 0x10;
const WRITE = 0x20;

const UPLOAD = 0x1106;
const SWITCH_CONFIG = 0x110e;
const AGREEMENT = 0x1120;
const SOFTWARE_VERSION = 0x1202;
const EQ_ENABLE_STATE = 0x1204;
const CURRENT_CONFIG = 0x1206;
const GET_SETTINGS = 0x710c;
const PEQ_STATE = 0x7132;
const D900_CAPABILITIES = 0x7144;
const D900_RESULT = 0x7145;
const CONNECT_STATE = 0x1101;

export const NO_CONFIG = 0xffffffff;

const NAMES: Record<ToppingFamily, string> = {
	dx1: 'DX1 II',
	dx5: 'DX5 II',
	e50: 'E50 II',
	dx9d: 'DX9 Discrete',
	d900: 'D900'
};

/** Settings answer: its length and the words holding firmware, active config and EQ switch. */
const SETTINGS: Partial<
	Record<ToppingFamily, { length: number; fw: number; slot: number; on?: number }>
> = {
	e50: { length: 49, fw: 31, slot: 14 },
	dx9d: { length: 56, fw: 46, slot: 55, on: 54 },
	d900: { length: 51, fw: 49, slot: 48, on: 47 }
};

/** The DX5 II's settings block as observed (firmware 2.58), 52 words. */
export const DX5_SETTINGS = [
	1, 540366916, 18761, 0, 0, 0, 0, 0, 0, 60, 0, 0, 3, 0, 2, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1,
	1, 0, 15, 7, 0, 0, 1, 1, 1, 1, 0, 0, 6, 9, 2, 1, 1, 600, 600, 257, 0, 0, 0, 0
];

/** The words of that block (volume, mute, input, output, gain and so on) by the command that writes each. */
export const DX5_WORDS: Readonly<Record<number, number>> = {
	0x7102: 9,
	0x7103: 10,
	0x7104: 11,
	0x7105: 12,
	0x710a: 25,
	0x710d: 18,
	0x710e: 19,
	0x7116: 17,
	0x7117: 13,
	0x711d: 33,
	0x712b: 42
};

const TYPE_CODES: Record<string, number> = { PK: 1, LPQ: 2, HPQ: 3, LSC: 4, HSC: 5 };

/** Words of one band: switch and type and gain in tenths, frequency, Q in ten-thousandths. */
function bandWords(f: Filter | null): number[] {
	if (!f) return [1 << 8, 632, 7070];
	return [
		1 | (TYPE_CODES[f.type]! << 8) | ((Math.round(f.gain * 10) & 0xff) << 16),
		f.freq,
		Math.round(f.q * 10000)
	];
}

/**
 * A stored config of 78 words: the name (words 0-3), the pre-gain of each channel (words 5 and 7,
 * linear with 0 dB at 2^25), 11 left bands from word 8 and 11 right ones from word 41, three words
 * each. Missing bands are switched off; the right channel defaults to the left's bands.
 */
export function toppingConfig(
	name: string,
	preamp: number,
	left: readonly (Filter | null)[],
	right: readonly (Filter | null)[] = left
): number[] {
	const w = new Array<number>(78).fill(0);
	for (let i = 0; i < 4; i++) {
		w[i] = [...name.padEnd(16, '\0').slice(i * 4, i * 4 + 4)].reduce(
			(a, c) => (a << 8) | c.charCodeAt(0),
			0
		);
	}
	const gain = toppingPreampWord(preamp);
	w[4] = 1;
	w[5] = gain;
	w[6] = 1;
	w[7] = gain;
	for (let i = 0; i < 11; i++) {
		w.splice(8 + 3 * i, 3, ...bandWords(left[i] ?? null));
		w.splice(41 + 3 * i, 3, ...bandWords(right[i] ?? null));
	}
	return w;
}

export interface ToppingSent {
	command: number;
	data: number;
	kind: number;
	frames: number;
	frame: number;
}

/**
 * Answers what the handler asks for as its family does. A single word comes as one frame, a longer
 * answer as `frames` reports numbered from 0. Answers reach the listeners that are subscribed when
 * they arrive.
 */
export class FakeTopping implements HidTransport {
	readonly kind = 'hid' as const;
	readonly vendorId = 0x152a;
	readonly productId = 0x8750;
	readonly productName: string;
	readonly collections = [];
	readonly family: ToppingFamily;
	/** Every request, as it was sent. */
	readonly sent: ToppingSent[] = [];
	/** The stored configs, 78 words each. */
	configs: number[][] = [0, 1, 2].map((i) => toppingConfig(`Config ${i + 1}`, 0, []));
	active = 0;
	eqOn = true;
	/** The firmware word: 0x239 is version 2.39. */
	firmware = 0x239;
	/** The DX5 II's settings block, 52 words. */
	dx5Settings = [...DX5_SETTINGS];
	/** The status the D900 reports for an EQ switch write; 0 is done. */
	eqResultStatus = 0;
	/** The D900's capabilities answer. */
	capabilities = [2, 255, 7, 10, 10, 30, 0x1f0, 0, 74, 78, 74, 10];
	/** How many connection requests the D900 answers with 0 before it grants one. */
	connectDenials = 0;
	/** Delivers answers with one byte in front of the frame, as some platforms do. */
	prefixed = false;
	/** Requests so far. */
	get count() {
		return this.sent.length;
	}
	private readonly listeners = new Set<(reportId: number, data: Uint8Array) => void>();

	constructor(family: ToppingFamily) {
		this.family = family;
		this.productName = NAMES[family];
	}

	private deliver(frames: Uint8Array[]) {
		queueMicrotask(() => {
			for (const f of frames) {
				const data = this.prefixed ? Uint8Array.from([0, ...f]) : f;
				for (const l of [...this.listeners]) l(0, data);
			}
		});
	}

	/** An answer of `words` to `command`: one frame for one word, else one per word. */
	private answer(command: number, words: readonly number[], frame: number) {
		this.deliver(
			words.length === 1
				? [toppingFrame(command, words[0]!, READ, 1, frame)]
				: words.map((w, i) => toppingFrame(command, w, READ, words.length, i))
		);
	}

	private list() {
		const out = [
			toppingFrame(UPLOAD, this.configs.length, READ, 2, 0),
			// A DX5 II (firmware 2.58) sends 1414546522 here whatever config is active.
			toppingFrame(UPLOAD, this.family === 'dx5' ? 1414546522 : this.active, READ, 2, 1)
		];
		for (const c of this.configs) {
			c.forEach((w, i) => out.push(toppingFrame(UPLOAD, w, READ, c.length, i)));
		}
		this.deliver(out);
	}

	private settings() {
		if (this.family === 'dx5') {
			const n = this.dx5Settings.length;
			return this.deliver(
				this.dx5Settings.map((w, i) => toppingFrame(GET_SETTINGS, w, WRITE, n, i))
			);
		}
		const s = SETTINGS[this.family];
		if (!s) return;
		const w = new Array<number>(s.length).fill(0);
		w[s.fw] = this.firmware;
		w[s.slot] = this.active;
		if (s.on !== undefined) w[s.on] = this.eqOn ? 1 : 0;
		this.answer(GET_SETTINGS, w, 0);
	}

	/** A band or pre-gain write lands in the active config's words. */
	private param(command: number, data: number) {
		const config = this.configs[this.active];
		if (!config) return;
		const band = (command >> 8) & 0xf;
		const field = command & 0xff;
		if (band === 0xc) {
			const at = [0, 5, 4, 7, 6][field];
			if (at) config[at] = data;
			return;
		}
		if (band < 1 || band > 11 || field < 1 || field > 10) return;
		const base = (field <= 5 ? 8 : 41) + 3 * (band - 1);
		const f = (field - 1) % 5;
		if (f === 1 || f === 3) {
			config[base + (f === 1 ? 1 : 2)] = data;
			return;
		}
		let on = config[base]! & 0xff;
		let type = (config[base]! >> 8) & 0xff;
		let gain = (config[base]! >> 16) & 0xff;
		if (f === 0) type = data & 0xff;
		else if (f === 2) gain = data & 0xff;
		else on = data & 0xff;
		config[base] = on | (type << 8) | (gain << 16);
	}

	private handle(d: Uint8Array) {
		const f = parseToppingFrame(d);
		if (!f) return;
		const { command: c, data: v, kind } = f;
		this.sent.push({ command: c, data: v, kind, frames: f.frames, frame: f.frame });
		const d900 = this.family === 'd900';
		const frame = d900 ? 0 : 1;
		const list =
			(c === UPLOAD && (kind === READ || (kind === WRITE && d900))) ||
			(c === AGREEMENT && kind === WRITE && (this.family === 'dx5' || this.family === 'dx9d'));
		if (list) return this.list();
		if (c === SWITCH_CONFIG) {
			if (v === NO_CONFIG) {
				if (this.family === 'dx1' || this.family === 'e50') this.eqOn = false;
			} else if (v < this.configs.length) {
				this.active = v;
				if (this.family === 'dx1' || this.family === 'e50') this.eqOn = true;
			}
			return;
		}
		const word = this.family === 'dx5' && kind === WRITE ? DX5_WORDS[c] : undefined;
		if (word !== undefined) {
			this.dx5Settings[word] = v;
			return this.deliver([toppingFrame(c, v, WRITE, 1, 0)]);
		}
		if (c >> 12 === 9 && kind === WRITE) return this.param(c, v);
		if (c === SOFTWARE_VERSION && kind === READ) return this.answer(c, [this.firmware], frame);
		if (c === EQ_ENABLE_STATE && kind === READ) return this.answer(c, [this.eqOn ? 1 : 0], frame);
		if (c === CURRENT_CONFIG && kind === READ) return this.answer(c, [this.active], frame);
		if (c === GET_SETTINGS) return this.settings();
		// A DX5 II (firmware 2.58) answers a read of its switch as a write, numbered 0 of 1.
		if (c === PEQ_STATE && kind === READ && this.family === 'dx5') {
			return this.deliver([toppingFrame(c, this.eqOn ? 1 : 0, WRITE, 1, 0)]);
		}
		if (c === PEQ_STATE && kind === WRITE) {
			this.eqOn = v !== 0;
			if (d900) this.answer(D900_RESULT, [PEQ_STATE, this.eqResultStatus, v], 0);
			return;
		}
		if (!d900) return;
		if (c === D900_CAPABILITIES) return this.answer(c, this.capabilities, 0);
		if (c === CONNECT_STATE && kind === WRITE) {
			const granted = this.connectDenials > 0 ? 0 : 1;
			if (!granted) this.connectDenials--;
			this.answer(c, [granted], 0);
		}
	}

	async sendReport(reportId: number, data: Uint8Array) {
		if (reportId === 0) this.handle(data);
	}
	async sendFeatureReport() {}
	async receiveFeatureReport() {
		return new Uint8Array(0);
	}
	onInputReport(listener: (reportId: number, data: Uint8Array) => void) {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}
	async close() {}
}
