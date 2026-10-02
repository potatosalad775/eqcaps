// Browser transports, driven by fake WebHID / Web Serial / Web Bluetooth objects.

import { describe, expect, test } from 'vitest';
import { matchDevice } from '@potatosalad775/eqcaps-client';
import {
	requestBleDevice,
	requestHidDevice,
	requestSerialPort,
	type BluetoothLike,
	type HidDeviceLike,
	type SerialPortLike
} from '../src/browser/index.ts';
import { ChunkQueue } from '../src/browser/stream.ts';
import { identityOf, protocolFor } from '../src/index.ts';
import { validateRepository } from '../../build/src/node.ts';

const profiles = [...validateRepository().profiles.values()];

type InputListener = (e: { reportId: number; data: DataView }) => void;

function fakeHid(
	name: string,
	vendorId: number,
	productId: number,
	collections: HidDeviceLike['collections'] = []
) {
	const listeners = new Set<InputListener>();
	const sent: [number, number[]][] = [];
	const device: HidDeviceLike & { fire(id: number, bytes: number[]): void; sent: typeof sent } = {
		opened: false,
		vendorId,
		productId,
		productName: name,
		collections,
		sent,
		async open() {
			(this as { opened: boolean }).opened = true;
		},
		async close() {},
		async sendReport(id, data) {
			sent.push([id, [...data]]);
		},
		async sendFeatureReport() {},
		async receiveFeatureReport() {
			return new DataView(Uint8Array.from([1, 0x77, 0x9d]).buffer);
		},
		addEventListener: (_t, l) => void listeners.add(l as InputListener),
		removeEventListener: (_t, l) => void listeners.delete(l as InputListener),
		fire(id, bytes) {
			const buffer = Uint8Array.from([0xff, ...bytes, 0xff]).buffer;
			for (const l of listeners) l({ reportId: id, data: new DataView(buffer, 1, bytes.length) });
		}
	};
	return device;
}

describe('WebHID', () => {
	test('asks for known vendors, opens the device and maps the descriptor', async () => {
		const device = fakeHid('FIIO KA17', 0x2972, 0x0093, [
			{
				usagePage: 0xff00,
				usage: 1,
				outputReports: [{ reportId: 7, items: [{ reportSize: 8, reportCount: 63 }] }],
				children: [
					{
						usagePage: 0x0c,
						inputReports: [{ reportId: 1, items: [{ reportSize: 1, reportCount: 3 }] }]
					}
				]
			}
		]);
		let filters: unknown;
		const transport = await requestHidDevice({
			hid: {
				requestDevice: async (o) => ((filters = o.filters), [device]),
				getDevices: async () => []
			}
		});
		expect(filters).toContainEqual({ vendorId: 0x2972 });
		expect(device.opened).toBe(true);
		expect(transport!.collections[0]!.outputReports).toEqual([{ reportId: 7, size: 63 }]);
		expect(transport!.collections[0]!.children[0]!.inputReports).toEqual([
			{ reportId: 1, size: 1 }
		]);
		expect(matchDevice(profiles, identityOf(transport!)).best?.id).toBe('fiio-ka17');
	});

	test('input reports arrive as the bytes of their view, and unsubscribe works', async () => {
		const device = fakeHid('X', 1, 2);
		const transport = (await requestHidDevice({
			anyDevice: true,
			hid: {
				requestDevice: async (o) => (expect(o.filters).toEqual([]), [device]),
				getDevices: async () => []
			}
		}))!;
		const got: number[][] = [];
		const off = transport.onInputReport((_id, d) => got.push([...d]));
		device.fire(3, [1, 2, 3]);
		off();
		device.fire(3, [4]);
		expect(got).toEqual([[1, 2, 3]]);
		expect([...(await transport.receiveFeatureReport(1))]).toEqual([1, 0x77, 0x9d]);
	});

	test('prefers the vendor-defined interface of a multi-interface device', async () => {
		const audio = fakeHid('Qudelix-5K USB DAC 48KHz', 0x0a12, 0x4005, [{ usagePage: 0x0c }]);
		const peq = fakeHid('Qudelix-5K USB DAC 48KHz', 0x0a12, 0x4005, [{ usagePage: 0xff00 }]);
		const transport = await requestHidDevice({
			hid: { requestDevice: async () => [audio], getDevices: async () => [audio, peq] }
		});
		expect(transport!.collections[0]!.usagePage).toBe(0xff00);
	});

	test('a cancelled chooser gives null', async () => {
		const t = await requestHidDevice({
			hid: { requestDevice: async () => [], getDevices: async () => [] }
		});
		expect(t).toBeNull();
	});
});

describe('Web Serial', () => {
	function fakePort(info: ReturnType<SerialPortLike['getInfo']>) {
		const incoming: Uint8Array[] = [];
		let wake: (() => void) | undefined;
		const written: number[][] = [];
		let baud: number | undefined;
		const port: SerialPortLike & {
			feed(b: number[]): void;
			written: number[][];
			baud(): number | undefined;
		} = {
			getInfo: () => info,
			async open(o) {
				baud = o.baudRate;
			},
			async close() {},
			readable: {
				getReader: () => ({
					async read() {
						while (!incoming.length) await new Promise<void>((r) => (wake = r));
						return { value: incoming.shift()!, done: false };
					},
					async cancel() {},
					releaseLock() {}
				})
			},
			writable: {
				getWriter: () => ({ write: async (d) => void written.push([...d]), releaseLock() {} })
			},
			feed(b) {
				incoming.push(Uint8Array.from(b));
				wake?.();
			},
			written,
			baud: () => baud
		};
		return port;
	}

	test("opens at the protocol's baud rate", async () => {
		const port = fakePort({ usbVendorId: 6790, usbProductId: 21971 });
		let filters: unknown;
		const choice = await requestSerialPort({
			entries: profiles,
			serial: { requestPort: async (o) => ((filters = o?.filters), port) }
		});
		expect(filters).toContainEqual({ usbVendorId: 6790 });
		expect(choice!.identity).toEqual({ usb: { vendorId: '0x1a86', productId: '0x55d3' } });
		const transport = await choice!.open(protocolFor('fiio-audio-dsp'));
		expect(port.baud()).toBe(57600);
		port.feed([1, 2]);
		port.feed([3]);
		await transport.write(Uint8Array.from([9]));
		expect(port.written).toEqual([[9]]);
		expect([...(await transport.read(100))!]).toEqual([1, 2]);
		expect([...(await transport.read(100))!]).toEqual([3]);
		expect(await transport.read(10)).toBeNull();
	});

	test('Bluetooth SPP ports show only their service class and default to 9600 baud', async () => {
		const port = fakePort({ bluetoothServiceClassId: '00001101-0000-1000-8000-00805F9B34FB' });
		const choice = await requestSerialPort({ serial: { requestPort: async () => port } });
		expect(choice!.identity).toEqual({
			bluetooth: { serviceUuids: ['00001101-0000-1000-8000-00805f9b34fb'] }
		});
		// No name to match by: the user says which device it is.
		await choice!.open(protocolFor('tanchjim-rita'));
		expect(port.baud()).toBe(9600);
	});

	test('a cancelled chooser gives null', async () => {
		const cancel = Object.assign(new Error('cancelled'), { name: 'NotFoundError' });
		expect(
			await requestSerialPort({ serial: { requestPort: async () => Promise.reject(cancel) } })
		).toBeNull();
	});
});

describe('Web Bluetooth', () => {
	test("connects with the GATT layout of the device's protocol and buffers notifications", async () => {
		let notify: ((e: { target: unknown }) => void) | undefined;
		const writes: [string, number[]][] = [];
		const characteristic = (uuid: string) => ({
			properties: { write: true, writeWithoutResponse: false },
			value: null,
			writeValueWithResponse: async (d: Uint8Array) => void writes.push(['with', [...d]]),
			writeValueWithoutResponse: async (d: Uint8Array) => void writes.push(['without', [...d]]),
			startNotifications: async () => undefined,
			addEventListener: (_t: string, l: (e: { target: unknown }) => void) => {
				if (uuid.startsWith('00001102')) notify = l;
			}
		});
		let request: unknown;
		const bluetooth: BluetoothLike = {
			requestDevice: async (o) => {
				request = o;
				return {
					name: 'FIIO EH13',
					gatt: {
						connected: true,
						connect: async () => ({
							getPrimaryService: async () => ({
								getCharacteristic: async (u: string) => characteristic(u)
							})
						}),
						disconnect() {}
					}
				};
			}
		};
		const choice = await requestBleDevice({ entries: profiles, bluetooth });
		expect(request).toMatchObject({ filters: expect.arrayContaining([{ name: 'FIIO EH13' }]) });
		const best = matchDevice(profiles, choice!.identity).best!;
		expect(best.id).toBe('fiio-eh13');
		await expect(choice!.open(protocolFor('fiio-ka17')!)).rejects.toMatchObject({
			code: 'invalid-request'
		});
		const transport = await choice!.open(protocolFor(best.id)!);
		await transport.write(Uint8Array.from([1]));
		expect(writes).toEqual([['with', [1]]]);
		notify!({ target: { value: new DataView(Uint8Array.from([5, 6]).buffer) } });
		expect([...(await transport.read(100))!]).toEqual([5, 6]);
		expect(transport.bleName).toBe('FIIO EH13');
	});
});

test('a closed stream rejects pending and later reads', async () => {
	const q = new ChunkQueue();
	const pending = q.read(1000);
	q.fail(new Error('gone'));
	await expect(pending).rejects.toMatchObject({ code: 'transport' });
	await expect(q.read(10)).rejects.toMatchObject({ code: 'transport' });
});
