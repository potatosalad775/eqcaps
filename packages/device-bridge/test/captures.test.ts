// Against devicePEQ's recorded device captures (D20, D33). For each capture the protocol is found
// the way an app finds it: the client matches the device to a profile, `protocolFor` gives the
// protocol. A pull replays the recorded answers and the decoded state is snapshotted, with what the
// draft profile says about it. The recorded writes are reference frames: decoding them and
// encoding the result gives the same band frames back.

import { matchDevice } from '@potatosalad775/eqcaps-client';
import { validate, type Filter, type Profile } from '@potatosalad775/eqcaps-core';
import { describe, expect, test } from 'vitest';
import { validateRepository } from '../../build/src/node.ts';
import {
	HANDLERS,
	identityOf,
	openDevice,
	protocolFor,
	type AnyHandler,
	type HidFrame,
	type Protocol,
	type PushRequest
} from '../src/index.ts';
import { loadCaptures, noSleep, recordedFrames, ReplayHid, type Capture } from './replay.ts';

const profiles = validateRepository().profiles;
const all = [...profiles.values()];

/** Captures recorded with another protocol than the one the device's profile now has. */
const RECORDED_WITH: Record<string, Protocol> = {
	// devicePEQ drove the Marigold with its Walkplay handler when this was recorded.
	'walkplay_default_moondrop_marigold.json': { handler: 'walkplay-hid' }
};

function setup(capture: Capture) {
	const transport = new ReplayHid(capture);
	const best = matchDevice(all, identityOf(transport)).best;
	const profile = best ? (profiles.get(best.id) as Profile) : undefined;
	const protocol = RECORDED_WITH[capture.file] ?? (best ? protocolFor(best.id) : undefined);
	return { transport, profile, protocol };
}

/** The band frames of a write, and the key that tells two writes of one band apart. */
const BANDS: Partial<Record<Protocol['handler'], (f: HidFrame) => number | undefined>> = {
	'fiio-usb-hid': ({ data: d }) => (d[0] === 0xaa && d[4] === 0x15 ? d[6] : undefined),
	'walkplay-hid': ({ data: d }) => (d[0] === 0x01 && d[1] === 0x09 ? d[4] : undefined),
	'ktmicro-usb-hid': ({ data: d }) => (d[4] === 0x57 ? d[0] : undefined),
	'fosi-audio-usb-hid': (f) => (f.feature && f.data[1] === 0x8d ? f.data[3] : undefined)
};

/** The frames of the first write: some captures hold two, the second rewriting the same bands. */
function firstWrite(frames: HidFrame[], key: (f: HidFrame) => number | undefined): HidFrame[] {
	const seen = new Set<number>();
	const end = frames.findIndex((f) => {
		const k = key(f);
		if (k === undefined) return false;
		if (seen.has(k)) return true;
		seen.add(k);
		return false;
	});
	return end < 0 ? frames : frames.slice(0, end);
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Walkplay's coefficients were computed from the app's two-decimal values, which the metadata
 * keeps to 1/256: round back to two decimals. Its shelf captures predate upstream's shelf fix and
 * carry peaking coefficients, so for shelves only the metadata is compared.
 */
function comparable(handler: string, frames: HidFrame[]): number[][] {
	return frames.map(({ data }) => {
		const d = [...data];
		const shelf = d[33] === 1 || d[33] === 3;
		return handler === 'walkplay-hid' && shelf ? [...d.slice(0, 7), ...d.slice(27)] : d;
	});
}

describe.each(loadCaptures().map((c) => [c.file, c] as const))('%s', (_file, capture) => {
	test('the device has a profile and a protocol', () => {
		const { profile, protocol } = setup(capture);
		expect(profile?.id).toBeDefined();
		expect(protocol?.handler).toBeDefined();
	});

	test('pull decodes the recorded answers', async () => {
		const { transport, profile, protocol } = setup(capture);
		const device = openDevice(transport, protocol!, { sleep: noSleep, profile: profile! });
		const result = await device.pull();
		expect(transport.unmatched).toEqual([]);
		// Values the device holds that its draft profile doesn't allow are findings about the
		// data, kept visible here.
		const findings = validate(profile!, result.filters, result.preamp);
		expect({ protocol: protocol!.handler, ...result, findings }).toMatchSnapshot();
	});

	test('recorded writes re-encode to the same band frames', () => {
		const { protocol } = setup(capture);
		const key = BANDS[protocol!.handler]!;
		const codec = (HANDLERS[protocol!.handler] as AnyHandler).codec;
		const options = protocol!.options ?? {};
		const recorded = firstWrite(recordedFrames(capture), key);
		const state = codec.decode(recorded, options);
		if (state.filters.length === 0) return; // the capture holds no write
		const walkplay = protocol!.handler === 'walkplay-hid';
		const filters = state.filters.map((f: Filter | null) =>
			walkplay ? { ...f!, q: round2(f!.q), gain: round2(f!.gain) } : f!
		);
		const request: PushRequest = { filters };
		if (state.preamp !== undefined) request.preamp = state.preamp;
		if (state.slot !== undefined) request.slot = state.slot;
		const bands = (frames: HidFrame[]) =>
			comparable(
				protocol!.handler,
				frames.filter((f) => key(f) !== undefined)
			);
		expect(bands(codec.encode(request, options))).toEqual(bands(recorded));
	});
});
