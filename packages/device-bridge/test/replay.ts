// Replays recorded device captures (devicePEQ's tests/captures/, 0BSD, at 0617f38, and this
// repository's own, which say so in their `_comment`) as HID transports: a send that matches a
// recorded one (null bytes are wildcards) gets that exchange's recorded answers. FiiO captures
// recorded concurrent requests, so their answers don't line up with the sends: they form a pool,
// and a request gets the first unused answer to the same command (and band). Qudelix's second
// protocol (the 5K Plus): a request no exchange matches is answered from the elements the replay
// has delivered so far (`QudelixElements`).

import { readdirSync, readFileSync } from 'node:fs';
import type { HidCollectionInfo, HidFrame, HidTransport } from '../src/index.ts';

type Bytes = (number | null)[];

export interface Answer {
	reportId?: number;
	data: number[];
}

export interface Exchange {
	send: { reportId?: number | null; data?: Bytes } | Bytes;
	responses?: Answer[];
	featureReport?: boolean;
}

export interface Capture {
	file: string;
	_comment?: string;
	device: {
		vendorId?: number;
		productId?: number;
		productName: string;
		/** The HID descriptor, where a handler reads its reports from it (Qudelix). */
		collections?: HidCollectionInfo[];
	};
	exchanges?: Exchange[];
	/** FiiO: answers to GET requests, matched by command and band. */
	sequence?: Answer[];
}

const dir = new URL('./captures/', import.meta.url);

export function loadCaptures(): Capture[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith('.json'))
		.sort()
		.map(
			(file) =>
				({ file, ...(JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as object) }) as Capture
		);
}

const sendOf = (e: Exchange) => (Array.isArray(e.send) ? { data: e.send } : e.send);

function matches(pattern: Bytes | undefined, bytes: number[]): boolean {
	if (!pattern) return true;
	return pattern.length === bytes.length && pattern.every((b, i) => b === null || b === bytes[i]);
}

/** Every send of the capture, in recorded order, as HID frames. */
export const recordedFrames = (c: Capture): HidFrame[] =>
	(c.exchanges ?? []).map((e) => {
		const s = sendOf(e);
		return {
			reportId: s.reportId ?? 0,
			...(e.featureReport ? { feature: true as const } : {}),
			data: Uint8Array.from((s.data ?? []).map((b) => b ?? 0))
		};
	});

/** A FiiO answer to `request`: same command, and for a band, same index. */
const isFiio = (d: ArrayLike<number | null>) => d[0] === 0xbb && d[1] === 0x0b;
const answers = (request: number[], answer: number[]) =>
	isFiio(request) &&
	isFiio(answer) &&
	answer[4] === request[4] &&
	(request[4] !== 0x15 || answer[6] === request[6]);

/**
 * Qudelix's second protocol on vendor id 0x0a12's framing: in, [n, command u16 BE, header, slice…];
 * out, [n + 1, 0x80, …]. A message is elements [id, words, data], in fragments, the header's 0x80
 * on the last. Keeps the latest copy of each element in the messages the replay delivers: the
 * opening answer (0x9000), answers (0x9003) and notifications (0x9005), in the order it delivers
 * them. A request (0x9002) [id, 0]… for elements it holds gets them as an answer, its data byte for
 * byte as the device sent it; only the framing is made here, in the device's packets (element 2's
 * packet size) on the report its answers came on, zero-padded to that report's recorded length.
 */
class QudelixElements {
	readonly #held = new Map<number, number[]>();
	#message: number[] = [];
	#report: Answer | undefined;

	/** Takes in an input report the replay delivers. */
	heard(answer: Answer) {
		const d = answer.data;
		const command = (d[1]! << 8) | d[2]!;
		if (command !== 0x9000 && command !== 0x9003 && command !== 0x9005) return;
		this.#report = answer;
		const header = d[3]!;
		if ((header & 0x1f) === 0) this.#message = [];
		this.#message.push(...d.slice(4, d[0]! + 1));
		if (!(header & 0x80)) return;
		const m = this.#message;
		for (let at = 0; at + 2 <= m.length;) {
			const end = at + 2 + m[at + 1]! * 4;
			if (end > m.length) break;
			this.#held.set(m[at]!, m.slice(at + 2, end));
			at = end;
		}
	}

	/** The answer to the output report `d`: none but to a request for elements held. */
	answer(d: number[]): Answer[] | undefined {
		if (d[1] !== 0x80 || d[2] !== 0x90 || d[3] !== 0x02 || d[4] !== 0x80) return undefined;
		const request = d.slice(5, d[0]! + 1);
		const ids = request.filter((_, i) => i % 2 === 0);
		const packetSize = this.#held.get(2)?.[3];
		const report = this.#report;
		if (!report || !packetSize || request.some((b, i) => i % 2 === 1 && b !== 0)) return undefined;
		if (!ids.length || !ids.every((id) => this.#held.has(id))) return undefined;
		const message = ids.flatMap((id) => {
			const data = this.#held.get(id)!;
			return [id, data.length / 4, ...data];
		});
		const out: Answer[] = [];
		for (let at = 0, id = 0; at < message.length; id++) {
			const slice = message.slice(at, at + packetSize - 1);
			at += slice.length;
			const packet = [0x90, 0x03, id | (at >= message.length ? 0x80 : 0), ...slice];
			const padding = new Array<number>(report.data.length - packet.length - 1).fill(0);
			out.push({ reportId: report.reportId ?? 0, data: [packet.length, ...packet, ...padding] });
		}
		return out;
	}
}

export class ReplayHid implements HidTransport {
	readonly kind = 'hid' as const;
	readonly vendorId: number;
	readonly productId: number;
	readonly productName: string;
	readonly collections: HidTransport['collections'];
	readonly unmatched: HidFrame[] = [];
	private readonly listeners = new Set<(reportId: number, data: Uint8Array) => void>();
	private readonly pool: Answer[];
	private readonly featureQueue: Answer[] = [];
	private readonly capture: Capture;
	private readonly qudelix: QudelixElements | undefined;

	constructor(capture: Capture) {
		this.capture = capture;
		this.vendorId = capture.device.vendorId ?? 0;
		this.productId = capture.device.productId ?? 0;
		this.productName = capture.device.productName;
		this.collections = capture.device.collections ?? [];
		const exchanges = (capture.exchanges ?? []).filter((e) => isFiio(sendOf(e).data ?? []));
		this.pool = [...(capture.sequence ?? []), ...exchanges.flatMap((e) => e.responses ?? [])];
		this.qudelix = this.vendorId === 0x0a12 ? new QudelixElements() : undefined;
	}

	private find(reportId: number, bytes: number[], feature: boolean) {
		return (this.capture.exchanges ?? []).find((e) => {
			if (!!e.featureReport !== feature) return false;
			const s = sendOf(e);
			if (s.reportId != null && s.reportId !== reportId) return false;
			return matches(s.data, bytes);
		});
	}

	private fire(answer: Answer) {
		this.qudelix?.heard(answer);
		// Asynchronously, like a device.
		void Promise.resolve().then(() => {
			for (const l of [...this.listeners]) l(answer.reportId ?? 0, Uint8Array.from(answer.data));
		});
	}

	async sendReport(reportId: number, data: Uint8Array) {
		const bytes = [...data];
		if (isFiio(bytes)) {
			const i = this.pool.findIndex((a) => answers(bytes, a.data));
			if (i >= 0) return this.fire(this.pool.splice(i, 1)[0]!);
			return void this.unmatched.push({ reportId, data });
		}
		const exchange = this.find(reportId, bytes, false);
		const responses = exchange ? (exchange.responses ?? []) : this.qudelix?.answer(bytes);
		if (!responses) return void this.unmatched.push({ reportId, data });
		for (const r of responses) this.fire(r);
	}

	async sendFeatureReport(reportId: number, data: Uint8Array) {
		const exchange = this.find(reportId, [...data], true);
		if (!exchange) this.unmatched.push({ reportId, feature: true, data });
		this.featureQueue.push(...(exchange?.responses ?? []));
	}

	async receiveFeatureReport() {
		const answer = this.featureQueue.shift();
		return answer ? Uint8Array.from(answer.data) : new Uint8Array(64);
	}

	onInputReport(listener: (reportId: number, data: Uint8Array) => void) {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}

	async close() {}
}

export const noSleep = () => Promise.resolve();
