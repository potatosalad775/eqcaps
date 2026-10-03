// Request/response helpers shared by handlers.

import type { FilterType } from '@potatosalad775/eqcaps-core';
import { BridgeError } from './errors.ts';
import { after } from './platform.ts';
import type { HidFrame, PushRequest } from './handler.ts';
import type { HidTransport, StreamTransport } from './transport.ts';

/**
 * Waits for the first input report that `match` accepts. Subscribe before sending the request,
 * so a fast answer can't be missed.
 */
export function waitForInput(
	transport: HidTransport,
	match: (data: Uint8Array, reportId: number) => boolean,
	timeoutMs: number,
	what: string
): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const cancel = after(timeoutMs, () => {
			unsubscribe();
			reject(new BridgeError('timeout', `No answer to ${what} within ${timeoutMs} ms`));
		});
		const unsubscribe = transport.onInputReport((reportId, data) => {
			if (!match(data, reportId)) return;
			cancel();
			unsubscribe();
			resolve(data);
		});
	});
}

/** Sends an output report and waits for the matching input report. */
export async function hidRequest(
	transport: HidTransport,
	reportId: number,
	data: Uint8Array | number[],
	match: (data: Uint8Array, reportId: number) => boolean,
	timeoutMs: number,
	what: string
): Promise<Uint8Array> {
	const answer = waitForInput(transport, match, timeoutMs, what);
	// Keeps a send failure from leaving the wait's rejection unhandled.
	answer.catch(() => {});
	await transport.sendReport(reportId, Uint8Array.from(data));
	return answer;
}

/**
 * Reads a byte stream into a buffer until `frame` finds a complete frame in it. `frame` returns
 * the frame's [start, end) or null while incomplete. Bytes after the frame stay in the buffer for
 * the next call.
 */
export class StreamReader {
	private buffer: number[] = [];
	private readonly transport: StreamTransport;

	constructor(transport: StreamTransport) {
		this.transport = transport;
	}

	async readFrame(
		frame: (buffer: readonly number[]) => [number, number] | null,
		timeoutMs: number,
		what: string,
		now: () => number = Date.now
	): Promise<Uint8Array> {
		const deadline = now() + timeoutMs;
		for (;;) {
			const found = frame(this.buffer);
			if (found) {
				const [start, end] = found;
				const bytes = Uint8Array.from(this.buffer.slice(start, end));
				this.buffer = this.buffer.slice(end);
				return bytes;
			}
			const remaining = deadline - now();
			if (remaining <= 0) break;
			const chunk = await this.transport.read(remaining);
			if (!chunk) break;
			for (const b of chunk) this.buffer.push(b);
		}
		throw new BridgeError('timeout', `No complete answer to ${what} within ${timeoutMs} ms`);
	}

	/**
	 * Writes a request after dropping every byte received so far, buffered here or still queued in
	 * the transport: a late answer to an earlier request can't be taken for this one's.
	 */
	async send(data: Uint8Array) {
		this.buffer = [];
		// Bounded, so a device that never stops sending can't stall the request.
		for (let i = 0; i < 64 && (await this.transport.read(0)); i++);
		await this.transport.write(data);
	}
}

/**
 * Filter type ↔ wire code table of one protocol. A numeric code without a known meaning decodes
 * as the extension type `x-wire-<code>`, and that type encodes back to the same code, so a pull
 * never hides what the device holds (D33).
 */
export interface TypeCodes {
	types: FilterType[];
	encode(type: FilterType): number;
	decode(code: number): FilterType;
}

const WIRE = /^x-wire-(\d+)$/;

export function typeCodes(
	handler: string,
	table: Partial<Record<FilterType, number>>,
	aliases: [number, FilterType][] = []
): TypeCodes {
	const entries = Object.entries(table) as [FilterType, number][];
	return {
		types: entries.map(([t]) => t),
		encode(type) {
			const code = table[type] ?? (WIRE.test(type) ? Number(WIRE.exec(type)![1]) : undefined);
			if (code === undefined) {
				throw new BridgeError('unsupported-type', `${handler} has no wire code for type ${type}`);
			}
			return code;
		},
		decode(code) {
			return (
				entries.find(([, c]) => c === code)?.[0] ??
				aliases.find(([c]) => c === code)?.[1] ??
				`x-wire-${code}`
			);
		}
	};
}

/**
 * Refuses the request fields a protocol's write doesn't carry. Dropped silently, a preamp or slot
 * would look applied (D33).
 */
export function refuseUncarried(
	handler: string,
	request: PushRequest,
	carries: { preamp?: boolean; slot?: boolean }
) {
	if (request.preamp !== undefined && !carries.preamp) {
		throw new BridgeError('invalid-request', `${handler}: the write carries no preamp`);
	}
	if (request.slot !== undefined && !carries.slot) {
		throw new BridgeError('invalid-request', `${handler}: the write names no preset slot`);
	}
}

/** Round to a fixed number of decimals, for values decoded from scaled integers. */
export function decimals(value: number, places: number): number {
	const f = 10 ** places;
	return Math.round(value * f) / f;
}

export const hidFrame = (reportId: number, data: ArrayLike<number>, feature = false): HidFrame =>
	feature
		? { reportId, feature: true, data: Uint8Array.from(data) }
		: { reportId, data: Uint8Array.from(data) };

export function sendFrame(transport: HidTransport, frame: HidFrame): Promise<void> {
	return frame.feature
		? transport.sendFeatureReport(frame.reportId, frame.data)
		: transport.sendReport(frame.reportId, frame.data);
}
