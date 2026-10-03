// Handlers without recorded captures, the device session, and the shared codec rules.

import type { Filter } from '@potatosalad775/eqcaps-core';
import { describe, expect, test } from 'vitest';
import { wireInt } from '../src/bytes.ts';
import { airohaCodec, decodeAirohaRecords } from '../src/handlers/airoha.ts';
import { edifierCodec } from '../src/handlers/edifier-serial.ts';
import { fosiAudioCodec } from '../src/handlers/fosi-audio-usb-hid.ts';
import { decodeF110Bands, f110Frame } from '../src/handlers/fiio-f110.ts';
import { fiioSerialFrame } from '../src/handlers/fiio-usb-serial.ts';
import { encodeFiioBand } from '../src/handlers/fiio-usb-hid.ts';
import { JDS_BANDS } from '../src/handlers/jds-labs-usb-serial.ts';
import { edgeCodec } from '../src/handlers/moondrop-edge-serial.ts';
import {
	crc16Modbus,
	decodeNothingBands,
	nothingFrame
} from '../src/handlers/nothing-usb-serial.ts';
import { ritaCodec } from '../src/handlers/tanchjim-rita-serial.ts';
import { typeCodes } from '../src/io.ts';
import { utf8Decode, utf8Encode } from '../src/platform.ts';
import {
	BridgeError,
	guessProtocol,
	isBridgeError,
	openDevice,
	type HidTransport,
	type SerialPortIdentity,
	type StreamTransport
} from '../src/index.ts';
import { protocolFor } from './data.ts';
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
		// Count, band, save: no preamp write when none was given.
		expect(sent.map((d) => d[4])).toEqual([0x18, 0x15, 0x19]);
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
			device.push({ filters: [{ type: 'LPQ', freq: 100, q: 0.7, gain: 0 }] })
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
				if (d[4] === 0x18 && log.length === 1) await gate;
			}
		};
		const device = open(t, 'fiio-ka17');
		const first = device.push({ filters: [pk(100, 1)] });
		const second = device.push({ filters: [pk(200, 2)] });
		await Promise.resolve();
		release();
		await Promise.all([first, second]);
		expect(log).toEqual(['send 24', 'send 21', 'send 24', 'send 21']);
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
