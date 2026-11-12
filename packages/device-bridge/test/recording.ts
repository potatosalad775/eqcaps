// Recordings made with tools/userscripts/eqcaps-webhid-recorder.user.js: a vendor web app's WebHID
// traffic, with snapshots of what the app decoded from it. Kept in test/recordings/ and checked by
// recordings.test.ts against the handlers and the data.

import { readdirSync, readFileSync } from 'node:fs';
import { matchDevice } from '@potatosalad775/eqcaps-client';
import type { Profile } from '@potatosalad775/eqcaps-core';
import { identityOf, type HidTransport } from '../src/index.ts';

export interface RecordedDevice {
	vendorId: number;
	productId: number;
	productName: string;
	collections?: unknown[];
}

export interface RecordedEvent {
	/** Milliseconds since the recorder started. */
	t: number;
	/** Index into `devices`. */
	device: number;
	/** `output` and `feature-out` are sent; `feature-in` and `input` are answers. */
	op: 'output' | 'feature-out' | 'feature-in' | 'input';
	reportId: number;
	/** Hex. A `feature-in` holds what WebHID returned, report id first. Missing after an error. */
	data?: string;
	error?: string;
}

export interface Snapshot {
	t: number;
	label: string;
	/** The adapter that took it ("fosi-cc"), which says how to read `state`. */
	adapter: string;
	store?: string;
	state: unknown;
}

export interface Recording {
	file: string;
	recording: 'eqcaps-webhid';
	version: 1;
	recordedAt: string;
	page: { origin: string; path: string };
	notes?: string;
	devices: RecordedDevice[];
	snapshots: Snapshot[];
	events: RecordedEvent[];
}

const dir = new URL('./recordings/', import.meta.url);

export function loadRecordings(): Recording[] {
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith('.json'));
	} catch {
		return [];
	}
	return files
		.sort()
		.map(
			(file) =>
				({ file, ...(JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as object) }) as Recording
		);
}

export const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

/** A request and the answers recorded after it, before the next request. */
export interface Exchange {
	t: number;
	feature: boolean;
	reportId: number;
	request: Uint8Array;
	answers: Uint8Array[];
}

/** The requests sent to one device, each with the answers that followed it. */
export function exchangesOf(recording: { events: RecordedEvent[] }, device = 0): Exchange[] {
	const out: Exchange[] = [];
	for (const e of recording.events) {
		if (e.device !== device || e.data === undefined || e.error !== undefined) continue;
		if (e.op === 'output' || e.op === 'feature-out') {
			out.push({
				t: e.t,
				feature: e.op === 'feature-out',
				reportId: e.reportId,
				request: fromHex(e.data),
				answers: []
			});
		} else out.at(-1)?.answers.push(fromHex(e.data));
	}
	return out;
}

/**
 * The device a snapshot at `t` describes: the last one with traffic before it. A device that
 * reconnects (a DS3 switching USB modes) is a new device in the recording.
 */
export function deviceAt(recording: { events: RecordedEvent[] }, t: number): number {
	let device = 0;
	for (const e of recording.events) if (e.t <= t) device = e.device;
	return device;
}

/** A report is padded with zeros to its size, so trailing zeros don't tell requests apart. */
const key = (reportId: number, data: ArrayLike<number>) =>
	`${reportId}:${Array.from(data, (b) => b.toString(16).padStart(2, '0'))
		.join('')
		.replace(/(00)+$/, '')}`;

/**
 * Replays a recording to a handler as the device it recorded. A request gets the last answer
 * recorded for the same bytes up to `until`: the device's state as the app saw it then. Output
 * and feature requests are one. The answer comes back on the feature report, and as an input
 * report to whoever listens (Walkplay devices answer that way); a request never recorded is
 * answered with zeros on the feature report and not at all on input.
 */
export class RecordingReplay implements HidTransport {
	readonly kind = 'hid' as const;
	readonly vendorId: number;
	readonly productId: number;
	readonly productName: string;
	readonly collections = [];
	readonly unanswered: Uint8Array[] = [];
	private readonly answers = new Map<string, Uint8Array>();
	private readonly listeners = new Set<(reportId: number, data: Uint8Array) => void>();
	private pending = new Uint8Array(64);

	constructor(recording: Recording, { device = 0, until = Infinity } = {}) {
		const d = recording.devices[device]!;
		this.vendorId = d.vendorId;
		this.productId = d.productId;
		this.productName = d.productName;
		for (const x of exchangesOf(recording, device)) {
			if (x.t <= until && x.answers.length) {
				this.answers.set(key(x.reportId, x.request), x.answers.at(-1)!);
			}
		}
	}

	private ask(reportId: number, data: Uint8Array) {
		const answer = this.answers.get(key(reportId, data));
		if (!answer) this.unanswered.push(Uint8Array.from(data));
		this.pending = answer ? Uint8Array.from(answer) : new Uint8Array(64);
		if (answer) for (const l of [...this.listeners]) l(reportId, Uint8Array.from(answer));
	}

	async sendReport(reportId: number, data: Uint8Array) {
		this.ask(reportId, data);
	}
	async sendFeatureReport(reportId: number, data: Uint8Array) {
		this.ask(reportId, data);
	}
	async receiveFeatureReport() {
		return this.pending;
	}
	onInputReport(listener: (reportId: number, data: Uint8Array) => void) {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}
	async close() {}
}

/** The profile an app would pick for the recorded device, given the firmware the app read. */
export function matchProfile(
	recording: Recording,
	firmware: string | undefined,
	profiles: Iterable<Profile>,
	device = 0
): Profile | string {
	const identity = identityOf(new RecordingReplay(recording, { device }));
	const result = matchDevice([...profiles], { ...identity, ...(firmware ? { firmware } : {}) });
	if (!result.best) {
		return result.ambiguous
			? `matches ${result.matches.map((m) => m.id).join(', ')} equally`
			: `no profile matches ${identity.usb?.productName} on firmware ${firmware}`;
	}
	return [...profiles].find((p) => p.id === result.best!.id)!;
}
