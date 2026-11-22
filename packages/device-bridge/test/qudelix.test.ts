// The Qudelix handlers against fakes built from the reading of Qudelix's app for Chrome (4.0.3.1).
// No device answered these: they show the handlers agree with that reading (fake-qudelix.ts).
// The last block is the exception: a 5K's recorded answers (test/captures/).

import type { Filter } from '@potatosalad775/eqcaps-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { qudelixUsbHidCodec } from '../src/handlers/qudelix-usb-hid.ts';
import { qudelixV2UsbHidCodec } from '../src/handlers/qudelix-v2-usb-hid.ts';
import { QUDELIX_MODELS, T71 } from '../src/handlers/qudelix.ts';
import { openDevice, type BridgeDevice, type Protocol, type Transport } from '../src/index.ts';
import { protocolFor as dataProtocol } from './data.ts';
import { flatEq, FakeQudelix, FakeQudelixV2 } from './fake-qudelix.ts';
import { loadCaptures, noSleep, ReplayHid } from './replay.ts';

const pk = (freq: number, gain: number, q = 1): Filter => ({ type: 'PK', freq, gain, q });
const padded = (bytes: number[], size = 63) => [
	...bytes,
	...new Array<number>(size - bytes.length).fill(0)
];
/** The EQ a test's protocol was asked for: `open` then names it in every operation (SPEC §9.2). */
const chosen = new WeakMap<Protocol, string>();
const protocolFor = (
	handler: 'qudelix-usb-hid' | 'qudelix-v2-usb-hid',
	group?: 'usr' | 'spk'
): Protocol => {
	const protocol: Protocol = { handler, eqs: [{ id: 'spk', name: 'SPK EQ' }] };
	if (group === 'spk') chosen.set(protocol, group);
	return protocol;
};
const first = (group?: 'usr' | 'spk') => protocolFor('qudelix-usb-hid', group);
const open = (t: Transport, protocol: Protocol, log?: (m: string) => void): BridgeDevice =>
	openDevice(t, protocol, { sleep: noSleep, ...(log ? { log } : {}) }).eq(chosen.get(protocol));

/** The EQ writes, 0x07xx, as sent. */
const eqWrites = (fake: FakeQudelix) =>
	fake.sent.filter((_, i) => fake.commands()[i]! >> 8 === 0x07).map((f) => f.data);

/** Five filters on the wire grid, one of each type. */
const five: Filter[] = [
	pk(100, -3.5, 0.5),
	{ type: 'LSC', freq: 80, gain: 4.2, q: 0.75 },
	{ type: 'HSC', freq: 9000, gain: -2, q: 1 },
	{ type: 'LPQ', freq: 18000, gain: 0, q: 2 },
	{ type: 'HPQ', freq: 25, gain: 0, q: 0.6875 }
];

const flatFilters = (bands: number) =>
	flatEq(1, bands).bands[0]!.map((b) => ({ type: 'PK', freq: b.freq, gain: 0, q: b.q / 1024 }));

afterEach(() => {
	vi.useRealTimers();
});

describe("Qudelix 5K as Qudelix's app drives it", () => {
	test('opens with the app’s opening request, once per transport', async () => {
		const fake = new FakeQudelix('5k');
		const device = open(fake, first());
		await device.pull();
		await device.pull();
		expect(fake.sent[0]).toEqual({
			reportId: 8,
			data: padded([0x06, 0x80, 0x01, 0x00, 0x20, 0x00, 0x04])
		});
		expect(fake.commands().filter((c) => c === 0x0100)).toHaveLength(1);
	});

	test("a push writes the app's frames in its order: on, type, pre-gain, bands, name, save", async () => {
		const fake = new FakeQudelix('5k');
		await open(fake, first()).push({ filters: [pk(1000, -3, 0.7)], preamp: -2.5, slot: 22 });
		expect(eqWrites(fake)).toEqual(
			[
				[0x05, 0x80, 0x07, 0x00, 0x00, 0x01],
				[0x05, 0x80, 0x07, 0x01, 0x00, 0x01],
				[0x08, 0x80, 0x07, 0x03, 0x00, 0x01, 0x00, 0xff, 0xe7],
				[0x0d, 0x80, 0x07, 0x0f, 0x00, 0x01, 0x00, 0x05, 0x03, 0xe8, 0xff, 0xe2, 0x02, 0xcd],
				[0x06, 0x80, 0x07, 0x0a, 0x00, 0x00, 0x00],
				[0x05, 0x80, 0x07, 0x08, 0x00, 0x16]
			].map((f) => padded(f))
		);
		expect(fake.sent.every((f) => f.reportId === 8)).toBe(true);
		expect(fake.errors).toEqual([]);
	});

	test('push then pull gives back what was pushed, and the bands past it keep their values', async () => {
		const fake = new FakeQudelix('5k');
		const device = open(fake, first());
		await device.push({ filters: five, preamp: -3.5, slot: 23 });
		const back = await device.pull();
		expect(back.filters).toEqual([...five, ...flatFilters(10).slice(5)]);
		expect(back.preamp).toBe(-3.5);
		expect(back.slot).toBe(23);
		expect(await device.currentSlot()).toBe(23);
		expect(fake.eqs.get(0)!.names.get(1)).toBe('');
		expect(fake.errors).toEqual([]);
	});

	test('a push without a slot leaves the device on an edited EQ, which reads as no slot', async () => {
		const fake = new FakeQudelix('5k');
		const device = open(fake, first());
		await device.push({ filters: [pk(100, 1)] });
		expect((await device.pull()).slot).toBeUndefined();
		expect(await device.currentSlot()).toBeNull();
		expect(eqWrites(fake).map((f) => f[3])).toEqual([0x00, 0x01, 0x0f]);
	});

	test('the speaker EQ gets one frame for left and right, no type, and the user EQ is left alone', async () => {
		const fake = new FakeQudelix('5k');
		const spk = open(fake, first('spk'));
		await spk.push({ filters: [pk(1000, -3, 0.7)], preamp: -2 });
		expect(eqWrites(fake)).toEqual(
			[
				[0x05, 0x80, 0x07, 0x00, 0x01, 0x01],
				[0x08, 0x80, 0x07, 0x03, 0x01, 0x03, 0x00, 0xff, 0xec],
				[0x0d, 0x80, 0x07, 0x0f, 0x01, 0x03, 0x00, 0x05, 0x03, 0xe8, 0xff, 0xe2, 0x02, 0xcd]
			].map((f) => padded(f))
		);
		expect(fake.eqs.get(0)).toEqual(flatEq(1, 10));
		const back = await spk.pull();
		expect(back.filters[0]).toEqual(pk(1000, -3, 717 / 1024));
		expect(back.preamp).toBe(-2);
		expect(fake.errors).toEqual([]);
	});

	test('a push to the user EQ leaves the speaker EQ alone, and each pulls its own', async () => {
		const fake = new FakeQudelix('5k');
		await open(fake, first('spk')).push({ filters: [pk(200, 2)], preamp: -1 });
		const usr = open(fake, first('usr'));
		await usr.push({ filters: [pk(300, -4)], preamp: -6 });
		const spk = await open(fake, first('spk')).pull();
		expect(spk.filters[0]).toEqual(pk(200, 2));
		expect(spk.preamp).toBe(-1);
		const user = await usr.pull();
		expect(user.filters[0]).toEqual(pk(300, -4));
		expect(user.preamp).toBe(-6);
	});

	test('the speaker EQ pulls both channels, the right as `right`, equal or not', async () => {
		const fake = new FakeQudelix('5k');
		const log = vi.fn();
		const spk = open(fake, first('spk'), log);
		expect((await spk.pull()).right).toEqual({ filters: flatFilters(10), preamp: 0 });
		fake.eqs.get(1)!.bands[1]![3]!.gain = 25;
		fake.eqs.get(1)!.preGain[1] = -15;
		const back = await spk.pull();
		expect(back.filters).toEqual(flatFilters(10));
		expect(back.preamp).toBe(0);
		expect(back.right!.filters[3]).toEqual({ ...flatFilters(10)[3], gain: 2.5 });
		expect(back.right!.preamp).toBe(-1.5);
		expect(log).not.toHaveBeenCalled();
	});

	describe('the speaker EQ with its channels apart', () => {
		const L = [pk(1000, -3), pk(200, 2, 2)];
		const R = [pk(3000, 4, 0.5)];

		test('a push writes each channel its own frames, mask 1 the left and 2 the right, band by band', async () => {
			const fake = new FakeQudelix('5k');
			const spk = open(fake, first('spk'));
			expect(spk.capabilities.eqs.map((e) => [e.id, e.perChannel])).toEqual([['spk', true]]);
			await spk.push({ filters: L, preamp: -2, right: { filters: R, preamp: -1 } });
			expect(eqWrites(fake)).toEqual(
				[
					[0x05, 0x80, 0x07, 0x00, 0x01, 0x01],
					[0x08, 0x80, 0x07, 0x03, 0x01, 0x01, 0x00, 0xff, 0xec],
					[0x08, 0x80, 0x07, 0x03, 0x01, 0x02, 0x00, 0xff, 0xf6],
					[0x0d, 0x80, 0x07, 0x0f, 0x01, 0x01, 0x00, 0x05, 0x03, 0xe8, 0xff, 0xe2, 0x04, 0x00],
					[0x0d, 0x80, 0x07, 0x0f, 0x01, 0x02, 0x00, 0x05, 0x0b, 0xb8, 0x00, 0x28, 0x02, 0x00],
					[0x0d, 0x80, 0x07, 0x0f, 0x01, 0x01, 0x01, 0x05, 0x00, 0xc8, 0x00, 0x14, 0x08, 0x00]
				].map((f) => padded(f))
			);
			expect(await spk.pull()).toEqual({
				filters: [...L, ...flatFilters(10).slice(2)],
				preamp: -2,
				right: { filters: [...R, ...flatFilters(10).slice(1)], preamp: -1 }
			});
			expect(fake.eqs.get(0)).toEqual(flatEq(1, 10));
			expect(fake.errors).toEqual([]);
		});

		test("the right channel's pre-gain left out is the left one's", async () => {
			const fake = new FakeQudelix('5k');
			const spk = open(fake, first('spk'));
			await spk.push({ filters: L, preamp: -2, right: { filters: R } });
			expect((await spk.pull()).right!.preamp).toBe(-2);
			expect(fake.eqs.get(1)!.preGain).toEqual([-20, -20]);
		});

		test('each band frame waits for its own echo', async () => {
			const fake = new FakeQudelix('5k');
			const log = vi.fn();
			await open(fake, first('spk'), log).push({ filters: L, right: { filters: R } });
			expect(log).not.toHaveBeenCalled();
			expect(fake.errors).toEqual([]);
		});

		test('a right channel the EQ cannot hold is refused, and nothing is written', async () => {
			const fake = new FakeQudelix('5k');
			const spk = open(fake, first('spk'));
			await expect(
				spk.push({ filters: L, right: { filters: new Array(11).fill(pk(100, 0)) } })
			).rejects.toMatchObject({ code: 'invalid-request' });
			await expect(
				spk.push({ filters: L, right: { filters: [pk(70000, 1)] } })
			).rejects.toMatchObject({ code: 'unrepresentable' });
			expect(eqWrites(fake)).toEqual([]);
		});

		test('the user EQ, and the 20-band EQ of single-EQ mode, take no right channel', async () => {
			const fake = new FakeQudelix('5k');
			const usr = open(fake, first());
			expect(usr.capabilities.perChannel).toBe(false);
			const refused = {
				code: 'invalid-request',
				message: expect.stringMatching(/no right channel/)
			};
			await expect(usr.push({ filters: L, right: { filters: R } })).rejects.toMatchObject(refused);
			fake.single = true;
			await expect(usr.push({ filters: L, right: { filters: R } })).rejects.toMatchObject(refused);
			expect(fake.sent).toEqual([]);
			// Single-EQ mode has no speaker EQ at all.
			await expect(
				open(fake, first('spk')).push({ filters: L, right: { filters: R } })
			).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/single-EQ/) });
			expect(eqWrites(fake)).toEqual([]);
		});

		test('the codec reads the right channel back where the frames write it apart, and only there', () => {
			const spk = { group: 'spk' } as const;
			const apart = { filters: L, preamp: -2, right: { filters: R, preamp: 1 }, slot: 22 };
			expect(qudelixUsbHidCodec.decode(qudelixUsbHidCodec.encode(apart, spk), spk)).toEqual(apart);
			const together = { filters: L, preamp: -2 };
			const frames = qudelixUsbHidCodec.encode(together, spk);
			expect(qudelixUsbHidCodec.decode(frames, spk)).toEqual(together);
			// One frame for both channels per band: mask 3.
			expect(frames.filter((f) => f.data[3] === 0x0f).map((f) => f.data[5])).toEqual([3, 3]);
			const same = { filters: L, preamp: -2, right: { filters: L } };
			expect(qudelixUsbHidCodec.decode(qudelixUsbHidCodec.encode(same, spk), spk)).toEqual(
				together
			);
			expect(() =>
				qudelixUsbHidCodec.encode({ filters: L, right: { filters: R } }, {})
			).toThrowError(expect.objectContaining({ code: 'invalid-request' }));
		});
	});

	test('in single-EQ mode the user EQ is the 20-band EQ, and there is no speaker EQ', async () => {
		const fake = new FakeQudelix('5k');
		fake.single = true;
		const usr = open(fake, first());
		expect(await usr.bandCount()).toBe(20);
		const twelve = Array.from({ length: 12 }, (_, i) => pk(100 * (i + 1), i - 6, 1.5));
		await usr.push({ filters: twelve, slot: 41 });
		const back = await usr.pull();
		expect(back.filters).toHaveLength(20);
		expect(back.filters.slice(0, 12)).toEqual(twelve);
		expect(back.slot).toBe(41);
		await expect(usr.push({ filters: new Array(21).fill(pk(100, 0)) })).rejects.toMatchObject({
			code: 'invalid-request'
		});
		const spk = open(fake, first('spk'));
		await expect(spk.push({ filters: [pk(100, 1)] })).rejects.toMatchObject({
			code: 'unsupported',
			message: expect.stringMatching(/single-EQ mode/)
		});
		await expect(spk.pull()).rejects.toMatchObject({ code: 'unsupported' });
		expect(fake.errors).toEqual([]);
	});

	test('the switch, the current preset, the band count and the firmware', async () => {
		const fake = new FakeQudelix('5k');
		const device = open(fake, first());
		expect(device.capabilities).toMatchObject({
			canRead: true,
			readsPreamp: true,
			writesSlot: true,
			readsEnabled: true,
			readsFirmware: true,
			readsBandCount: true
		});
		expect(await device.eqEnabled()).toBe(true);
		await device.setEnabled(false);
		expect(fake.eqs.get(0)!.enable).toBe(0);
		expect(await device.eqEnabled()).toBe(false);
		await device.setEnabled(true, 3);
		expect(eqWrites(fake).slice(-2)).toEqual([
			padded([0x05, 0x80, 0x07, 0x00, 0x00, 0x01]),
			padded([0x05, 0x80, 0x07, 0x09, 0x00, 0x03])
		]);
		expect(await device.currentSlot()).toBe(3);
		expect(await device.bandCount()).toBe(10);
		expect(await device.firmware()).toBe('3.2.1');
	});

	test('a save goes to one of the group’s custom presets only, and nothing is written otherwise', async () => {
		const fake = new FakeQudelix('5k');
		const device = open(fake, first());
		for (const slot of [5, 42]) {
			await expect(device.push({ filters: [pk(100, 1)], slot })).rejects.toMatchObject({
				code: 'invalid-request'
			});
		}
		await expect(device.push({ filters: [pk(70000, 1)] })).rejects.toMatchObject({
			code: 'unrepresentable'
		});
		expect(eqWrites(fake)).toEqual([]);
	});

	test('each band waits for the device’s echo; a device without one gets the rest at once', async () => {
		// The fake echoes on the next microtask: a band sent before the last one's echo fails here.
		const fake = new FakeQudelix('5k');
		let pending = 0;
		const send = fake.sendReport.bind(fake);
		fake.sendReport = async (reportId, data) => {
			if (data[2] === 0x07 && data[3] === 0x0f) {
				expect(pending).toBe(0);
				pending++;
			}
			await send(reportId, data);
		};
		fake.onInputReport((_id, d) => {
			if (d[1] === 0x20 && d[3] === 0x89) pending--;
		});
		await open(fake, first()).push({ filters: five });
		expect(pending).toBe(0);

		const quiet = new FakeQudelix('5k');
		quiet.echoes = false;
		const log = vi.fn();
		const device = open(quiet, first(), log);
		await device.push({ filters: five });
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]![0]).toMatch(/no echo of a band write/);
		expect((await device.pull()).filters.slice(0, 5)).toEqual(five);
		expect(quiet.errors).toEqual([]);
	});

	test('drops input until 20 ms pass without any, then opens', async () => {
		const fake = new FakeQudelix('5k');
		const seen: number[] = [];
		const sleep = async (ms: number) => {
			seen.push(fake.sent.length);
			expect(ms).toBe(20);
			if (seen.length < 4) fake.chatter();
		};
		await openDevice(fake, first(), { sleep }).firmware();
		expect(seen).toEqual([0, 0, 0, 0]);
		expect(fake.commands()[0]).toBe(0x0100);
	});

	test('waits past an opening answer that is not ready', async () => {
		const fake = new FakeQudelix('5k');
		fake.openingStates = [2, 3];
		expect(await open(fake, first()).firmware()).toBe('3.2.1');
	});

	test('writes on report 7 when the descriptor has no report 8', async () => {
		const fake = new FakeQudelix('5k', { outputs: [{ reportId: 7, size: 63 }] });
		await open(fake, first()).push({ filters: [pk(100, 1)] });
		expect(fake.sent.every((f) => f.reportId === 7)).toBe(true);
	});

	describe('refusals', () => {
		test('5K firmware below 3.0.0, whose EQ commands differ, and below 2.0.0, which the app refuses', async () => {
			for (const [firmware, why] of [
				[[2, 9, 0], /2\.x EQ commands/],
				[[1, 9, 0], /older than 2\.0\.0/]
			] as const) {
				const fake = new FakeQudelix('5k', { firmware: [...firmware] });
				const device = open(fake, first());
				await expect(device.push({ filters: [pk(100, 1)] })).rejects.toMatchObject({
					code: 'unsupported',
					message: expect.stringMatching(why)
				});
				expect(fake.commands()).toEqual([0x0100]);
				expect(await device.firmware()).toBe(firmware.join('.'));
			}
		});

		test('a device id this handler does not drive', async () => {
			for (const [id, why] of [
				[2, /5K Plus.*qudelix-v2-usb-hid/],
				[0x300, /no model this bridge knows/]
			] as const) {
				const fake = new FakeQudelix('5k', { deviceId: id });
				await expect(open(fake, first()).pull()).rejects.toMatchObject({
					code: 'unsupported',
					message: expect.stringMatching(why)
				});
			}
		});

		test('the audio interface, and a control interface with no report to write to', async () => {
			await expect(
				open(new FakeQudelix('5k', { audioOnly: true }), first()).pull()
			).rejects.toMatchObject({ code: 'transport' });
			await expect(
				open(new FakeQudelix('5k', { outputs: [] }), first()).pull()
			).rejects.toMatchObject({ code: 'unsupported' });
		});

		test('no answer to the opening request within 5 s, and the next operation opens again', async () => {
			vi.useFakeTimers();
			const fake = new FakeQudelix('5k');
			fake.answerOpening = false;
			const device = open(fake, first());
			const pull = device.pull();
			pull.catch(() => {});
			await vi.advanceTimersByTimeAsync(4999);
			expect(fake.commands()).toEqual([0x0100]);
			await vi.advanceTimersByTimeAsync(1);
			await expect(pull).rejects.toMatchObject({ code: 'timeout' });
			fake.answerOpening = true;
			expect((await device.pull()).filters).toHaveLength(10);
			expect(fake.commands().filter((c) => c === 0x0100)).toHaveLength(2);
		});
	});
});

describe("Qudelix T71 as Qudelix's app drives it", () => {
	const nxp = (bytes: number[]) =>
		padded([0, bytes.length >> 8, bytes.length & 255, ...bytes], 127);

	test('opens on report 2 in the 0x1fc9 framing', async () => {
		const fake = new FakeQudelix('t71');
		expect(await open(fake, first()).firmware()).toBe('1.5.9');
		expect(fake.sent[0]).toEqual({ reportId: 2, data: nxp([0x01, 0x00, 0x20, 0x00, 0x04]) });
	});

	test('push then pull on a one-channel user EQ, saving to one of its ten custom presets', async () => {
		const fake = new FakeQudelix('t71');
		const device = open(fake, first());
		await device.push({ filters: five, preamp: -1.5, slot: 31 });
		const back = await device.pull();
		expect(back.filters).toEqual([...five, ...flatFilters(10).slice(5)]);
		expect(back.preamp).toBe(-1.5);
		expect(back.slot).toBe(31);
		await expect(device.push({ filters: five, slot: 32 })).rejects.toMatchObject({
			code: 'invalid-request'
		});
		expect(fake.errors).toEqual([]);
	});

	test('the codec reads its own frames back in the 0x1fc9 framing', () => {
		const options = {
			device: {
				link: { vendorId: 0x1fc9, reportId: 2, reportSize: 127 },
				model: QUDELIX_MODELS[T71]!,
				single: false,
				channels: 5
			}
		};
		const frames = qudelixUsbHidCodec.encode({ filters: five, preamp: -4.2, slot: 25 }, options);
		expect(frames.every((f) => f.reportId === 2 && f.data.length === 127)).toBe(true);
		expect(qudelixUsbHidCodec.decode(frames, options)).toEqual({
			filters: five,
			preamp: -4.2,
			slot: 25
		});
	});

	test('a five-channel user EQ is written on every channel, one frame each', async () => {
		const fake = new FakeQudelix('t71', { usrChannels: 5 });
		const device = open(fake, first());
		await device.push({ filters: [pk(1000, -3, 0.7)], preamp: -2 });
		// [0, length u16, command u16, group, mask, …]
		const masksOf = (command: number) =>
			eqWrites(fake)
				.filter((f) => f[4] === command)
				.map((f) => f[6]);
		expect(masksOf(0x0f)).toEqual([1, 2, 4, 8, 16]);
		expect(masksOf(0x03)).toEqual([1, 2, 4, 8, 16]);
		for (const ch of fake.eqs.get(0)!.bands) {
			expect(ch[0]).toEqual({ filter: 5, freq: 1000, gain: -30, q: 717 });
		}
		const log = vi.fn();
		const back = await open(fake, first(), log).pull();
		expect(back.filters[0]).toEqual(pk(1000, -3, 717 / 1024));
		expect(log).not.toHaveBeenCalled();
		expect(fake.errors).toEqual([]);
	});

	test('a five-channel user EQ whose channels differ pulls the first one and says so', async () => {
		const fake = new FakeQudelix('t71', { usrChannels: 5 });
		fake.eqs.get(0)!.bands[2]![3]!.gain = 25;
		const log = vi.fn();
		const back = await open(fake, first(), log).pull();
		expect(back.filters[3]!.gain).toBe(0);
		expect(back.right).toBeUndefined();
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/channel 2 differs/));
		await expect(
			open(fake, first()).push({ filters: [pk(100, 1)], right: { filters: [pk(100, 2)] } })
		).rejects.toMatchObject({ code: 'invalid-request' });
	});

	test('the speaker EQ with its channels apart: mask 1 the left, mask 2 the right', async () => {
		const fake = new FakeQudelix('t71');
		const spk = open(fake, first('spk'));
		await spk.push({ filters: [pk(1000, -3)], right: { filters: [pk(80, 2)] } });
		expect(eqWrites(fake).slice(1)).toEqual([
			nxp([0x07, 0x0f, 0x01, 0x01, 0x00, 0x05, 0x03, 0xe8, 0xff, 0xe2, 0x04, 0x00]),
			nxp([0x07, 0x0f, 0x01, 0x02, 0x00, 0x05, 0x00, 0x50, 0x00, 0x14, 0x04, 0x00])
		]);
		const back = await spk.pull();
		expect([back.filters[0], back.right!.filters[0]]).toEqual([pk(1000, -3), pk(80, 2)]);
		expect(fake.errors).toEqual([]);
	});

	test('the speaker EQ: one left-and-right frame, and the user EQ left alone', async () => {
		const fake = new FakeQudelix('t71');
		const spk = open(fake, first('spk'));
		await spk.push({ filters: [pk(1000, -3, 0.7)], slot: 41 });
		expect(eqWrites(fake)).toEqual([
			nxp([0x07, 0x00, 0x01, 0x01]),
			nxp([0x07, 0x0f, 0x01, 0x03, 0x00, 0x05, 0x03, 0xe8, 0xff, 0xe2, 0x02, 0xcd]),
			nxp([0x07, 0x0a, 0x01, 0x13, 0x00]),
			nxp([0x07, 0x08, 0x01, 0x29])
		]);
		expect(fake.eqs.get(0)).toEqual(flatEq(1, 10));
		expect((await spk.pull()).filters[0]).toEqual(pk(1000, -3, 717 / 1024));
	});

	test('a speaker EQ of 4 or 8 channels (crossover drivers) is refused, and nothing written', async () => {
		for (const spkChannels of [4, 8]) {
			const fake = new FakeQudelix('t71', { spkChannels });
			const spk = open(fake, first('spk'));
			await expect(spk.push({ filters: [pk(100, 1)] })).rejects.toMatchObject({
				code: 'unsupported',
				message: expect.stringMatching(/drivers/)
			});
			await expect(spk.pull()).rejects.toMatchObject({ code: 'unsupported' });
			expect(eqWrites(fake)).toEqual([]);
			// The user EQ is still driven.
			await open(fake, first()).push({ filters: [pk(100, 1)] });
			expect(fake.errors).toEqual([]);
		}
	});
});

describe("Qudelix 5K Plus as Qudelix's app drives it", () => {
	const second = (group?: 'usr' | 'spk') => protocolFor('qudelix-v2-usb-hid', group);
	/** Each message received: its command, then its elements' ids. */
	const ids = (fake: FakeQudelixV2) =>
		fake.messages.map((m) => [m.command, ...m.elements.map((e) => e.id)]);
	const SET = 0x9004;
	const REQ = 0x9002;
	/** What every operation asks first: the EQ mode, then the configuration of its EQ. */
	const asks = (config: number) => [
		[REQ, 0x80],
		[REQ, config]
	];

	test('opens with the same request and takes the firmware from the answer; each operation asks for the mode and configuration', async () => {
		const fake = new FakeQudelixV2();
		const device = open(fake, second());
		expect(await device.firmware()).toBe('1.2.3');
		expect(await device.eqEnabled()).toBe(true);
		expect(await device.bandCount()).toBe(10);
		expect(fake.sent[0]).toEqual({
			reportId: 8,
			data: padded([0x06, 0x80, 0x01, 0x00, 0x20, 0x00, 0x04])
		});
		expect(ids(fake)).toEqual([...asks(0x90), ...asks(0x90)]);
	});

	test('every operation reads the device as it is now, which another program changes unannounced', async () => {
		// A 5K Plus with firmware 1.0.3 (2026-11-21): another program's push took the headphone EQ
		// off memory 22, no notification came, and a session that kept the opening answer's
		// configuration still said 22, where an app would then save.
		const fake = new FakeQudelixV2();
		const eq = fake.eqs.get(1)!;
		eq.preset = 22;
		const spk = open(fake, second('spk'));
		expect(await spk.currentSlot()).toBe(22);
		expect((await spk.pull()).slot).toBe(22);
		// Another program's push, with no notification (fake-qudelix.ts).
		eq.bands[0]![0]!.gain = -30;
		eq.preset = 255;
		expect(await spk.currentSlot()).toBeNull();
		const pulled = await spk.pull();
		expect(pulled.slot).toBeUndefined();
		expect(pulled.filters[0]!.gain).toBe(-3);
		expect(await spk.eqEnabled()).toBe(true);
		eq.enable = 0;
		expect(await spk.eqEnabled()).toBe(false);
		fake.single = true;
		await expect(spk.currentSlot()).rejects.toMatchObject({
			code: 'unsupported',
			message: expect.stringMatching(/single-EQ mode/)
		});
		expect(await open(fake, second()).bandCount()).toBe(30);
		expect(fake.errors).toEqual([]);
	});

	test("a push sends the app's elements in its order, and a pull gives back what was pushed", async () => {
		const fake = new FakeQudelixV2();
		Object.assign(fake.eqs.get(0)!, { impedance: 320, headroom: -60 });
		const device = open(fake, second());
		await device.push({ filters: five, preamp: -3.5, slot: 23 });
		expect(ids(fake)).toEqual([
			...asks(0x90),
			[REQ, 0x93],
			[SET, 0x90],
			[SET, 0x92],
			[SET, 0x93],
			...five.map(() => [SET, 0x95]),
			[SET, 0x94],
			[0x9006, 0x30]
		]);
		const back = await device.pull();
		expect(back.filters).toEqual([...five, ...flatFilters(10).slice(5)]);
		expect(back.preamp).toBe(-3.5);
		expect(back.slot).toBe(23);
		expect(await device.currentSlot()).toBe(23);
		// The preset was set whole: what the push doesn't change comes back as it was.
		expect(fake.eqs.get(0)).toMatchObject({ impedance: 320, headroom: -60 });
		expect(fake.eqs.get(1)).toEqual(flatEq(2, 20));
		expect(fake.errors).toEqual([]);
	});

	test('the band element is the app’s: the user EQ’s one channel, or the speaker EQ’s both', async () => {
		const band = (element: number, mask: number) =>
			padded([
				0x0e,
				0x80,
				0x90,
				0x04,
				0x80,
				element,
				0x02,
				(5 << 4) | mask,
				0x00,
				0xe8,
				0x03,
				0xe2,
				0xff,
				0xcd,
				0x02
			]);
		const fake = new FakeQudelixV2();
		await open(fake, second()).push({ filters: [pk(1000, -3, 0.7)] });
		expect(fake.sent.map((f) => f.data)).toContainEqual(band(0x95, 1));
		const spk = new FakeQudelixV2();
		await open(spk, second('spk')).push({ filters: [pk(1000, -3, 0.7)] });
		expect(spk.sent.map((f) => f.data)).toContainEqual(band(0xa5, 3));
		// The speaker EQ is parametric only: no attributes are set.
		expect(ids(spk)).toEqual([...asks(0xa0), [REQ, 0xa3], [SET, 0xa0], [SET, 0xa5]]);
		expect(spk.eqs.get(0)).toEqual(flatEq(1, 10));
	});

	test('a long message goes in fragments, each but the last acked', async () => {
		const fake = new FakeQudelixV2();
		const spk = open(fake, second('spk'));
		await spk.push({ filters: [pk(100, 1)], preamp: -2 });
		// The speaker EQ's preset, 256 bytes after its 2-byte head, in 39-byte slices.
		const at = ids(fake).findIndex(([c, id]) => c === SET && id === 0xa3);
		expect(fake.fragments[at]).toEqual([
			[0, 39],
			[1, 39],
			[2, 39],
			[3, 39],
			[4, 39],
			[5, 39],
			[0x86, 24]
		]);
		expect(fake.acks).toBe(6);
		expect(fake.eqs.get(1)!.preGain).toEqual([-20, -20]);
		expect((await spk.pull()).preamp).toBe(-2);
		expect(fake.errors).toEqual([]);
	});

	test('a missing ack stops the message, and so does a bad one; the next operation opens again', async () => {
		vi.useFakeTimers();
		const fake = new FakeQudelixV2();
		const device = open(fake, second());
		fake.ack = 'none';
		const push = device.push({ filters: [pk(100, 1)], preamp: -2 });
		push.catch(() => {});
		await vi.advanceTimersByTimeAsync(1000);
		await expect(push).rejects.toMatchObject({ code: 'timeout' });
		// The preset, 78 bytes, waited on its first fragment's ack, and nothing went after it.
		const before = [...asks(0x90), [REQ, 0x93], [SET, 0x90], [SET, 0x92]];
		expect(ids(fake)).toEqual(before);
		expect(fake.packets().at(-1)!.slice(0, 5)).toEqual([0x90, 0x04, 0x00, 0x93, 19]);
		fake.ack = 'bad';
		await expect(device.push({ filters: [pk(100, 1)], preamp: -2 })).rejects.toMatchObject({
			code: 'rejected'
		});
		expect(ids(fake)).toEqual([...before, ...before]);
		fake.ack = 'ok';
		expect((await device.pull()).filters).toHaveLength(10);
		expect(fake.commands().filter((c) => c === 0x0100)).toHaveLength(3);
	});

	test('in single-EQ mode the user EQ is the 30-band EQ, and there is no speaker EQ', async () => {
		const fake = new FakeQudelixV2();
		fake.single = true;
		const usr = open(fake, second());
		expect(await usr.bandCount()).toBe(30);
		const many = Array.from({ length: 25 }, (_, i) => pk(40 * (i + 1), (i % 7) - 3, 1.25));
		await usr.push({ filters: many, preamp: -6 });
		const back = await usr.pull();
		expect(back.filters).toHaveLength(30);
		expect(back.filters.slice(0, 25)).toEqual(many);
		expect(back.preamp).toBe(-6);
		await expect(open(fake, second('spk')).pull()).rejects.toMatchObject({
			code: 'unsupported',
			message: expect.stringMatching(/single-EQ mode/)
		});
		expect(fake.errors).toEqual([]);
	});

	test('the speaker EQ pulls both channels, the right as `right`', async () => {
		const fake = new FakeQudelixV2();
		fake.eqs.get(1)!.preGain = [0, -10];
		const log = vi.fn();
		const back = await open(fake, second('spk'), log).pull();
		expect(back.preamp).toBe(0);
		expect(back.right).toEqual({ filters: flatFilters(20), preamp: -1 });
		expect(log).not.toHaveBeenCalled();
	});

	test("with its channels apart the speaker EQ's band elements carry masks 1 and 2, and the preset each channel's pre-gain", async () => {
		const fake = new FakeQudelixV2();
		const spk = open(fake, second('spk'));
		const L = [pk(1000, -3), pk(200, 2, 2)];
		const R = [pk(3000, 4, 0.5)];
		await spk.push({ filters: L, preamp: -2, right: { filters: R, preamp: -1 } });
		expect(ids(fake)).toEqual([
			...asks(0xa0),
			[REQ, 0xa3],
			[SET, 0xa0],
			[SET, 0xa3],
			[SET, 0xa5],
			[SET, 0xa5],
			[SET, 0xa5]
		]);
		const bands = fake.messages.flatMap((m) => m.elements).filter((e) => e.id === 0xa5);
		expect(bands.map((e) => [e.data[0]! & 15, e.data[1]])).toEqual([
			[1, 0],
			[2, 0],
			[1, 1]
		]);
		expect(fake.eqs.get(1)!.preGain).toEqual([-20, -10]);
		expect(await spk.pull()).toEqual({
			filters: [...L, ...flatFilters(20).slice(2)],
			preamp: -2,
			right: { filters: [...R, ...flatFilters(20).slice(1)], preamp: -1 }
		});
		// The right pre-gain left out is the left one's.
		await spk.push({ filters: L, preamp: -4, right: { filters: R } });
		expect(fake.eqs.get(1)!.preGain).toEqual([-40, -40]);
		expect(fake.eqs.get(0)).toEqual(flatEq(1, 10));
		expect(fake.errors).toEqual([]);
	});

	test('a pull reads the answer, not a notification of the push that arrives before it', async () => {
		const fake = new FakeQudelixV2();
		fake.lateNotifications = true;
		const spk = open(fake, second('spk'));
		const L = [pk(1000, -3), pk(200, 2, 2)];
		const R = [pk(3000, 4, 0.5)];
		await spk.push({ filters: L, right: { filters: R } });
		expect(await spk.pull()).toEqual({
			filters: [...L, ...flatFilters(20).slice(2)],
			preamp: 0,
			right: { filters: [...R, ...flatFilters(20).slice(1)], preamp: 0 }
		});
		expect(fake.errors).toEqual([]);
	});

	test('the codec reads the right channel back where the elements write it apart, and only there', () => {
		const spk = { group: 'spk' } as const;
		const L = [pk(1000, -3)];
		const apart = { filters: L, preamp: -2, right: { filters: [pk(80, 1)], preamp: 1 }, slot: 41 };
		expect(qudelixV2UsbHidCodec.decode(qudelixV2UsbHidCodec.encode(apart, spk), spk)).toEqual(
			apart
		);
		const together = { filters: L, preamp: -2 };
		expect(qudelixV2UsbHidCodec.decode(qudelixV2UsbHidCodec.encode(together, spk), spk)).toEqual(
			together
		);
		expect(() =>
			qudelixV2UsbHidCodec.encode({ filters: L, right: { filters: L } }, {})
		).toThrowError(expect.objectContaining({ code: 'invalid-request' }));
	});

	test('the firmware is requested where the opening answer lacks it', async () => {
		const fake = new FakeQudelixV2();
		fake.omit.add(3);
		expect(await open(fake, second()).firmware()).toBe('1.2.3');
		expect(ids(fake)).toEqual([[REQ, 3]]);
	});

	test('the switch and the preset are set as the whole configuration, the headroom kept', async () => {
		const fake = new FakeQudelixV2();
		fake.eqs.get(0)!.headroom = -60;
		const device = open(fake, second());
		await device.push({ filters: [pk(200, 2)], slot: 24 });
		await device.push({ filters: [pk(300, 3)] });
		expect(await device.currentSlot()).toBeNull();
		await device.setEnabled(false);
		expect(fake.eqs.get(0)).toMatchObject({ enable: 0, headroom: -60, preset: 255 });
		expect(await device.eqEnabled()).toBe(false);
		await device.setEnabled(true, 24);
		expect(fake.eqs.get(0)).toMatchObject({ enable: 1, headroom: -60, preset: 24 });
		expect((await device.pull()).filters[0]).toEqual(pk(200, 2));
		expect(await device.currentSlot()).toBe(24);
		expect(fake.errors).toEqual([]);
	});

	test('refusals: the other protocol’s models, another protocol version, a save past the customs', async () => {
		await expect(open(new FakeQudelix('5k'), second()).pull()).rejects.toMatchObject({
			code: 'unsupported',
			message: expect.stringMatching(/5K, which speaks the first protocol/)
		});
		await expect(open(new FakeQudelixV2(), first()).pull()).rejects.toMatchObject({
			code: 'unsupported',
			message: expect.stringMatching(/5K Plus, which speaks the second protocol/)
		});
		const v3 = new FakeQudelixV2();
		v3.protocolMajor = 3;
		await expect(open(v3, second()).pull()).rejects.toMatchObject({ code: 'unsupported' });
		const fake = new FakeQudelixV2();
		await expect(
			open(fake, second()).push({ filters: [pk(100, 1)], slot: 42 })
		).rejects.toMatchObject({ code: 'invalid-request' });
		expect(ids(fake).filter(([c]) => c !== REQ)).toEqual([]);
	});
});

// The devices' own answers (test/captures/): each as its owner left it, and after a push to the
// user EQ saved to memory 22 and a push to the speaker EQ.
describe.each([
	{ name: '5K', file: 'qudelix_qudelix_5k', handler: 'qudelix-usb-hid', firmware: '3.2.9' },
	{
		name: '5K Plus',
		file: 'qudelix_qudelix_5k_plus',
		handler: 'qudelix-v2-usb-hid',
		firmware: '1.0.3'
	}
] as const)('a recorded Qudelix $name', ({ name, file, handler, firmware }) => {
	const recorded = (state: '' | '_pushed', group?: 'usr' | 'spk') => {
		const transport = new ReplayHid(loadCaptures().find((c) => c.file === `${file}${state}.json`)!);
		const log = vi.fn();
		return { transport, log, device: open(transport, protocolFor(handler, group), log) };
	};
	const plus = name === '5K Plus';
	const curve: Filter[] = [
		pk(1000, -3, 1.5),
		{ type: 'LSC', freq: 105, gain: -2, q: 0.75 },
		{ type: 'HSC', freq: 9000, gain: -1.5, q: 0.5 },
		{ type: 'HPQ', freq: 25, gain: 0, q: 724 / 1024 },
		{ type: 'LPQ', freq: 19000, gain: 0, q: 724 / 1024 }
	];
	const speaker: Filter[] = [pk(3000, -4, 2), { type: 'LSC', freq: 80, gain: -1, q: 0.75 }];

	test('as found: the firmware, the user EQ off and flat', async () => {
		const { transport, device } = recorded('');
		expect(await device.firmware()).toBe(firmware);
		expect(await device.eqEnabled()).toBe(false);
		// The 5K's was edited (no preset); the 5K Plus's sat on its last memory.
		expect(await device.currentSlot()).toBe(plus ? 41 : null);
		expect(await device.bandCount()).toBe(10);
		expect((await device.pull()).filters).toEqual(flatFilters(10));
		expect(transport.unmatched).toEqual([]);
	});

	test('as found: the speaker EQ, left and right alike', async () => {
		const { transport, log, device } = recorded('', 'spk');
		// The 5K's was off on its memory 26; the 5K Plus's on, on Flat.
		expect(await device.eqEnabled()).toBe(plus);
		expect(await device.currentSlot()).toBe(plus ? 0 : 26);
		expect(await device.bandCount()).toBe(plus ? 20 : 10);
		const pulled = await device.pull();
		expect(pulled.preamp).toBe(0);
		expect(pulled.filters).toHaveLength(plus ? 20 : 10);
		expect(pulled.filters.every((f) => f?.type === 'PK' && f.gain === 0)).toBe(true);
		expect(log).not.toHaveBeenCalled();
		expect(transport.unmatched).toEqual([]);
	});

	test('after the pushes: the user EQ on, on memory 22, holding what was pushed', async () => {
		const { transport, device } = recorded('_pushed');
		expect(await device.eqEnabled()).toBe(true);
		expect(await device.currentSlot()).toBe(22);
		const pulled = await device.pull();
		expect(pulled).toMatchObject({ preamp: -3.5, slot: 22 });
		expect(pulled.filters.slice(0, 5)).toEqual(curve);
		expect(pulled.filters.slice(5)).toEqual(flatFilters(10).slice(5));
		expect(transport.unmatched).toEqual([]);
	});

	test('after the pushes: the speaker EQ on, edited, both channels holding what was pushed', async () => {
		const { transport, log, device } = recorded('_pushed', 'spk');
		expect(await device.eqEnabled()).toBe(true);
		expect(await device.currentSlot()).toBeNull();
		const pulled = await device.pull();
		expect(pulled.preamp).toBe(-2);
		expect(pulled.filters.slice(0, 2)).toEqual(speaker);
		expect(log).not.toHaveBeenCalled();
		expect(transport.unmatched).toEqual([]);
	});

	// The 5K Plus's recordings predate the requests for the mode and the configuration: the replay
	// answers those from the elements the device sent, byte for byte, and makes up none (replay.ts).
	test.runIf(plus)(
		'the replay answers a request it has no record of from what the device sent, and only that',
		async () => {
			const { transport } = recorded('');
			const heard: number[][] = [];
			transport.onInputReport((_, data) => heard.push([...data]));
			const send = (packet: number[]) =>
				transport.sendReport(8, Uint8Array.from(padded([packet.length + 1, 0x80, ...packet], 127)));
			await send([0x01, 0x00, 0x20, 0x00, 0x04]);
			await send([0x90, 0x02, 0x80, 0x90, 0x00]);
			// The user EQ's configuration as the opening answer holds it: off, on memory 41.
			expect(heard.at(-1)).toEqual(
				padded([0x09, 0x90, 0x03, 0x80, 0x90, 0x01, 0x01, 0x00, 0x00, 0x29], 127)
			);
			// The all-band EQ's: a layered device's opening answer has none.
			await send([0x90, 0x02, 0x80, 0xb0, 0x00]);
			expect(transport.unmatched.map((f) => [...f.data.subarray(0, 7)])).toEqual([
				[0x06, 0x80, 0x90, 0x02, 0x80, 0xb0, 0x00]
			]);
		}
	);

	// The 5K's frames don't depend on what it holds, so the replay knows every one of them. The
	// 5K Plus's preset element does (captures.test.ts checks its band frames).
	test.skipIf(plus)('the same pushes send the frames the device was sent', async () => {
		const usr = recorded('_pushed');
		await usr.device.push({ filters: curve, preamp: -3.5, slot: 22 });
		expect(usr.transport.unmatched).toEqual([]);
		const spk = recorded('_pushed', 'spk');
		await spk.device.push({ filters: speaker, preamp: -2 });
		expect(spk.transport.unmatched).toEqual([]);
	});
});

describe('the device viewed as one of its EQs (SPEC §9.2)', () => {
	const flat = { id: 0, name: 'Flat' };
	const protocol: Protocol = {
		handler: 'qudelix-v2-usb-hid',
		presets: [flat, { id: 1, name: 'Acoustic' }],
		eqs: [{ id: 'spk', name: 'SPK EQ', bandCount: 20, presets: [flat] }]
	};

	test('capabilities list the other EQs with their own slots, and which take a right channel', () => {
		const device = openDevice(new FakeQudelixV2(), protocol, { sleep: noSleep });
		expect(device.capabilities.slots).toEqual(protocol.presets);
		expect(device.capabilities.perChannel).toBe(false);
		expect(device.capabilities.eqs).toEqual([
			{ id: 'spk', name: 'SPK EQ', bandCount: 20, slots: [flat], perChannel: true }
		]);
		const plain = openDevice(new FakeQudelixV2(), { handler: 'qudelix-v2-usb-hid' });
		expect(plain.capabilities.eqs).toEqual([]);
	});

	test("a view has its EQ's slots and channels, and the device's list of EQs", () => {
		const device = openDevice(new FakeQudelixV2(), protocol, { sleep: noSleep });
		const spk = device.eq('spk');
		expect(spk.capabilities.slots).toEqual([flat]);
		expect(spk.capabilities.perChannel).toBe(true);
		expect(spk.capabilities.eqs).toBe(device.capabilities.eqs);
		expect(spk.capabilities).not.toHaveProperty('perChannelEqs');
		// The same view each time, and the way back to the profile's own.
		expect(device.eq('spk')).toBe(spk);
		expect(device.eq()).toBe(device);
		expect(spk.eq()).toBe(device);
	});

	test("the firmware, the controls and closing are the device's from every view", async () => {
		const fake = new FakeQudelixV2();
		const close = vi.spyOn(fake, 'close');
		const device = openDevice(fake, protocol, { sleep: noSleep });
		const spk = device.eq('spk');
		expect(spk.capabilities.controls).toBe(device.capabilities.controls);
		expect(await spk.firmware()).toBe(await device.firmware());
		expect(await spk.readControls()).toEqual(await device.readControls());
		await spk.close();
		expect(close).toHaveBeenCalledTimes(1);
	});

	test('one device drives both EQs, each through its view', async () => {
		const fake = new FakeQudelixV2();
		const device = openDevice(fake, protocol, { sleep: noSleep });
		const spk = device.eq('spk');
		await spk.push({ filters: [pk(200, 2)], preamp: -1 });
		await device.push({ filters: [pk(1000, -3)] });
		expect((await spk.pull()).filters[0]).toEqual(pk(200, 2));
		expect((await device.pull()).filters[0]).toEqual(pk(1000, -3));
		expect(await spk.bandCount()).toBe(20);
		expect(await device.bandCount()).toBe(10);
		await spk.setEnabled(false);
		expect(await spk.eqEnabled()).toBe(false);
		expect(await device.eqEnabled()).toBe(true);
		expect(await spk.currentSlot()).toBeNull();
		expect(fake.errors).toEqual([]);
	});

	test('a right channel is refused on a view unless its EQ takes one', async () => {
		const fake = new FakeQudelixV2();
		const device = openDevice(fake, protocol, { sleep: noSleep });
		const right = { filters: [pk(80, 1)] };
		await expect(device.push({ filters: [pk(100, 1)], right })).rejects.toMatchObject({
			code: 'invalid-request'
		});
		expect(fake.sent).toEqual([]);
		await device.eq('spk').push({ filters: [pk(100, 1)], right });
		expect((await device.eq('spk').pull()).right!.filters[0]).toEqual(pk(80, 1));
		expect(fake.errors).toEqual([]);
	});

	test('an EQ the profile does not list is refused when it is asked for, and nothing is sent', () => {
		const fake = new FakeQudelixV2();
		const device = openDevice(fake, { handler: 'qudelix-v2-usb-hid' }, { sleep: noSleep });
		let thrown: unknown;
		try {
			device.eq('spk');
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toMatchObject({
			code: 'invalid-request',
			message: 'qudelix-v2-usb-hid: no EQ "spk" here'
		});
		expect(fake.sent).toEqual([]);
	});

	test('the views share one queue: operations on two EQs never interleave', async () => {
		const fake = new FakeQudelixV2();
		const device = openDevice(fake, protocol, { sleep: noSleep });
		const [usr, spk] = await Promise.all([device.pull(), device.eq('spk').pull()]);
		expect(usr.filters).toHaveLength(10);
		expect(spk.filters).toHaveLength(20);
		expect(fake.errors).toEqual([]);
	});
});

describe("Qudelix settings besides the EQ, as the app's screens set them", () => {
	const fiveK = (fake: FakeQudelix) =>
		openDevice(fake, dataProtocol('qudelix-5k')!, { sleep: noSleep });
	const plus = (fake: FakeQudelixV2) =>
		openDevice(fake, dataProtocol('qudelix-5k-plus')!, { sleep: noSleep });
	/** The first protocol's writes of settings, as sent: 0x05xx, 0x0702 and 0x070D. */
	const settingWrites = (fake: FakeQudelix) =>
		fake.sent
			.filter((_, i) => [0x0501, 0x0505, 0x0702, 0x070d].includes(fake.commands()[i]!))
			.map((f) => f.data);
	/** The elements the second protocol set, in order. */
	const sets = (fake: FakeQudelixV2) =>
		fake.messages.filter((m) => m.command === 0x9004).flatMap((m) => m.elements);

	test('the data says which EQ each belongs to', () => {
		for (const device of [fiveK(new FakeQudelix('5k')), plus(new FakeQudelixV2())]) {
			expect(device.capabilities.controls.map((c) => [c.id, c.role, c.eq])).toEqual([
				['headroom', 'headroom', true],
				['headroomSpk', 'headroom', 'spk'],
				['crossfeed', 'crossfeed', true],
				['dacFilter', 'dac-filter', undefined],
				['gain', 'output-gain', undefined]
			]);
		}
	});

	test('5K: every setting is read from the device', async () => {
		const fake = new FakeQudelix('5k');
		fake.eqs.get(0)!.headroom = -60;
		fake.eqs.get(1)!.headroom = -120;
		fake.eqs.get(0)!.xfeed = 25;
		fake.dac = { gain: 1, filter: 6 };
		expect(await fiveK(fake).readControls()).toEqual({
			headroom: -6,
			headroomSpk: -12,
			crossfeed: 25,
			dacFilter: 6,
			gain: 1
		});
		expect(fake.errors).toEqual([]);
	});

	// The frames a 5K with firmware 3.2.9 took and answered (2026-11-22).
	test("5K: each write is the app's one command, and the EQ stays on its preset", async () => {
		const fake = new FakeQudelix('5k');
		fake.eqs.get(0)!.preset = 22;
		const device = fiveK(fake);
		await device.writeControl('headroom', -6);
		await device.writeControl('headroomSpk', -12);
		await device.writeControl('crossfeed', 10);
		await device.writeControl('dacFilter', 7);
		await device.writeControl('gain', 0);
		expect(settingWrites(fake)).toEqual(
			[
				[0x05, 0x80, 0x07, 0x02, 0x00, 0xc4],
				[0x05, 0x80, 0x07, 0x02, 0x01, 0x88],
				[0x08, 0x80, 0x07, 0x0d, 0x00, 0x01, 0x00, 0x00, 0x0a],
				[0x04, 0x80, 0x05, 0x01, 0x07],
				[0x04, 0x80, 0x05, 0x05, 0x00]
			].map((f) => padded(f))
		);
		expect(await device.readControls()).toEqual({
			headroom: -6,
			headroomSpk: -12,
			crossfeed: 10,
			dacFilter: 7,
			gain: 0
		});
		expect(await device.currentSlot()).toBe(22);
		expect(fake.errors).toEqual([]);
	});

	test('5K: a value the data does not list is refused before anything is sent', async () => {
		const fake = new FakeQudelix('5k');
		const device = fiveK(fake);
		for (const [id, value] of [
			['headroom', -3],
			['headroom', 6],
			['crossfeed', 51],
			['dacFilter', 8],
			['gain', 2]
		] as const) {
			await expect(device.writeControl(id, value)).rejects.toMatchObject({
				code: 'invalid-request'
			});
		}
		expect(fake.sent).toEqual([]);
	});

	test("5K: an EQ that is off keeps its headroom and crossfeed, as the app's editor holds them still", async () => {
		const fake = new FakeQudelix('5k');
		fake.eqs.get(0)!.enable = 0;
		const device = fiveK(fake);
		await expect(device.writeControl('headroom', -6)).rejects.toMatchObject({
			code: 'rejected',
			message: 'Qudelix 5K: the user EQ is off, and the app sets its headroom only while it is on'
		});
		await expect(device.writeControl('crossfeed', 10)).rejects.toMatchObject({ code: 'rejected' });
		// The speaker EQ is on, and the device's settings are no EQ's.
		await device.writeControl('headroomSpk', -6);
		await device.writeControl('dacFilter', 1);
		expect(settingWrites(fake).map((f) => f.slice(2, 5))).toEqual([
			[0x07, 0x02, 0x01],
			[0x05, 0x01, 0x01]
		]);
		expect((await device.readControls()).headroom).toBe(0);
	});

	test('5K in single-EQ mode: the headroom and crossfeed are the all-band EQ’s, and the speaker EQ’s is not there', async () => {
		const fake = new FakeQudelix('5k');
		fake.single = true;
		fake.eqs.get(2)!.headroom = -120;
		const device = fiveK(fake);
		expect(await device.readControls()).toMatchObject({
			headroom: -12,
			headroomSpk: null,
			crossfeed: 0
		});
		await device.writeControl('headroom', 0);
		await device.writeControl('crossfeed', 50);
		expect(settingWrites(fake).map((f) => f.slice(2, f[0]! + 1))).toEqual([
			[0x07, 0x02, 0x02, 0x00],
			[0x07, 0x0d, 0x02, 0x01, 0x00, 0x00, 0x32]
		]);
		await expect(device.writeControl('headroomSpk', -6)).rejects.toMatchObject({
			code: 'unsupported'
		});
		expect(fake.errors).toEqual([]);
	});

	test('T71: the headroom is driven as on the 5K; its crossfeed and DAC settings are refused', async () => {
		const fake = new FakeQudelix('t71');
		const device = fiveK(fake);
		await device.writeControl('headroomSpk', -6);
		expect(fake.eqs.get(1)!.headroom).toBe(-60);
		await expect(device.writeControl('crossfeed', 10)).rejects.toMatchObject({
			code: 'unsupported'
		});
		await expect(device.writeControl('dacFilter', 1)).rejects.toMatchObject({
			code: 'unsupported'
		});
	});

	test('5K Plus: every setting is read from the device', async () => {
		const fake = new FakeQudelixV2();
		fake.eqs.get(0)!.headroom = -60;
		fake.eqs.get(1)!.headroom = -120;
		fake.eqs.get(0)!.xfeed = 25;
		fake.dac = { gain: 1, filter: 6, swap: 1 };
		expect(await plus(fake).readControls()).toEqual({
			headroom: -6,
			headroomSpk: -12,
			crossfeed: 25,
			dacFilter: 6,
			gain: 1
		});
		expect(fake.errors).toEqual([]);
	});

	test('5K Plus: each write sets the whole element with one field changed', async () => {
		const fake = new FakeQudelixV2();
		const usr = fake.eqs.get(0)!;
		usr.preset = 22;
		usr.impedance = 320;
		const device = plus(fake);
		await device.writeControl('headroom', -6);
		await device.writeControl('headroomSpk', -12);
		await device.writeControl('crossfeed', 10);
		await device.writeControl('dacFilter', 6);
		await device.writeControl('gain', 1);
		expect(sets(fake)).toEqual([
			// The configuration: on, headroom -60, still on preset 22.
			{ id: 0x90, data: [0x10, 0x00, 0xc4, 22] },
			{ id: 0xa0, data: [0x10, 0x00, 0x88, 0] },
			// The attributes, 12 bytes: parametric, 32 ohms kept, crossfeed 10 from bit 26.
			{ id: 0x92, data: [0x81, 0x02, 0x00, 0x28, 0, 0, 0, 0, 0, 0, 0, 0] },
			// The DAC configuration, 8 bytes: the filter from bit 14, the gain at bit 18, the rest kept.
			{ id: 0x40, data: [0x61, 0x98, 0x01, 0, 0, 0, 0, 0] },
			{ id: 0x40, data: [0x61, 0x98, 0x05, 0, 0, 0, 0, 0] }
		]);
		expect(fake.dac).toEqual({ gain: 1, filter: 6, swap: 1 });
		expect(usr).toMatchObject({ headroom: -60, xfeed: 10, impedance: 320, preset: 22, enable: 1 });
		expect(await device.readControls()).toEqual({
			headroom: -6,
			headroomSpk: -12,
			crossfeed: 10,
			dacFilter: 6,
			gain: 1
		});
		expect(fake.errors).toEqual([]);
	});

	test('5K Plus: an EQ that is off keeps its headroom and crossfeed', async () => {
		const fake = new FakeQudelixV2();
		fake.eqs.get(1)!.enable = 0;
		const device = plus(fake);
		await expect(device.writeControl('headroomSpk', -6)).rejects.toMatchObject({
			code: 'rejected',
			message:
				'Qudelix 5K Plus: the speaker EQ is off, and the app sets its headroom only while it is on'
		});
		expect(sets(fake)).toEqual([]);
		await device.writeControl('headroom', -6);
		expect(fake.eqs.get(0)!.headroom).toBe(-60);
	});

	test('5K Plus in single-EQ mode: the headroom and crossfeed are the all-band EQ’s, and the speaker EQ’s is not there', async () => {
		const fake = new FakeQudelixV2();
		fake.single = true;
		const device = plus(fake);
		expect(await device.readControls()).toMatchObject({ headroom: 0, headroomSpk: null });
		await device.writeControl('headroom', -12);
		await device.writeControl('crossfeed', 30);
		expect(sets(fake).map((e) => e.id)).toEqual([0xb0, 0xb2]);
		expect(fake.eqs.get(2)).toMatchObject({ headroom: -120, xfeed: 30 });
		await expect(device.writeControl('headroomSpk', -6)).rejects.toMatchObject({
			code: 'unsupported'
		});
		expect(fake.errors).toEqual([]);
	});
});
