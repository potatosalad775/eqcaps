// The Qudelix handlers against fakes built from the reading of Qudelix's app for Chrome (4.0.3.1).
// No device answered these: they show the handlers agree with that reading (fake-qudelix.ts).

import type { Filter } from '@potatosalad775/eqcaps-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { qudelixUsbHidCodec } from '../src/handlers/qudelix-usb-hid.ts';
import { QUDELIX_MODELS, T71 } from '../src/handlers/qudelix.ts';
import { openDevice, type Protocol, type Transport } from '../src/index.ts';
import { flatEq, FakeQudelix, FakeQudelixV2 } from './fake-qudelix.ts';
import { noSleep } from './replay.ts';

const pk = (freq: number, gain: number, q = 1): Filter => ({ type: 'PK', freq, gain, q });
const padded = (bytes: number[], size = 63) => [
	...bytes,
	...new Array<number>(size - bytes.length).fill(0)
];
const first = (group?: 'usr' | 'spk'): Protocol =>
	group ? { handler: 'qudelix-usb-hid', options: { group } } : { handler: 'qudelix-usb-hid' };
const open = (t: Transport, protocol: Protocol, log?: (m: string) => void) =>
	openDevice(t, protocol, { sleep: noSleep, ...(log ? { log } : {}) });

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

	test('a speaker EQ whose channels differ pulls the left one and says so', async () => {
		const fake = new FakeQudelix('5k');
		fake.eqs.get(1)!.bands[1]![3]!.gain = 25;
		const log = vi.fn();
		const back = await open(fake, first('spk'), log).pull();
		expect(back.filters[3]!.gain).toBe(0);
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/channel 1 differs/));
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
	const second = (group?: 'usr' | 'spk'): Protocol =>
		group
			? { handler: 'qudelix-v2-usb-hid', options: { group } }
			: { handler: 'qudelix-v2-usb-hid' };
	/** Each message received: its command, then its elements' ids. */
	const ids = (fake: FakeQudelixV2) =>
		fake.messages.map((m) => [m.command, ...m.elements.map((e) => e.id)]);
	const SET = 0x9004;
	const REQ = 0x9002;

	test('opens with the same request, and takes the mode, configuration and firmware from the answer', async () => {
		const fake = new FakeQudelixV2();
		const device = open(fake, second());
		expect(await device.firmware()).toBe('1.2.3');
		expect(await device.eqEnabled()).toBe(true);
		expect(await device.bandCount()).toBe(10);
		expect(fake.sent[0]).toEqual({
			reportId: 8,
			data: padded([0x06, 0x80, 0x01, 0x00, 0x20, 0x00, 0x04])
		});
		expect(fake.messages).toEqual([]);
	});

	test("a push sends the app's elements in its order, and a pull gives back what was pushed", async () => {
		const fake = new FakeQudelixV2();
		Object.assign(fake.eqs.get(0)!, { impedance: 320, headroom: -60 });
		const device = open(fake, second());
		await device.push({ filters: five, preamp: -3.5, slot: 23 });
		expect(ids(fake)).toEqual([
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
		expect(ids(spk)).toEqual([
			[REQ, 0xa3],
			[SET, 0xa0],
			[SET, 0xa5]
		]);
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
		const before = [
			[REQ, 0x93],
			[SET, 0x90],
			[SET, 0x92]
		];
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

	test('a speaker EQ whose channels differ pulls the left one and says so', async () => {
		const fake = new FakeQudelixV2();
		fake.eqs.get(1)!.preGain = [0, -10];
		const log = vi.fn();
		expect((await open(fake, second('spk'), log).pull()).preamp).toBe(0);
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/channel 1 differs/));
	});

	test('elements the opening answer lacks are requested', async () => {
		const fake = new FakeQudelixV2();
		for (const id of [0x80, 0x90, 3]) fake.omit.add(id);
		const device = open(fake, second());
		expect(await device.eqEnabled()).toBe(true);
		expect(await device.firmware()).toBe('1.2.3');
		expect(ids(fake)).toEqual([
			[REQ, 0x80],
			[REQ, 0x90],
			[REQ, 3]
		]);
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
