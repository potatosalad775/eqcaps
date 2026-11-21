// The consumer recipe end to end, for every EQ of every device with a protocol: plan what the
// user wants against the EQ's profile (core's `plan`: fit, then complete with what the device
// holds, for each channel it is written by), and push the plan. Whatever plan produces, the codec
// must be able to write; a failure is a mismatch between the data and the protocol.

import {
	eqProfile,
	plan,
	profileEqs,
	type Filter,
	type Profile
} from '@potatosalad775/eqcaps-core';
import { describe, expect, test } from 'vitest';
import {
	HANDLERS,
	openDevice,
	transportsOf,
	type HidTransport,
	type StreamTransport
} from '../src/index.ts';
import { profiles, PROTOCOLS } from './data.ts';
import { FakeQudelix, FakeQudelixV2 } from './fake-qudelix.ts';
import { FakeTopping } from './fake-topping.ts';
import type { ToppingFamily } from '../src/handlers/topping-usb-hid.ts';
import { noSleep } from './replay.ts';

const WANTED: Filter[] = [
	{ type: 'LSC', freq: 105, q: 0.7, gain: 3 },
	{ type: 'PK', freq: 1000, q: 1.41, gain: -2.5 },
	{ type: 'PK', freq: 3150, q: 4, gain: 1.75 },
	{ type: 'HSC', freq: 9000, q: 0.7, gain: -4 }
];
/** The right channel, where the EQ holds one apart: other bands, another preamp. */
const WANTED_RIGHT: Filter[] = [
	{ type: 'PK', freq: 60, q: 0.9, gain: 2 },
	{ type: 'PK', freq: 5000, q: 2, gain: -3.25 }
];
/** What the device held before, as a read would return it: the bands a write leaves keep these. */
const held = (bands: number, shift: number): Filter[] =>
	Array.from({ length: bands }, (_, i) => ({
		type: 'PK',
		freq: Math.round(40 * shift * 1.7 ** i),
		q: 1.2,
		gain: i % 2 ? -1 : 1
	}));

/**
 * A HID device that echoes every report back as an input report, with KT Micro's write flag in
 * byte 6 where the protocol names one, and answers the last one's command on the feature report
 * with zeros (enough for Fosi Audio).
 */
function hidSink(writeAck?: number): HidTransport & { count: number } {
	const listeners = new Set<(id: number, d: Uint8Array) => void>();
	let last = new Uint8Array(63);
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
			last = Uint8Array.from(data);
			const answer = Uint8Array.from(data);
			if (writeAck !== undefined) answer[6] = writeAck;
			// Moondrop's link check [0x80, 0x31, 0] is padded to the report size, so its echo would read
			// as "not linked" at byte 3: this device is linked.
			if (data[0] === 0x80 && data[1] === 0x31) answer[3] = 1;
			queueMicrotask(() => listeners.forEach((l) => l(id, answer)));
		},
		async sendFeatureReport(_id, data) {
			this.count++;
			last = Uint8Array.from(data);
		},
		async receiveFeatureReport() {
			const answer = new Uint8Array(63);
			answer.set(last.subarray(0, 2));
			return answer;
		},
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

/**
 * Qudelix devices answer an opening request that no echo can, so they get the fakes built from
 * the vendor app: the 5K Plus by its handler, the T71 by its vendor id, else the 5K.
 */
function qudelixFake(profile: Profile, handler: string) {
	if (handler === 'qudelix-v2-usb-hid') return new FakeQudelixV2();
	if (handler !== 'qudelix-usb-hid') return undefined;
	return new FakeQudelix(profile.match?.usb?.some((u) => u.vendorId === '0x1fc9') ? 't71' : '5k');
}

/** Topping's devices answer a session start and a config list that no echo can. */
function toppingFake(handler: string, options: unknown) {
	if (handler !== 'topping-usb-hid') return undefined;
	return new FakeTopping((options as { family?: ToppingFamily }).family ?? 'dx1');
}

describe.each(Object.entries(PROTOCOLS))('%s', (profileId, protocol) => {
	test('plan → push writes every EQ without a codec error', async () => {
		const profile = profiles.get(profileId) as Profile;
		const kind = transportsOf(HANDLERS[protocol.handler])[0]!;
		const { writeAck } = (protocol.options ?? {}) as { writeAck?: number };
		const transport =
			qudelixFake(profile, protocol.handler) ??
			toppingFake(protocol.handler, protocol.options ?? {}) ??
			(kind === 'hid' ? hidSink(writeAck) : streamSink(kind));
		const device = openDevice(transport, protocol, { sleep: noSleep });
		const driven = [undefined, ...device.capabilities.eqs.map((e) => e.id)];
		// Every EQ the data lists is one the handler drives (protocols.test.ts): none is skipped.
		expect(driven).toHaveLength(profileEqs(profile).length);

		for (const id of driven) {
			const view = device.eq(id);
			const eq = eqProfile(profile, id)!;
			const bands = eq.bandCount ?? 10;
			const planned = plan(
				eq,
				{ filters: WANTED, preamp: -4, right: { filters: WANTED_RIGHT, preamp: -2 } },
				{
					...view.capabilities,
					held: { filters: held(bands, 1), right: { filters: held(bands, 1.3) } }
				}
			);
			// The right channel goes out exactly where the data says the EQ holds one apart.
			expect(planned.write.right !== undefined, `${id ?? 'own'}: right`).toBe(
				eq.channels === 'independent'
			);
			const before = transport.count;
			await view.push(planned.write);
			expect(transport.count, `${id ?? 'own'}: frames`).toBeGreaterThan(before);
		}
	});
});
