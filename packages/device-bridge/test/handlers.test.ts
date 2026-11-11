// Handlers without recorded captures, the device session, and the shared codec rules.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { describe, expect, test, vi } from 'vitest';
import { wireInt } from '../src/bytes.ts';
import { airohaCodec, decodeAirohaRecords } from '../src/handlers/airoha.ts';
import { edifierCodec } from '../src/handlers/edifier-serial.ts';
import { fosiAudioCodec } from '../src/handlers/fosi-audio-usb-hid.ts';
import { decodeF110Bands, f110Frame } from '../src/handlers/fiio-f110.ts';
import { fiioSerialFrame } from '../src/handlers/fiio-usb-serial.ts';
import { encodeFiioBand } from '../src/handlers/fiio-usb-hid.ts';
import { JDS_BANDS } from '../src/handlers/jds-labs-usb-serial.ts';
import { edgeCodec } from '../src/handlers/moondrop-edge-serial.ts';
import { moondropOldFashionedHid } from '../src/handlers/moondrop-old-fashioned-hid.ts';
import {
	decodeMoondropFirmware,
	moondropUsbHid,
	moondropUsbHidCodec,
	type MoondropUsbHidOptions
} from '../src/handlers/moondrop-usb-hid.ts';
import {
	crc16Modbus,
	decodeNothingBands,
	nothingFrame
} from '../src/handlers/nothing-usb-serial.ts';
import { ritaCodec } from '../src/handlers/tanchjim-rita-serial.ts';
import { encodeWalkplayControl, walkplayHidCodec } from '../src/handlers/walkplay-hid.ts';
import { typeCodes } from '../src/io.ts';
import { utf8Decode, utf8Encode } from '../src/platform.ts';
import {
	BridgeError,
	guessProtocol,
	isBridgeError,
	openDevice,
	type HandlerContext,
	type HidTransport,
	type SerialPortIdentity,
	type StreamTransport
} from '../src/index.ts';
import { protocolFor } from './data.ts';
import { FakeDs3 } from './fake-ds3.ts';
import { FakeWalkplay } from './fake-walkplay.ts';
import { noSleep } from './replay.ts';

const pk = (freq: number, gain: number, q = 1): Filter => ({ type: 'PK', freq, gain, q });

/** A serial or BLE device simulated by a function from each write to its answer chunks. */
class ScriptedStream implements StreamTransport {
	readonly sent: Uint8Array[] = [];
	/** Received and not yet read: a test can leave stale bytes here. */
	readonly queue: Uint8Array[] = [];
	readonly kind: 'serial' | 'ble';
	readonly serial?: SerialPortIdentity;
	private readonly answer: (data: Uint8Array) => (number[] | Uint8Array)[];

	constructor(
		answer: (data: Uint8Array) => (number[] | Uint8Array)[],
		kind: 'serial' | 'ble' = 'serial',
		serial?: SerialPortIdentity
	) {
		this.answer = answer;
		this.kind = kind;
		if (serial) this.serial = serial;
	}

	async write(data: Uint8Array) {
		this.sent.push(data);
		for (const chunk of this.answer(data)) this.queue.push(Uint8Array.from(chunk));
	}
	async read() {
		return this.queue.shift() ?? null;
	}
	async close() {}
}

const protocol = (profileId: string) => {
	const p = protocolFor(profileId);
	if (!p) throw new Error(`no protocol for ${profileId}`);
	return p;
};

const open = (t: Parameters<typeof openDevice>[0], profileId: string, bandCount?: number) =>
	openDevice(t, protocol(profileId), {
		sleep: noSleep,
		...(bandCount === undefined ? {} : { profile: { bandCount } })
	});

describe('codec rules', () => {
	test('values are rounded onto the grid but never clamped', () => {
		expect(wireInt(1.234, 100, 0, 0xffff, 'q')).toBe(123);
		expect(() => wireInt(700, 100, 0, 0xffff, 'freq')).toThrow(BridgeError);
		try {
			wireInt(-1, 1, 0, 255, 'freq');
		} catch (e) {
			expect(isBridgeError(e, 'unrepresentable')).toBe(true);
		}
	});

	test('unknown wire codes survive a round trip as x-wire types', () => {
		const codes = typeCodes('test', { PK: 0, LSC: 1 });
		expect(codes.decode(7)).toBe('x-wire-7');
		expect(codes.encode('x-wire-7')).toBe(7);
		expect(() => codes.encode('HPQ')).toThrow(/no wire code/);
	});

	test('Fosi Audio frequencies must be above 0 Hz, which reads back as an empty band', () => {
		for (const freq of [0, -0, 1e-50, NaN]) {
			expect(() => fosiAudioCodec.encode({ filters: [pk(freq, 0)] }, {}), String(freq)).toThrow(
				expect.objectContaining({ code: 'unrepresentable' })
			);
		}
		const min = fosiAudioCodec.wire({}).freq as { min: number };
		const frames = fosiAudioCodec.encode({ filters: [pk(min.min, 0)] }, {});
		expect(fosiAudioCodec.decode(frames, {}).filters[0]?.freq).toBeGreaterThan(0);
	});

	test('UTF-8 agrees with the platform', () => {
		const text = 'Gain ±12 dB — 低音 🎧';
		expect(utf8Encode(text)).toEqual(Uint8Array.from(Buffer.from(text, 'utf8')));
		expect(utf8Decode(Uint8Array.from(Buffer.from(text, 'utf8')))).toBe(text);
	});
});

describe('device session', () => {
	const silentHid = (): HidTransport => ({
		kind: 'hid',
		vendorId: 0x31b2,
		productId: 0x0111,
		productName: 'TANCHJIM-ONE DSP',
		collections: [],
		sendReport: async () => {},
		sendFeatureReport: async () => {},
		receiveFeatureReport: async () => new Uint8Array(64),
		onInputReport: () => () => {},
		close: async () => {}
	});

	test('a pull needs a band count when the protocol has none', async () => {
		const device = open(silentHid(), 'tanchjim-one-dsp');
		await expect(device.pull()).rejects.toMatchObject({ code: 'invalid-request' });
	});

	test('a pull of a chosen slot is refused where only the current one can be read', async () => {
		const device = open(silentHid(), 'tanchjim-one-dsp', 5);
		expect(device.capabilities.readsSlot).toBe(false);
		await expect(device.pull({ slot: 3 })).rejects.toMatchObject({ code: 'invalid-request' });
	});

	test('write-only handlers refuse to pull', async () => {
		const t = { ...silentHid(), vendorId: 0x35d8, productName: 'Moondrop ECHO-B' };
		const device = open(t, 'moondrop-echo-b');
		expect(device.capabilities.canRead).toBe(false);
		await expect(device.pull()).rejects.toMatchObject({ code: 'unsupported' });
	});

	test('a handler only runs over its own transport', () => {
		const t = new ScriptedStream(() => []);
		expect(() => open(t, 'fiio-ka17')).toThrow(/doesn't run over a serial/);
	});

	test('devices that disconnect on save ask for a reconnect', async () => {
		const sent: number[][] = [];
		const t: HidTransport = {
			...silentHid(),
			vendorId: 0x2972,
			productName: 'JadeAudio JA11',
			sendReport: async (_id, d) => void sent.push([...d])
		};
		const device = open(t, 'jadeaudio-ja11');
		expect(device.capabilities.disconnectOnSave).toBe(true);
		const result = await device.push({ filters: [pk(100, 1)], slot: 3 });
		expect(result.reconnect).toBe(true);
		// Band, save: no preamp write when none was given, and FiiO Control never writes the count.
		expect(sent.map((d) => d[4])).toEqual([0x15, 0x19]);
	});

	test('FiiO filter types, as FiiO Control codes them', async () => {
		const sent: number[][] = [];
		const t: HidTransport = {
			...silentHid(),
			vendorId: 0x2972,
			productName: 'FIIO KA15',
			sendReport: async (_id, d) => void sent.push([...d])
		};
		const types = ['PK', 'LSC', 'HSC', 'BP', 'LPQ', 'HPQ', 'AP'] as const;
		await open(t, 'fiio-ka15').push({
			filters: types.map((type) => ({ type, freq: 100, q: 1, gain: 0 }))
		});
		expect(sent.map((d) => d[13])).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	/** A FiiO HID device that answers command `cmd` with `data()`. */
	const fiioAnswering = (
		cmd: number,
		data: () => number[],
		sent: number[][] = []
	): HidTransport => {
		const listeners = new Set<(id: number, d: Uint8Array) => void>();
		return {
			...silentHid(),
			vendorId: 0x2972,
			sendReport: async (_id, d) => {
				sent.push([...d]);
				if (d[0] !== 0xbb || d[4] !== cmd) return;
				const answer = [0xbb, 0x0b, 0, 0, cmd, data().length, ...data(), 0, 0xee];
				for (const l of listeners) l(7, Uint8Array.from(answer));
			},
			onInputReport: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			}
		};
	};

	test('FiiO presets above 255 go on the wire as two bytes', async () => {
		const sent: number[][] = [];
		const device = open(
			fiioAnswering(0x16, () => [0x01, 0x01], sent),
			'fiio-kg13'
		);
		await device.setEnabled(true, 513);
		expect(sent.at(-1)?.slice(4, 8)).toEqual([0x16, 2, 0x02, 0x01]);
		expect(await device.currentSlot()).toBe(257);
	});

	test('FiiO devices report their own band count', async () => {
		let count = 10;
		const device = open(
			fiioAnswering(0x18, () => [count]),
			'snowsky-tiny-a'
		);
		expect(device.capabilities.readsBandCount).toBe(true);
		expect(await device.bandCount()).toBe(10);
		count = 0;
		expect(await device.bandCount()).toBeNull();

		const serial = new ScriptedStream(() => [[...fiioSerialFrame(true, 0x18, [10])]]);
		expect(await open(serial, 'fiio-audio-dsp').bandCount()).toBe(10);
	});

	test('the band count is unknown where the protocol has none, or the read fails', async () => {
		const other = open({ ...silentHid(), vendorId: 0x35d8 }, 'moondrop-echo-b');
		expect(other.capabilities.readsBandCount).toBe(false);
		expect(await other.bandCount()).toBeNull();

		const unplugged: HidTransport = {
			...silentHid(),
			vendorId: 0x2972,
			sendReport: async () => {
				throw new Error('unplugged');
			}
		};
		expect(await open(unplugged, 'snowsky-tiny-a').bandCount()).toBeNull();
	});

	test('a value the wire cannot carry fails before anything is sent', async () => {
		const sent: number[][] = [];
		const t: HidTransport = {
			...silentHid(),
			vendorId: 0x2972,
			productName: 'FIIO KA17',
			sendReport: async (_id, d) => void sent.push([...d])
		};
		const device = open(t, 'fiio-ka17');
		await expect(device.push({ filters: [pk(100, 1), pk(70000, 0)] })).rejects.toMatchObject({
			code: 'unrepresentable'
		});
		await expect(
			device.push({ filters: [{ type: 'NO', freq: 100, q: 0.7, gain: 0 }] })
		).rejects.toMatchObject({ code: 'unsupported-type' });
		expect(sent).toEqual([]);
	});

	test('a preamp or slot the protocol cannot write is refused, not dropped', async () => {
		const sent: number[][] = [];
		const t: HidTransport = {
			...silentHid(),
			vendorId: 0x35d8,
			productName: 'Moondrop ECHO-B',
			sendReport: async (_id, d) => void sent.push([...d])
		};
		const device = open(t, 'moondrop-echo-b');
		expect(device.capabilities.writesPreamp).toBe(false);
		expect(device.capabilities.writesSlot).toBe(false);
		await expect(device.push({ filters: [pk(100, 1)], preamp: -6 })).rejects.toMatchObject({
			code: 'invalid-request'
		});
		await expect(device.push({ filters: [pk(100, 1)], slot: 1 })).rejects.toMatchObject({
			code: 'invalid-request'
		});
		expect(sent).toEqual([]);
	});

	test("EQ off selects the profile's bypass preset, which reads back as no slot", async () => {
		const sent: number[][] = [];
		const listeners = new Set<(id: number, d: Uint8Array) => void>();
		let preset = 240;
		const t: HidTransport = {
			...silentHid(),
			vendorId: 0x2972,
			productName: 'FIIO BTR17',
			sendReport: async (_id, d) => {
				sent.push([...d]);
				// A preset query is answered with the current preset.
				const answer = [0xbb, 0x0b, 0, 0, 0x16, 1, preset, 0, 0xee];
				if (d[0] === 0xbb && d[4] === 0x16)
					for (const l of listeners) l(7, Uint8Array.from(answer));
			},
			onInputReport: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			}
		};
		const device = open(t, 'fiio-btr17');
		expect(device.capabilities.slots).toContainEqual({ id: 240, name: 'BYPASS', bypass: true });
		await device.setEnabled(false);
		expect(sent.at(-1)?.slice(4, 7)).toEqual([0x16, 1, 240]);
		expect(await device.currentSlot()).toBeNull();
		preset = 160;
		expect(await device.currentSlot()).toBe(160);

		const noBypass = openDevice(t, { handler: 'fiio-usb-hid' }, { sleep: noSleep });
		await expect(noBypass.setEnabled(false)).rejects.toMatchObject({ code: 'invalid-request' });
	});

	test('operations run one at a time', async () => {
		const log: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const t: HidTransport = {
			...silentHid(),
			vendorId: 0x2972,
			productName: 'FIIO KA17',
			sendReport: async (_id, d) => {
				log.push(`send ${d[4]}`);
				if (log.length === 1) await gate;
			}
		};
		const device = open(t, 'fiio-ka17');
		const first = device.push({ filters: [pk(100, 1)] });
		const second = device.push({ filters: [pk(200, 2)] });
		await Promise.resolve();
		release();
		await Promise.all([first, second]);
		expect(log).toEqual(['send 21', 'send 21']);
	});
});

describe('devices without a profile', () => {
	test('a guessed protocol is experimental and needs a band count to pull', async () => {
		const t: HidTransport = {
			kind: 'hid',
			vendorId: 0x3302,
			productId: 0x9999,
			productName: 'Unknown dongle',
			collections: [],
			sendReport: async () => {},
			sendFeatureReport: async () => {},
			receiveFeatureReport: async () => new Uint8Array(64),
			onInputReport: () => () => {},
			close: async () => {}
		};
		const device = openDevice(t, guessProtocol(t.vendorId)!, { sleep: noSleep });
		expect(device.capabilities.experimental).toBe(true);
		expect(device.capabilities.types).toContain('PK');
		await expect(device.pull()).rejects.toMatchObject({ code: 'invalid-request' });
	});
});

describe('KT Micro as Tanchjim drives it', () => {
	/** Registers that answer a read with what was last written to them. */
	function ktmicro(productName: string) {
		const sent: number[][] = [];
		const registers = new Map<number, number[]>();
		const listeners = new Set<(id: number, d: Uint8Array) => void>();
		const t: HidTransport = {
			kind: 'hid',
			vendorId: 0x31b2,
			productId: 0x0111,
			productName,
			collections: [],
			sendReport: async (_id, d) => {
				sent.push([...d]);
				if (d[4] === 0x57) registers.set(d[0]!, [...d]);
				if (d[4] !== 0x52) return;
				const answer = [...(registers.get(d[0]!) ?? d)];
				answer[4] = 0x52;
				for (const l of listeners) l(0x4b, Uint8Array.from(answer));
			},
			sendFeatureReport: async () => {},
			receiveFeatureReport: async () => new Uint8Array(64),
			onInputReport: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			close: async () => {}
		};
		return { t, sent };
	}

	test('a push writes the bands 400 ms apart and commits, without the slot or preamp register', async () => {
		const { t, sent } = ktmicro('TANCHJIM-FOLA');
		const sleeps: number[] = [];
		const device = openDevice(t, protocol('tanchjim-fola'), {
			sleep: async (ms) => void sleeps.push(ms)
		});
		expect(device.capabilities).toMatchObject({
			readsPreamp: false,
			writesPreamp: false,
			readsCurrentSlot: false,
			canEnable: false
		});
		await device.push({ filters: [pk(100, -3), { type: 'LPQ', freq: 8000, gain: 0, q: 0.7 }] });
		expect(sent.map((d) => d[0])).toEqual([0x26, 0x27, 0x28, 0x29, 0]);
		expect(sent.at(-1)![4]).toBe(0x53);
		expect(sent[3]![8]).toBe(1); // low-pass
		expect(sleeps).toEqual([400, 400, 400, 400, 1000]);
		await expect(device.push({ filters: [pk(100, 1)], preamp: -3 })).rejects.toMatchObject({
			code: 'invalid-request'
		});
		await expect(device.setEnabled(false)).rejects.toMatchObject({ code: 'unsupported' });
		expect(await device.currentSlot()).toBeNull();
	});

	test('the Zero, One and Tanya are sent half the frequency and read back whole', async () => {
		const { t, sent } = ktmicro('TANCHJIM-ONE DSP');
		const device = openDevice(t, protocol('tanchjim-one-dsp'), {
			sleep: noSleep,
			profile: { bandCount: 1 }
		});
		await device.push({ filters: [pk(1000, 2)] });
		expect(sent[0]!.slice(8, 10)).toEqual([500 & 0xff, 500 >> 8]);
		const { filters, preamp } = await device.pull();
		expect(filters).toEqual([pk(1000, 2)]);
		expect(preamp).toBeUndefined();
		expect(sent.some((d) => d[0] === 0x24 || d[0] === 0x66)).toBe(false);
	});
});

describe('KT Micro as Kiwi Ears drives it', () => {
	/** Registers that answer a read with what was last written, and a write with a flag. */
	function kiwi(flag: number, seed: Record<number, number[]> = {}) {
		const sent: number[][] = [];
		const registers = new Map(Object.entries(seed).map(([r, v]) => [Number(r), v]));
		const listeners = new Set<(id: number, d: Uint8Array) => void>();
		const t: HidTransport = {
			kind: 'hid',
			vendorId: 0x31b2,
			productId: 0x0111,
			productName: 'Kiwi Ears',
			collections: [],
			sendReport: async (_id, d) => {
				sent.push([...d]);
				const answer = [...d];
				if (d[4] === 0x57) registers.set(d[0]!, [...d].slice(6));
				if (d[4] === 0x52) answer.splice(6, 4, ...(registers.get(d[0]!) ?? [0, 0, 0, 0]));
				else answer[6] = flag;
				for (const l of listeners) l(0x4b, Uint8Array.from(answer));
			},
			sendFeatureReport: async () => {},
			receiveFeatureReport: async () => new Uint8Array(64),
			onInputReport: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			close: async () => {}
		};
		return { t, sent, registers };
	}

	test('a push turns the EQ on, writes the bands 50 ms apart, then saves', async () => {
		const { t, sent } = kiwi(3);
		const sleeps: number[] = [];
		const device = openDevice(t, protocol('kiwi-ears-allegro-mini'), {
			sleep: async (ms) => void sleeps.push(ms)
		});
		expect(device.capabilities).toMatchObject({
			readsPreamp: false,
			writesPreamp: false,
			readsCurrentSlot: false,
			readsEnabled: true,
			canEnable: true
		});
		await device.push({ filters: [pk(100, -3), pk(1000, 2)] });
		expect(sent.map((d) => d[0])).toEqual([0x24, 0x26, 0x27, 0x28, 0x29, 0]);
		expect(sent[0]).toEqual([0x24, 0, 0, 0, 0x57, 0, 1, 0, 0, 0]);
		expect(sent.at(-1)![4]).toBe(0x53);
		expect(sleeps).toEqual([50, 50, 1000]);
	});

	test('a write the device answers with another flag is rejected', async () => {
		const { t } = kiwi(0);
		const device = openDevice(t, protocol('kiwi-ears-allegro-mini'), { sleep: noSleep });
		await expect(device.push({ filters: [pk(100, 1)] })).rejects.toMatchObject({
			code: 'rejected'
		});
	});

	test('the EQ switch is its own register, 0x34 past the KT0211L', async () => {
		const { t, sent } = kiwi(0x4f);
		const device = openDevice(t, protocol('kiwi-ears-chorus'), { sleep: noSleep });
		await device.setEnabled(true);
		expect(await device.eqEnabled()).toBe(true);
		await device.setEnabled(false);
		expect(await device.eqEnabled()).toBe(false);
		expect(new Set(sent.map((d) => d[0]))).toEqual(new Set([0x34]));
		expect(await device.currentSlot()).toBeNull();
	});

	test('the EQ switch only ever gets 1 or 0, whatever slot is asked for', async () => {
		const { t, sent } = kiwi(3);
		const device = openDevice(t, protocol('kiwi-ears-allegro-mini'), { sleep: noSleep });
		expect(device.capabilities.slots).toEqual([]);
		await device.setEnabled(true, 3);
		expect(sent).toEqual([[0x24, 0, 0, 0, 0x57, 0, 1, 0, 0, 0]]);
	});

	test('a device holding 3 reads as off, and a push moves it to 1', async () => {
		const { t, registers } = kiwi(3, { 0x24: [3, 0, 0, 0] });
		const device = openDevice(t, protocol('kiwi-ears-allegro-mini'), { sleep: noSleep });
		expect(await device.eqEnabled()).toBe(false);
		await device.push({ filters: [pk(100, 1)] });
		expect(registers.get(0x24)).toEqual([1, 0, 0, 0]);
	});

	test('the S-Link is written through its reordered registers', async () => {
		const { t, sent } = kiwi(0x4f);
		const device = openDevice(t, protocol('kiwi-ears-s-link'), { sleep: noSleep });
		await device.push({ filters: [pk(100, 1), pk(200, 1), pk(400, 1), pk(800, 1), pk(1600, 1)] });
		expect(sent.map((d) => d[0])).toEqual([
			0x34, 0x37, 0x38, 0x3b, 0x3c, 0x3d, 0x3f, 0x39, 0x3a, 0x35, 0x36, 0
		]);
	});

	test('global gain in steps reads and writes register 0x3b', async () => {
		const { t, sent } = kiwi(3, { 0x3b: [13, 0, 0, 0] });
		const device = openDevice(t, protocol('kiwi-ears-allegro-mini'), { sleep: noSleep });
		expect(await device.readControls()).toEqual({ globalGain: 13 });
		await device.writeControl('globalGain', 15);
		expect(sent.find((d) => d[4] === 0x57)).toEqual([0x3b, 0, 0, 0, 0x57, 0, 15, 0, 0, 0]);
		expect(await device.readControls()).toEqual({ globalGain: 15 });
	});

	test('linear global gain holds minus ten times the dB', async () => {
		const { t, sent } = kiwi(3);
		const device = openDevice(t, protocol('kiwi-ears-usb-d1'), { sleep: noSleep });
		expect(await device.readControls()).toEqual({ globalGainDb: 0 });
		await device.writeControl('globalGainDb', 1.5);
		expect(sent.find((d) => d[4] === 0x57)).toEqual([
			0x3b, 0, 0, 0, 0x57, 0, 0xf1, 0xff, 0xff, 0xff
		]);
		await device.writeControl('globalGainDb', -12);
		expect(await device.readControls()).toEqual({ globalGainDb: -12 });
	});

	test('other KT Micro brands keep their slots and report no EQ switch', () => {
		const { t } = kiwi(3);
		const device = openDevice(t, protocol('moondrop-chu-2-dsp'), { sleep: noSleep });
		expect(device.capabilities).toMatchObject({ readsEnabled: false, canEnable: true });
	});
});

describe('JDS Labs', () => {
	const describeAnswer = {
		Configuration: {
			General: { 'Input Mode': { Current: 'USB' } },
			DSP: {
				Headphone: {
					Preamp: { Gain: { Current: -3 } },
					'Lowshelf 1': {
						Type: { Current: 'LOWSHELF' },
						Frequency: { Current: 80 },
						Gain: { Current: 2 },
						Q: { Current: 0.707 }
					},
					'Peaking 1': {
						Type: { Current: 'PEAKING' },
						Frequency: { Current: 1000 },
						Gain: { Current: -1.5 },
						Q: { Current: 2 }
					}
				}
			}
		}
	};
	const json = (o: unknown) => [...Buffer.from(JSON.stringify(o) + '\0')];

	test('pull reads the named filters in device order, answers split across reads', async () => {
		const t = new ScriptedStream(() => {
			const bytes = json(describeAnswer);
			return [bytes.slice(0, 20), bytes.slice(20)];
		});
		const result = await open(t, 'jds-labs-element-iv').pull();
		expect(result.preamp).toBe(-3);
		expect(result.filters).toHaveLength(12);
		expect(result.filters[0]).toEqual({ type: 'LSC', freq: 80, q: 0.707, gain: 2 });
		expect(result.filters[1]).toBeNull(); // missing on old firmware
		expect(result.filters[2]).toEqual({ type: 'PK', freq: 1000, q: 2, gain: -1.5 });
	});

	test('push writes band i to the i-th name and checks the status', async () => {
		let update: { Configuration: { DSP: { Headphone: Record<string, unknown> } } } | undefined;
		const t = new ScriptedStream((d) => {
			update = JSON.parse(Buffer.from(d.subarray(0, d.length - 1)).toString());
			return [json({ Status: true })];
		});
		const filters = JDS_BANDS.map((_, i) =>
			i < 2 ? { type: 'LSC' as const, freq: 80, q: 0.7, gain: 1 } : pk(1000 + i, 0)
		);
		await open(t, 'jds-labs-element-iv').push({ filters, preamp: -2 });
		const hp = update!.Configuration.DSP.Headphone;
		expect(hp['Lowshelf 1']).toEqual({ Gain: 1, Frequency: 80, Q: 0.7, Type: 'LOWSHELF' });
		expect(hp['Highshelf 2']).toEqual({ Gain: 0, Frequency: 1011, Q: 1, Type: 'PEAKING' });
		expect(hp.Preamp).toEqual({ Gain: -2, Mode: 'AUTO' });

		const refused = new ScriptedStream(() => [json({ Status: false })]);
		await expect(open(refused, 'jds-labs-element-iv').push({ filters })).rejects.toMatchObject({
			code: 'rejected'
		});
	});
});

describe('Nothing', () => {
	test('frames carry a CRC-16/MODBUS over header and payload', () => {
		const frame = nothingFrame(49183, [], 1);
		expect([...frame.subarray(0, 8)]).toEqual([0x55, 0x60, 0x01, 0x1f, 0xc0, 0, 0, 1]);
		expect(frame[8]! | (frame[9]! << 8)).toBe(crc16Modbus(frame, 0, 8));
	});

	test('pull reads the custom preset; another active preset has no bands', async () => {
		const bands = [pk(100, 2, 0.7), { type: 'LSC' as const, freq: 60, q: 0.5, gain: 4 }];
		const values = (mode: number) =>
			new ScriptedStream((d) => {
				const cmd = d[3]! | (d[4]! << 8);
				if (cmd === 49183) return [[...nothingFrame(16415, [mode], 1)]];
				const body = [0, 2, ...[0, 0, 0x40, 0xc0], ...encodeNothingBody(bands)];
				return [[...nothingFrame(16461, body, 2)]];
			});
		const result = await open(values(5), 'nothing-headphone-1').pull();
		expect(result.preamp).toBe(-3);
		expect(result.filters).toEqual([pk(100, 2, 0.7), bands[1]]);
		await expect(open(values(1), 'nothing-headphone-1').pull()).rejects.toMatchObject({
			code: 'unsupported'
		});
	});

	function encodeNothingBody(filters: Filter[]): number[] {
		const f32 = (v: number) => [...Buffer.from(new Float32Array([v]).buffer)];
		return filters.flatMap((f) => [
			f.type === 'LSC' ? 0 : f.type === 'HSC' ? 2 : 1,
			...f32(f.gain),
			...f32(f.freq),
			...f32(f.q)
		]);
	}

	test('decoding a write payload gives the bands back', () => {
		const frame = nothingFrame(
			61520,
			[0, 1, ...[0, 0, 0, 0], 1, 0, 0, 0x80, 0x3f, 0, 0, 0x7a, 0x44, 0, 0, 0x80, 0x3f],
			1
		);
		expect(decodeNothingBands(frame)).toEqual({ filters: [pk(1000, 1, 1)], preamp: 0 });
	});
});

describe('FiiO USB serial', () => {
	test('pull asks for the count, the preamp and each band', async () => {
		const bands = [pk(100, -2.5, 0.71), { type: 'HSC' as const, freq: 8000, q: 0.7, gain: 3 }];
		const t = new ScriptedStream((d) => {
			const cmd = d[4];
			if (cmd === 0x18) return [[...fiioSerialFrame(true, 0x18, [2])]];
			if (cmd === 0x17) return [[...fiioSerialFrame(true, 0x17, [0xff, 0xec])]];
			const i = d[6]!;
			// Split the answer to exercise reassembly.
			const answer = [...fiioSerialFrame(true, 0x15, [i, ...encodeFiioBand(bands[i]!)])];
			return [answer.slice(0, 5), answer.slice(5)];
		});
		const result = await open(t, 'fiio-audio-dsp').pull();
		expect(result).toEqual({ filters: bands, preamp: -2 });
	});

	test('stale answers are not taken for the answer to a request', async () => {
		const band = pk(100, -2.5, 0.71);
		const t = new ScriptedStream((d) => {
			const cmd = d[4]!;
			// A late acknowledgement of an earlier write arrives ahead of each answer.
			const stale = [...fiioSerialFrame(false, 0x19, [0])];
			if (cmd === 0x18) return [stale, [...fiioSerialFrame(true, 0x18, [1])]];
			if (cmd === 0x17) return [stale, [...fiioSerialFrame(true, 0x17, [0xff, 0xe7])]];
			return [stale, [...fiioSerialFrame(true, 0x15, [0, ...encodeFiioBand(band)])]];
		});
		// Left over from before the pull, with the same command as its first request.
		t.queue.push(Uint8Array.from(fiioSerialFrame(false, 0x18, [5])));
		const result = await open(t, 'fiio-audio-dsp').pull();
		expect(result).toEqual({ filters: [band], preamp: -2.5 });
	});

	test('push writes the preamp, each band and the save', async () => {
		const t = new ScriptedStream((d) => [[...fiioSerialFrame(false, d[4]!, [0])]]);
		await open(t, 'fiio-audio-dsp').push({
			filters: [pk(100, 1)],
			preamp: -1,
			slot: 160
		});
		expect(t.sent.map((d) => [...d])).toEqual([
			[0xaa, 0x0a, 0, 0, 0x17, 2, 0xff, 0xf6, 0, 0xee],
			[...fiioSerialFrame(false, 0x15, [0, ...encodeFiioBand(pk(100, 1))])],
			[0xaa, 0x0a, 0, 0, 0x19, 1, 160, 0, 0xee]
		]);
	});
});

describe('FiiO F1 10 (EH11, EH13)', () => {
	const bands = Array.from({ length: 10 }, (_, i) => pk(100 * (i + 1), i - 5, 0.7 + i / 10));
	const answer = () => [
		...f110Frame(0x03, 0x0d, [1, 0, 9, ...bands.flatMap((f) => encodeFiioBand(f))])
	];

	test('pull decodes the 80-byte answer over BLE', async () => {
		const t = new ScriptedStream((d) => (d[4] === 0x03 ? [answer()] : []), 'ble');
		const result = await open(t, 'fiio-eh13').pull();
		expect(result.filters.map((f) => f && { ...f, q: Math.round(f.q * 100) / 100 })).toEqual(
			bands.map((f) => ({ ...f, q: Math.round(f.q * 100) / 100 }))
		);
		expect(answer()).toHaveLength(80);
	});

	test('decoding checks the command', () => {
		expect(() => decodeF110Bands(f110Frame(0x13, 0x0d, new Array(73).fill(0)))).toThrow(
			BridgeError
		);
	});
});

describe('Bluetooth codecs', () => {
	test('Rita writes 12 bands of 7 bytes', () => {
		const [frame] = ritaCodec.encode(
			{ filters: Array.from({ length: 12 }, () => pk(1000, -1.5, 0.7)) },
			{}
		);
		expect(frame).toHaveLength(90);
		expect([...frame!.subarray(0, 12)]).toEqual([
			0xff, 0xa1, 0x56, 0x2b, 0x0c, 0x01, 0xff, 0x6a, 0x03, 0xe8, 0x00, 0x46
		]);
		expect(frame!.at(-1)).toBe(0xaa);
	});

	test("Moondrop Edge shifts each band's gain into the next slot", () => {
		const bands = [pk(50, 1), pk(200, -2), pk(1000, 3, 2), pk(4000, -4), pk(10000, 5, 0.5)];
		const [frame] = edgeCodec.encode({ filters: bands }, {});
		expect(frame!.subarray(8)).toHaveLength(39);
		// Band 0's gain (+1 dB = 60) sits in band 1's slot.
		expect([...frame!.subarray(8 + 2 + 7, 8 + 2 + 9)]).toEqual([0x00, 0x3c]);
	});

	test('Edifier sends only tabled frequencies', () => {
		const filters = Array.from({ length: 4 }, () => pk(1000, 0, 1));
		const frames = edifierCodec.encode({ filters }, {});
		expect([...frames[0]!]).toEqual([
			0xaa, 0xec, 0x44, 0x00, 0x06, 0xa5, 0xa5, 0xa6, 0x4d, 0xa9, 0xa3, 0x69
		]);
		expect(() =>
			edifierCodec.encode({ filters: [pk(1001, 0, 1), ...filters.slice(1)] }, {})
		).toThrow(/no frequency code/);
	});

	test('Airoha writes 32-bit frequencies over SPP and the read layout over BLE', () => {
		const filters = Array.from({ length: 10 }, (_, i) => pk(1000 + i * 1000, i - 3, 1.5));
		const [spp] = airohaCodec.encode({ filters, slot: 2 }, {});
		expect(spp![3]! | (spp![4]! << 8)).toBe(spp!.length - 3);
		expect(airohaCodec.decode([spp!], {})).toEqual({ filters, slot: 2 });
		const [ble] = airohaCodec.encode({ filters }, { ble: true });
		expect(decodeAirohaRecords(ble!, 10)).toEqual(filters);
	});
});

describe('Fosi Audio DS3', () => {
	const ds3 = (t: FakeDs3) => open(t, 'fosi-audio-ds3', 32);

	test('reads the active preset, which stays when the EQ is off', async () => {
		const t = new FakeDs3();
		t.active = 3;
		const device = ds3(t);
		expect(device.capabilities).toMatchObject({ readsCurrentSlot: true, readsEnabled: true });
		expect(await device.currentSlot()).toBe(3);
		expect(await device.eqEnabled()).toBe(true);
		await device.setEnabled(false);
		expect(await device.eqEnabled()).toBe(false);
		expect(await device.currentSlot()).toBe(3);
		await device.setEnabled(true, 8);
		expect([await device.currentSlot(), await device.eqEnabled()]).toEqual([8, true]);
	});

	test('a push leaves the device on the preset it wrote, with the EQ on', async () => {
		const t = new FakeDs3();
		t.eqOn = false;
		const device = ds3(t);
		await device.push({ filters: [pk(100, 3)], slot: 9 });
		expect([await device.currentSlot(), await device.eqEnabled()]).toEqual([9, true]);
	});

	test('reads the firmware version once', async () => {
		const t = new FakeDs3();
		const device = ds3(t);
		expect(device.capabilities.readsFirmware).toBe(true);
		expect(await device.firmware()).toBe('1.5.8');
		t.firmware = [0x01, 0x04, 0x15];
		expect(await device.firmware()).toBe('1.5.8');
		expect(t.sent.filter((c) => c === 0xa6)).toHaveLength(1);
		expect(await ds3(t).firmware()).toBe('1.4.15');
	});

	test('reads the controls the device has now', async () => {
		const t = new FakeDs3();
		expect(await ds3(t).readControls()).toEqual({
			uacMode: 0,
			gainMode: 0,
			volume: 20,
			led: 1,
			filterMode: 0,
			upsample: 0,
			gameMode: null
		});
		t.values.uacMode = 1;
		t.values.gameMode = 2;
		const uac1 = await ds3(t).readControls();
		expect([uac1.filterMode, uac1.upsample, uac1.gameMode]).toEqual([null, null, 2]);
		const old = new FakeDs3();
		old.firmware = [0x01, 0x04, 0x08];
		expect((await ds3(old).readControls()).upsample).toBeNull();
	});

	test('writes a control and reads it back; refuses what the profile does not list', async () => {
		const t = new FakeDs3();
		const device = ds3(t);
		expect(await device.writeControl('volume', 30)).toEqual({ reconnect: false });
		expect(t.values.volume).toBe(30);
		await expect(device.writeControl('volume', 61)).rejects.toMatchObject({
			code: 'invalid-request'
		});
		await expect(device.writeControl('volume', 30.5)).rejects.toMatchObject({
			code: 'invalid-request'
		});
		await expect(device.writeControl('bass', 0)).rejects.toMatchObject({ code: 'invalid-request' });
		await expect(device.writeControl('gameMode', 1)).rejects.toMatchObject({ code: 'unsupported' });
		t.stuck = 'gainMode';
		await expect(device.writeControl('gainMode', 1)).rejects.toMatchObject({ code: 'rejected' });
		expect(await device.writeControl('led', 0)).toEqual({ reconnect: false });
		expect(t.values.led).toBe(0);
		expect(await device.writeControl('uacMode', 1)).toEqual({ reconnect: true });
		expect(t.values.uacMode).toBe(1);
	});

	test('takes the device dropping during a write that restarts it as the restart', async () => {
		const t = new FakeDs3();
		const device = ds3(t);
		await device.readControls();
		const lost = () => {
			throw new BridgeError('transport', 'WebHID: sendReport failed');
		};
		t.sendReport = t.sendFeatureReport = async (_id, data) => {
			if (data[1] === 0x9b || data[1] === 0x93) lost();
		};
		expect(await device.writeControl('uacMode', 1)).toEqual({ reconnect: true });
		await expect(device.writeControl('volume', 30)).rejects.toMatchObject({ code: 'transport' });
	});

	test('reads 8 bands of a built-in preset, all of a user preset, and the pre-gain', async () => {
		const t = new FakeDs3();
		const device = ds3(t);
		const builtIn = await device.pull({ slot: 2 });
		expect(builtIn.filters).toHaveLength(8);
		expect(builtIn.preamp).toBe(-3);
		const user = await device.pull({ slot: 7 });
		expect(user.filters).toHaveLength(32);
		expect(user.filters[0]).toEqual({ type: 'PK', freq: 1000, q: 1, gain: 0 });
	});

	test('writes the pre-gain and keeps the preset name', async () => {
		const t = new FakeDs3();
		const device = ds3(t);
		await device.push({ filters: [pk(100, 3), pk(1000, -2)], preamp: -6, slot: 7 });
		expect(t.presets.get(7)).toEqual({ gain: -6, name: 'MyCurve' });
		const back = await device.pull({ slot: 7, bands: 2 });
		expect(back).toEqual({ filters: [pk(100, 3), pk(1000, -2)], slot: 7, preamp: -6 });
	});

	test('pull and push never touch the controls', async () => {
		const t = new FakeDs3();
		const device = ds3(t);
		await device.pull({ slot: 7 });
		await device.push({ filters: [pk(100, 3)], slot: 7 });
		const controlCommands = [0x93, 0xa0, 0xa2, 0xa4, 0x80, 0x9b, 0x96];
		expect(t.sent.filter((c) => controlCommands.includes(c))).toEqual([]);
	});
});

describe('Walkplay controls and firmware (NICEHCK PureAural)', () => {
	const pureAural = (t: FakeWalkplay) => open(t, 'nicehck-pureaural', 10);

	test('reads the firmware version from the ASCII answer', async () => {
		const t = new FakeWalkplay();
		const device = pureAural(t);
		expect(device.capabilities.readsFirmware).toBe(true);
		expect(await device.firmware()).toBe('1.0.3');
	});

	test('reads every control, the gains in dB', async () => {
		expect(await pureAural(new FakeWalkplay()).readControls()).toEqual({
			dacFilter: 2,
			workMode: 0,
			gainLevel: 1,
			volume: 60,
			micGain: 3,
			leftGain: 0,
			rightGain: -4
		});
	});

	test('sends a band the device lost again, with the commit', async () => {
		const t = new FakeWalkplay();
		t.asleep = true;
		await pureAural(t).push({ filters: [pk(200, 1, 1), pk(300, 2, 1)], preamp: -3 });
		expect(t.bands.get(0)).toEqual([200, 1, 1, 2, 101]);
		expect(t.bands.get(1)).toEqual([300, 1, 2, 2, 101]);
		// Band 0 is sent again; band 1 isn't.
		expect(t.sent.filter(([op, cmd]) => op === 0x01 && cmd === 0x09)).toHaveLength(3);
	});

	test('a band the device never takes is an error', async () => {
		const t = new FakeWalkplay();
		t.stuck = 'band';
		await expect(pureAural(t).push({ filters: [pk(200, 1, 1)] })).rejects.toMatchObject({
			code: 'rejected'
		});
	});

	test('has no EQ switch, which Walkplay devices lack', async () => {
		expect(pureAural(new FakeWalkplay()).capabilities.canEnable).toBe(false);
		const micro = open(new FakeWalkplay(), 'crinear-protocol-micro', 8);
		expect(micro.capabilities.canEnable).toBe(false);
		await expect(micro.setEnabled(false)).rejects.toMatchObject({ code: 'unsupported' });
	});

	test('reads past what earlier reports leave in the answer buffer', async () => {
		const t = new FakeWalkplay();
		const device = pureAural(t);
		await device.push({ filters: [pk(200, 1, 1)], preamp: -3 });
		await device.writeControl('micGain', -4.5);
		expect(await device.firmware()).toBe('1.0.3');
		const { leftGain, rightGain } = await device.readControls();
		expect([leftGain, rightGain]).toEqual([0, -4]);
	});

	test('writes a control and reads it back; refuses what the profile does not list', async () => {
		const t = new FakeWalkplay();
		const device = pureAural(t);
		expect(await device.writeControl('micGain', -4.5)).toEqual({ reconnect: false });
		expect(t.values.micGain).toBe(-4.5);
		// The app follows a mic gain write with 0x04.
		expect(t.sent.slice(-3)).toEqual([
			[0x01, 0x02],
			[0x01, 0x04],
			[0x80, 0x02]
		]);
		await device.writeControl('leftGain', -10);
		expect([t.values.leftGain, t.values.rightGain]).toEqual([-10, -4]);
		await expect(device.writeControl('dacFilter', 0)).rejects.toMatchObject({
			code: 'invalid-request'
		});
		await expect(device.writeControl('rightGain', 1)).rejects.toMatchObject({
			code: 'invalid-request'
		});
		t.stuck = 'volume';
		await expect(device.writeControl('volume', 10)).rejects.toMatchObject({ code: 'rejected' });
	});

	test("sends nothing after a mic gain write by default, as Walkplay's app", async () => {
		const t = new FakeWalkplay();
		const device = open(t, 'crinear-protocol-micro', 8);
		expect(await device.writeControl('micGain', -4.5)).toEqual({ reconnect: false });
		expect(t.values.micGain).toBe(-4.5);
		expect(t.sent.slice(-2)).toEqual([
			[0x01, 0x02],
			[0x80, 0x02]
		]);
		expect(encodeWalkplayControl('micGain', -4.5)).toEqual([0x01, 0x02, 2, 0x80, 0xfb]);
	});

	test('reads again while the device is busy after a write', async () => {
		const t = new FakeWalkplay();
		t.busyAfter = { 0x1d: 2, 0x04: 1 };
		const device = pureAural(t);
		expect(await device.writeControl('workMode', 1)).toEqual({ reconnect: false });
		expect(await device.writeControl('micGain', 1.5)).toEqual({ reconnect: false });
		// Each dropped read was sent again.
		expect(t.sent.filter(([op, cmd]) => op === 0x80 && cmd === 0x1d)).toHaveLength(3);
		expect(t.sent.filter(([op, cmd]) => op === 0x80 && cmd === 0x02)).toHaveLength(2);
	});

	test('reads back once more before calling a write rejected', async () => {
		const t = new FakeWalkplay();
		t.lagging = true;
		const device = pureAural(t);
		expect(await device.writeControl('volume', 50)).toEqual({ reconnect: false });
		expect(t.sent.filter(([op, cmd]) => op === 0x80 && cmd === 0x85)).toHaveLength(2);
	});

	test('pull and push never touch the controls', async () => {
		const t = new FakeWalkplay();
		const device = pureAural(t);
		const pulled = await device.pull({ bands: 2 });
		expect(pulled).toEqual({ filters: [pk(100, 3.5, 0.75), pk(3000, -1.25, 2)], preamp: -2 });
		await device.push({ filters: [pk(200, 1, 1)], preamp: -3 });
		expect(t.bands.get(0)).toEqual([200, 1, 1, 2, 101]);
		expect(t.preamp).toBe(-3);
		const controlCommands = [0x11, 0x19, 0x1d, 0x85, 0x02, 0x16];
		expect(t.sent.filter(([, c]) => controlCommands.includes(c))).toEqual([]);
	});
});

describe("Walkplay writes as the vendors' apps send them", () => {
	const hex = (d: ArrayLike<number>) => Buffer.from(Array.from(d)).toString('hex');
	const tail = (options: Parameters<typeof walkplayHidCodec.encode>[1]) =>
		walkplayHidCodec
			.encode({ filters: [pk(100, 1)], preamp: -2 }, options)
			.slice(1)
			.map((f) => hex(f.data));

	test("ends as NICEHCK's app does: apply, save, pre-gain, [1,0x04]", () => {
		// test/recordings/2026-10-28-nicehck-pureaural.json, after the band frames.
		expect(tail({})).toEqual(['010a040000ffff', '010100', '01030200fe', '0104']);
	});

	test("sends the pre-gain with the bands, as Tanchjim's app does", () => {
		expect(tail({ preampWithBands: true })).toEqual(['01030200fe', '010a040000ffff', '010100']);
	});

	test("never sends devicePEQ's [1,5,…] or [1,0x17,…], Walkplay's factory reset", async () => {
		const t = new FakeWalkplay();
		await open(t, 'tanchjim-space-ii').push({ filters: [pk(200, 1)], preamp: -3 });
		expect(t.sent.filter(([op, c]) => op === 0x01 && (c === 0x05 || c === 0x17))).toEqual([]);
		expect(t.bands.get(0)).toEqual([200, 1, 1, 2, 101]);
		expect(t.preamp).toBe(-3);
	});

	test("follows a Space II volume write with [1,0x04], as Tanchjim's app does", async () => {
		const t = new FakeWalkplay();
		const device = open(t, 'tanchjim-space-ii');
		expect(await device.writeControl('volume', 40)).toEqual({ reconnect: false });
		expect(t.values.volume).toBe(40);
		expect(t.sent.slice(-3)).toEqual([
			[0x01, 0x85],
			[0x01, 0x04],
			[0x80, 0x85]
		]);
		await expect(device.writeControl('volume', 61)).rejects.toMatchObject({
			code: 'invalid-request'
		});
	});

	test('reads and writes DRE, which the device holds as 0 on', async () => {
		const t = new FakeWalkplay();
		const device = open(t, 'tanchjim-space-ii');
		expect((await device.readControls()).dre).toBe(1);
		await device.writeControl('dre', 0);
		expect(t.values.dre).toBe(1);
		expect(encodeWalkplayControl('dre', 1)).toEqual([0x01, 0x32, 1, 0]);
	});
});

/** A HID device simulated by a function from each report sent to the reports it answers with. */
function scriptedHid(answer: (data: number[]) => number[][] = () => []) {
	const sent: number[][] = [];
	const listeners = new Set<(id: number, d: Uint8Array) => void>();
	const t: HidTransport = {
		kind: 'hid',
		vendorId: 0x35d8,
		productId: 0x011c,
		productName: 'MOONDROP Marigold',
		collections: [],
		sendReport: async (_id, d) => {
			sent.push([...d]);
			for (const a of answer([...d])) for (const l of listeners) l(0x4b, Uint8Array.from(a));
		},
		sendFeatureReport: async () => {},
		receiveFeatureReport: async () => new Uint8Array(64),
		onInputReport: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close: async () => {}
	};
	return { t, sent };
}

const hidContext = <O>(
	t: HidTransport,
	options: O,
	sleeps: number[] = []
): HandlerContext<HidTransport, O> => ({
	transport: t,
	options,
	sleep: async (ms) => void sleeps.push(ms),
	log: () => {}
});

describe("Moondrop USB HID as Moondrop's web app drives it", () => {
	const s16 = (db: number) => {
		const v = Math.round(db * 256) & 0xffff;
		return [v & 0xff, v >> 8];
	};
	const hz = (freq: number) => [freq & 0xff, freq >> 8];
	/** An answer of 63 bytes: the header, and bytes from the given offsets. */
	const answer = (header: number[], at: Record<number, number[]> = {}) => {
		const d = new Array<number>(63).fill(0);
		header.forEach((b, i) => (d[i] = b));
		for (const [i, bytes] of Object.entries(at)) bytes.forEach((b, k) => (d[Number(i) + k] = b));
		return d;
	};
	/** The command byte of every frame. */
	const cmds = (sent: number[][]) => sent.map((d) => d[1]);
	const run = async (
		options: MoondropUsbHidOptions,
		request: Parameters<typeof moondropUsbHid.push>[1]
	) => {
		const { t, sent } = scriptedHid();
		const sleeps: number[] = [];
		await moondropUsbHid.push(hidContext(t, options, sleeps), request);
		return { sent, sleeps };
	};
	const lpq: Filter = { type: 'LPQ', freq: 8000, gain: 0, q: 0.7 };
	const two = { filters: [pk(100, -3, 0.7), lpq] };

	test('a push selects the slot, writes the bands, applies once, sets the pre-gain and saves', async () => {
		const { sent, sleeps } = await run({}, { ...two, preamp: -2 });
		expect(cmds(sent)).toEqual([0x0f, 9, 9, 0x0a, 0x23, 1]);
		expect(sent.every((d) => d.length === 63 && d[0] === 1)).toBe(true);
		expect(sent[0]!.slice(0, 4)).toEqual([1, 0x0f, 1, 7]);
		expect(sent[3]!.slice(0, 7)).toEqual([1, 0x0a, 4, 0, 0, 0xff, 0xff]);
		expect(sent[4]!.slice(0, 5)).toEqual([1, 0x23, 2, ...s16(-2)]);
		expect(sent[5]!.slice(0, 3)).toEqual([1, 1, 0]);
		expect(sleeps).toEqual([150, 25, 25, 50, 50, 200]);
		// The band: length 0x21, band index, freq, q, gain, type, 0, slot.
		expect(sent[1]!.slice(0, 7)).toEqual([1, 9, 0x21, 0, 0, 0, 0]);
		expect(sent[1]!.slice(27, 36)).toEqual([100, 0, ...s16(0.7), ...s16(-3), 2, 0, 7]);
		expect(sent[2]![4]).toBe(1);
		expect(sent[2]![33]).toBe(4);
	});

	test('a push without a pre-gain writes none', async () => {
		const { sent } = await run({}, two);
		expect(cmds(sent)).toEqual([0x0f, 9, 9, 0x0a, 1]);
	});

	test('every band frame reads back through the codec, whichever its layout', () => {
		const filters: Filter[] = [
			pk(100, -3, 0.7),
			{ type: 'LSC', freq: 200, gain: 4.5, q: 0.5 },
			{ type: 'HSC', freq: 9000, gain: -2, q: 0.8 },
			{ type: 'LPQ', freq: 12000, gain: 0, q: 1 },
			{ type: 'HPQ', freq: 30, gain: 0, q: 0.7 }
		];
		const sizes = { biquad: 36, compact: 14, wide: 34 } as const;
		for (const bandFrame of ['biquad', 'compact', 'wide'] as const) {
			const o: MoondropUsbHidOptions = { bandFrame };
			const frames = moondropUsbHidCodec.encode({ filters, preamp: -1.5 }, o);
			const bands = frames.filter((f) => f.data[1] === 9);
			expect(bands).toHaveLength(5);
			for (const f of bands) {
				expect(f.data).toHaveLength(63);
				expect(f.data[2]).toBe(sizes[bandFrame] - 3);
				expect([...f.data.slice(sizes[bandFrame])].every((b) => b === 0)).toBe(true);
			}
			const state = moondropUsbHidCodec.decode(frames, o);
			expect(state.filters.map((f) => f?.type)).toEqual(filters.map((f) => f.type));
			expect(state.filters).toEqual(filters.map((f) => ({ ...f, q: Math.round(f.q * 256) / 256 })));
			expect(state.preamp).toBe(-1.5);
		}
		const one = { filters: [pk(1000, 2, 1)] };
		const compact = moondropUsbHidCodec.encode(one, { bandFrame: 'compact' })[1]!.data;
		expect([...compact.slice(0, 14)]).toEqual([
			1,
			9,
			0x0b,
			0,
			0,
			0,
			0,
			0xe8,
			3,
			...s16(1),
			...s16(2),
			2
		]);
		const wide = moondropUsbHidCodec.encode(one, { bandFrame: 'wide' })[1]!.data;
		expect([...wide.slice(0, 7)]).toEqual([1, 9, 0x1f, 0, 0, 0, 0]);
		expect([...wide.slice(7, 27)].every((b) => b === 0)).toBe(true);
		expect([...wide.slice(27, 34)]).toEqual([0xe8, 3, ...s16(1), ...s16(2), 2]);
	});

	test('the commit is an apply, the commit command, or nothing with its wait kept', async () => {
		const apply = await run({ commit: 'apply' }, two);
		expect(apply.sent.filter((d) => d[1] === 0x0a)).toHaveLength(1);
		const commit = await run({ commit: 'commit' }, two);
		expect(cmds(commit.sent)).toEqual([0x0f, 9, 9, 0x60, 1]);
		expect(commit.sent[3]!.slice(0, 3)).toEqual([1, 0x60, 0]);
		const none = await run({ commit: 'none' }, two);
		expect(cmds(none.sent)).toEqual([0x0f, 9, 9, 1]);
		expect(none.sleeps).toEqual([150, 25, 25, 50, 200]);
	});

	test('selectSlot false skips the selection, and the custom slot is named twice', async () => {
		const off = await run({ selectSlot: false }, two);
		expect(cmds(off.sent)).toEqual([9, 9, 0x0a, 1]);
		expect(off.sleeps).toEqual([25, 25, 50, 200]);
		const slot = await run({ customSlot: 3 }, two);
		expect(slot.sent[0]!.slice(0, 4)).toEqual([1, 0x0f, 1, 3]);
		expect(slot.sent[1]![35]).toBe(3);
	});

	test('duckPreamp sets -128 dB while the bands are written, and only with a preamp', async () => {
		const ducked = await run({ duckPreamp: true }, { ...two, preamp: -4 });
		expect(cmds(ducked.sent)).toEqual([0x0f, 0x23, 9, 9, 0x0a, 0x23, 1]);
		expect(ducked.sent[1]!.slice(0, 5)).toEqual([1, 0x23, 2, 0x00, 0x80]);
		expect(ducked.sent[5]!.slice(0, 5)).toEqual([1, 0x23, 2, ...s16(-4)]);
		expect(ducked.sleeps).toEqual([150, 50, 25, 25, 50, 50, 200]);
		const frames = moondropUsbHidCodec.encode({ ...two, preamp: -4 }, { duckPreamp: true });
		expect(moondropUsbHidCodec.decode(frames, { duckPreamp: true }).preamp).toBe(-4);
		const plain = await run({ duckPreamp: true }, two);
		expect(plain.sent.some((d) => d[1] === 0x23)).toBe(false);
	});

	test('saveOffsets ends the push with [1,4,0]', async () => {
		const { sent, sleeps } = await run({ saveOffsets: true }, two);
		expect(sent.at(-1)!.slice(0, 3)).toEqual([1, 4, 0]);
		expect(sent.at(-1)).toHaveLength(63);
		expect(sleeps.slice(-2)).toEqual([200, 200]);
	});

	test('a value the wire cannot carry fails before anything is sent', async () => {
		const { t, sent } = scriptedHid();
		await expect(
			moondropUsbHid.push(hidContext(t, {}), { filters: [pk(100, 3, 1), pk(30000, 0)] })
		).rejects.toMatchObject({ code: 'unrepresentable' });
		expect(sent).toEqual([]);
	});

	test('the link is asked about before each part, and an unlinked headset is refused', async () => {
		const link = (linked: number) =>
			scriptedHid((d) => (d[0] === 0x80 && d[1] === 0x31 ? [answer([0x80, 0x31, 0, linked])] : []));
		const unlinked = link(0);
		const sleeps: number[] = [];
		await expect(
			moondropUsbHid.push(hidContext(unlinked.t, { linkCheck: true }, sleeps), two)
		).rejects.toMatchObject({ code: 'rejected', message: /not linked/ });
		expect(unlinked.sent).toEqual([[0x80, 0x31, 0]]);
		expect(sleeps).toEqual([50]);
		const options = { linkCheck: true };
		await expect(
			moondropUsbHid.pull(hidContext(unlinked.t, options), { bands: 1 })
		).rejects.toMatchObject({
			code: 'rejected'
		});
		const gain = moondropUsbHid.controls!.globalGain!;
		await expect(gain.read(hidContext(unlinked.t, options))).rejects.toMatchObject({
			code: 'rejected'
		});
		await expect(gain.write(hidContext(unlinked.t, options), -3)).rejects.toMatchObject({
			code: 'rejected'
		});
		expect(unlinked.sent.every((d) => d[0] === 0x80 && d[1] === 0x31)).toBe(true);

		const linked = link(1);
		await moondropUsbHid.push(hidContext(linked.t, options), two);
		expect(cmds(linked.sent)).toEqual([0x31, 0x0f, 0x31, 9, 9, 0x31, 0x0a, 0x31, 1]);
		const plain = link(0);
		await moondropUsbHid.push(hidContext(plain.t, {}), two);
		expect(plain.sent.some((d) => d[1] === 0x31)).toBe(false);
	});

	/** A headset holding bands, a pre-gain, a global gain and a firmware. */
	const headset = (layout: 'full' | 'compact' = 'full') => {
		const bands: Record<number, number[]> = {
			0: [...hz(100), ...s16(0.75), ...s16(-3), 2],
			1: [...hz(8000), ...s16(1), ...s16(0), 4],
			2: [...hz(500), ...s16(1), ...s16(2), 0],
			3: [...hz(5), ...s16(1), ...s16(2), 2],
			4: [...hz(2000), ...s16(1), ...s16(1.5), 5]
		};
		return scriptedHid((d) => {
			if (d[0] !== 0x80) return [];
			if (d[1] === 9) {
				const at = layout === 'compact' ? 7 : 27;
				return [answer([0x80, 9, 2, 0, d[4]!], { [at]: bands[d[4]!] ?? [0, 0, 0, 0, 0, 0, 0] })];
			}
			if (d[1] === 0x23) return [answer([0x80, 0x23, 2, ...s16(-5)])];
			if (d[1] === 0x03) return [answer([0x80, 0x03, 2, ...s16(-9.5)])];
			if (d[1] === 0x0f) return [answer([0x80, 0x0f, 1, 7])];
			if (d[1] === 0x0c) return [answer([0x80, 0x0c, 3, 0x30, 0x2e, 0, 0x31, 0, 0])];
			return [];
		});
	};

	test('a pull reads each band, then the pre-gain from 0x23 and not the global gain', async () => {
		for (const layout of ['full', 'compact'] as const) {
			const { t, sent } = headset(layout);
			const sleeps: number[] = [];
			const options: MoondropUsbHidOptions = layout === 'compact' ? { bandFrame: 'compact' } : {};
			const result = await moondropUsbHid.pull(hidContext(t, options, sleeps), { bands: 5 });
			expect(sent).toEqual([
				[0x80, 9, 2, 0, 0],
				[0x80, 9, 2, 0, 1],
				[0x80, 9, 2, 0, 2],
				[0x80, 9, 2, 0, 3],
				[0x80, 9, 2, 0, 4],
				[0x80, 0x23, 0]
			]);
			expect(sleeps).toEqual([50, 50, 50, 50, 50]);
			expect(result.preamp).toBe(-5);
			expect(result.filters).toEqual([
				pk(100, -3, 0.75),
				{ type: 'LPQ', freq: 8000, gain: 0, q: 1 },
				null, // type 0: off
				null, // 5 Hz: unset
				{ type: 'HPQ', freq: 2000, gain: 1.5, q: 1 }
			]);
		}
	});

	test('a pull waits 2 s for an answer', async () => {
		vi.useFakeTimers();
		try {
			const { t } = scriptedHid();
			let outcome: unknown;
			void moondropUsbHid
				.pull(hidContext(t, {}), { bands: 1 })
				.catch((e: unknown) => void (outcome = e));
			await vi.advanceTimersByTimeAsync(1999);
			expect(outcome).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1);
			expect(outcome).toMatchObject({ code: 'timeout' });
		} finally {
			vi.useRealTimers();
		}
	});

	test('reads the current slot and the firmware, which is null unless a dotted number', async () => {
		const { t } = headset();
		expect(await moondropUsbHid.currentSlot!(hidContext(t, {}))).toBe(7);
		expect(await moondropUsbHid.firmware!(hidContext(t, {}))).toBe('0.1');
		expect(decodeMoondropFirmware([0x80, 0x0c, 0, 0x31, 0x2e, 0x32, 0x2e, 0x33])).toBe('1.2.3');
		expect(decodeMoondropFirmware([0x80, 0x0c, 0, 0x76, 0x31])).toBeNull();
		expect(decodeMoondropFirmware([0x80, 0x0c, 0, 0, 0])).toBeNull();
		expect(decodeMoondropFirmware([0x80, 0x0c, 0, 0x31, 0x2e])).toBeNull();
	});

	test('the global gain is read in dB and written with the offset save', async () => {
		const { t, sent } = headset();
		const gain = moondropUsbHid.controls!.globalGain!;
		expect(await gain.read(hidContext(t, {}))).toBe(-9.5);
		expect(sent).toEqual([[0x80, 3, 0]]);
		sent.length = 0;
		const sleeps: number[] = [];
		await gain.write(hidContext(t, {}, sleeps), -6);
		expect(sent.map((d) => d.length)).toEqual([63, 63]);
		expect(sent[0]!.slice(0, 5)).toEqual([1, 3, 2, ...s16(-6)]);
		expect(sent[1]!.slice(0, 3)).toEqual([1, 4, 0]);
		expect(sleeps).toEqual([50, 200]);
		await expect(gain.write(hidContext(t, {}), -200)).rejects.toMatchObject({
			code: 'unrepresentable'
		});
	});

	test('it has no EQ switch, and a push always goes to the custom slot', () => {
		const caps = moondropUsbHid.capabilities(scriptedHid().t, {});
		expect(caps).toMatchObject({ canEnable: false, writesSlot: false, readsPreamp: true });
		expect(() => moondropUsbHidCodec.encode({ ...two, slot: 2 }, {})).toThrow(
			expect.objectContaining({ code: 'invalid-request' })
		);
	});
});

describe("Moondrop Old Fashioned as Moondrop's web app drives it", () => {
	/** Answers a read of an even register with 2 dB at 1000 Hz and of an odd one with Q 0.3. */
	const device = (answerLength = 10) =>
		scriptedHid((d) => {
			if (d[4] !== 0x52) return [];
			const a =
				d[0]! % 2 === 0
					? [d[0]!, 0, 0, 0, 0x52, 0, 20, 0, 0xe8, 0x03]
					: [d[0]!, 0, 0, 0, 0x52, 0, 0x2c, 0x01, 0, 0];
			return [a.slice(0, answerLength)];
		});

	test('waits 200 ms after each write, each read and the save', async () => {
		const { t, sent } = device();
		const sleeps: number[] = [];
		await moondropOldFashionedHid.push(hidContext(t, {}, sleeps), { filters: [pk(1000, 2, 1)] });
		expect(sent).toHaveLength(3);
		expect(sleeps).toEqual([200, 200, 200]);
		sleeps.length = 0;
		const { filters } = await moondropOldFashionedHid.pull(hidContext(t, {}, sleeps), { bands: 1 });
		expect(sleeps).toEqual([200, 200]);
		expect(filters).toEqual([pk(1000, 2, 0.3)]);
	});

	test('refuses an answer under 10 bytes', async () => {
		const { t } = device(9);
		await expect(
			moondropOldFashionedHid.pull(hidContext(t, {}), { bands: 1 })
		).rejects.toMatchObject({ code: 'bad-response' });
	});

	test('waits 2 s for an answer', async () => {
		vi.useFakeTimers();
		try {
			const { t } = scriptedHid();
			let outcome: unknown;
			void moondropOldFashionedHid
				.pull(hidContext(t, {}), { bands: 1 })
				.catch((e: unknown) => void (outcome = e));
			await vi.advanceTimersByTimeAsync(1999);
			expect(outcome).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1);
			expect(outcome).toMatchObject({ code: 'timeout' });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('Moondrop USB HID features', () => {
	const answer = (cmd: number, value: number[]) => {
		const d = new Array<number>(63).fill(0);
		[0x80, cmd, value.length, ...value].forEach((b, i) => (d[i] = b));
		return d;
	};
	/** A headset that holds each feature's bytes, answers reads with them and takes writes. */
	const headset = (held: Record<number, number[]> = {}, linked = 1) => {
		const features = new Map(Object.entries(held).map(([c, v]) => [Number(c), v]));
		return {
			features,
			...scriptedHid((d) => {
				if (d[0] === 0x01) features.set(d[1]!, d.slice(3, 3 + d[2]!));
				if (d[0] !== 0x80) return [];
				if (d[1] === 0x31) return [answer(0x31, [linked])];
				return [answer(d[1]!, features.get(d[1]!) ?? [0, 0, 0])];
			})
		};
	};
	const controls = moondropUsbHid.controls!;
	const cases: [id: string, cmd: number, value: number][] = [
		['dacFilter', 0x11, 3],
		['dacMode', 0x1d, 1],
		['led', 0x28, 1],
		['gainLevel', 0x26, 2],
		['ancMode', 0x25, 5],
		['dualMicEnc', 0x34, 1]
	];

	test.each(cases)('%s is read from and written to 0x%s', async (id, cmd, value) => {
		const { t, sent } = headset({ [cmd]: [value] });
		expect(await controls[id]!.read(hidContext(t, {}))).toBe(value);
		expect(sent).toEqual([[0x80, cmd, 0]]);
		sent.length = 0;
		const sleeps: number[] = [];
		await controls[id]!.write(hidContext(t, {}, sleeps), 0);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toHaveLength(63);
		expect(sent[0]!.slice(0, 4)).toEqual([1, cmd, 1, 0]);
		expect(sleeps).toEqual([50]);
	});

	test('the LED command can be another, as on the BLUE ROSE', async () => {
		const { t, sent } = headset({ 0x18: [1] });
		const ctx = hidContext(t, { ledCommand: 0x18 });
		expect(await controls.led!.read(ctx)).toBe(1);
		await controls.led!.write(ctx, 0);
		expect(sent.map((d) => d.slice(0, 4))).toEqual([
			[0x80, 0x18, 0],
			[1, 0x18, 1, 0]
		]);
	});

	test('the prompt tone is read and written byte by byte, and the tone is kept', async () => {
		const { t, sent, features } = headset({ 0x2b: [1, 40, 7] });
		const ctx = hidContext(t, {});
		expect(await controls.promptTone!.read(ctx)).toBe(1);
		expect(await controls.promptToneVolume!.read(ctx)).toBe(40);
		sent.length = 0;
		await controls.promptToneVolume!.write(ctx, 65);
		expect(sent.map((d) => d.slice(0, 6))).toEqual([
			[0x80, 0x2b, 0],
			[1, 0x2b, 3, 1, 65, 7]
		]);
		await controls.promptTone!.write(ctx, 0);
		expect(features.get(0x2b)).toEqual([0, 65, 7]);
	});

	test('a value the wire cannot carry is refused, not rounded or clamped', async () => {
		const { t, sent } = headset();
		const ctx = hidContext(t, {});
		for (const [id, value] of [
			['dacFilter', 1.5],
			['dacFilter', 256],
			['dacFilter', -1],
			['led', 2],
			['dualMicEnc', 0.5],
			['promptTone', 2],
			['promptToneVolume', 300],
			['ancMode', NaN]
		] as const) {
			await expect(controls[id]!.write(ctx, value), `${id} ${value}`).rejects.toMatchObject({
				code: 'unrepresentable'
			});
		}
		expect(sent).toEqual([]);
	});

	test('with linkCheck the link is asked about before each read and write', async () => {
		const options = { linkCheck: true };
		const linked = headset({ 0x11: [2], 0x2b: [1, 40, 7] });
		await controls.dacFilter!.read(hidContext(linked.t, options));
		await controls.dacFilter!.write(hidContext(linked.t, options), 4);
		await controls.promptToneVolume!.write(hidContext(linked.t, options), 10);
		expect(linked.sent.map((d) => d[1])).toEqual([0x31, 0x11, 0x31, 0x11, 0x31, 0x2b, 0x2b]);
		const unlinked = headset({}, 0);
		await expect(controls.ancMode!.read(hidContext(unlinked.t, options))).rejects.toMatchObject({
			code: 'rejected'
		});
		await expect(controls.led!.write(hidContext(unlinked.t, options), 1)).rejects.toMatchObject({
			code: 'rejected'
		});
		expect(unlinked.sent.every((d) => d[1] === 0x31)).toBe(true);
	});
});
