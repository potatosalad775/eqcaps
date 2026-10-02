// Replays devicePEQ's recorded device captures (tests/captures/, 0BSD, at 0617f38) as HID
// transports: a send that matches a recorded one (null bytes are wildcards) gets that exchange's
// recorded answers. FiiO captures recorded concurrent requests, so their answers don't line up
// with the sends: they form a pool, and a request gets the first unused answer to the same
// command (and band).

import { readdirSync, readFileSync } from 'node:fs';
import type { HidFrame, HidTransport } from '../src/index.ts';

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
	device: { vendorId?: number; productId?: number; productName: string };
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

	constructor(capture: Capture) {
		this.capture = capture;
		this.vendorId = capture.device.vendorId ?? 0;
		this.productId = capture.device.productId ?? 0;
		this.productName = capture.device.productName;
		this.collections = [];
		const exchanges = (capture.exchanges ?? []).filter((e) => isFiio(sendOf(e).data ?? []));
		this.pool = [...(capture.sequence ?? []), ...exchanges.flatMap((e) => e.responses ?? [])];
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
		if (!exchange) this.unmatched.push({ reportId, data });
		for (const r of exchange?.responses ?? []) this.fire(r);
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
