// The consumer recipe end to end, for every device with a protocol: fit what the user wants to
// the profile, complete the bands, push. Whatever fit produces, the codec must be able to write;
// a failure is a mismatch between the data and the protocol.

import { complete, fit, type Filter, type Profile } from '@potatosalad775/eqcaps-core';
import { describe, expect, test } from 'vitest';
import {
	HANDLERS,
	openDevice,
	transportsOf,
	type HidTransport,
	type StreamTransport
} from '../src/index.ts';
import { profiles, PROTOCOLS } from './data.ts';
import { noSleep } from './replay.ts';

const WANTED: Filter[] = [
	{ type: 'LSC', freq: 105, q: 0.7, gain: 3 },
	{ type: 'PK', freq: 1000, q: 1.41, gain: -2.5 },
	{ type: 'PK', freq: 3150, q: 4, gain: 1.75 },
	{ type: 'HSC', freq: 9000, q: 0.7, gain: -4 }
];

/** A HID device that echoes every report back as an input report (enough for KT Micro's acks). */
function hidSink(): HidTransport & { count: number } {
	const listeners = new Set<(id: number, d: Uint8Array) => void>();
	return {
		kind: 'hid',
		vendorId: 0,
		productId: 0,
		productName: '',
		collections: [
			{
				usagePage: 0xff00,
				usage: 1,
				inputReports: [],
				outputReports: [{ reportId: 8, size: 63 }],
				featureReports: [],
				children: []
			}
		],
		count: 0,
		async sendReport(id, data) {
			this.count++;
			queueMicrotask(() => listeners.forEach((l) => l(id, data)));
		},
		async sendFeatureReport() {
			this.count++;
		},
		receiveFeatureReport: async () => new Uint8Array(63),
		onInputReport(l) {
			listeners.add(l);
			return () => void listeners.delete(l);
		},
		close: async () => {}
	};
}

/** A stream device that echoes each write, or answers JSON requests with success. */
function streamSink(kind: 'serial' | 'ble'): StreamTransport & { count: number } {
	const queue: Uint8Array[] = [];
	return {
		kind,
		count: 0,
		async write(data) {
			this.count++;
			const json = data[0] === 0x7b; // '{'
			queue.push(json ? Uint8Array.from(Buffer.from('{"Status":true}\0')) : data);
		},
		read: async () => queue.shift() ?? null,
		close: async () => {}
	};
}

describe.each(Object.entries(PROTOCOLS))('%s', (profileId, protocol) => {
	test('fit → complete → push writes without a codec error', async () => {
		const profile = profiles.get(profileId) as Profile;
		const result = fit(profile, WANTED, -4);
		const { filters } = complete(profile, result.slots);
		const kind = transportsOf(HANDLERS[protocol.handler])[0]!;
		const transport = kind === 'hid' ? hidSink() : streamSink(kind);
		const device = openDevice(transport, protocol, { sleep: noSleep });
		const preamp = profile.preamp.mode === 'manual' ? result.preamp : undefined;
		await device.push({ filters, ...(preamp === undefined ? {} : { preamp }) });
		expect(transport.count).toBeGreaterThan(0);
	});
});
