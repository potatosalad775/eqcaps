import { BridgeError } from '../errors.ts';
import { chooserFilters, type ChooserEntry } from '../chooser.ts';
import type { AnyHandler } from '../handler.ts';
import { HANDLERS } from '../handlers/index.ts';
import type { DeviceIdentity } from '../identity.ts';
import type { Protocol } from '../protocols.ts';
import type { StreamTransport } from '../transport.ts';
import { ChunkQueue } from './stream.ts';
import {
	browserApis,
	bytesOf,
	isCancel,
	type BluetoothDeviceLike,
	type BluetoothLike,
	type DataViewLike,
	type GattCharacteristicLike
} from './web-apis.ts';

/**
 * Connects to a BLE device's GATT service and wraps its TX/RX characteristics as a stream: writes
 * go to TX (with response only when that's all TX supports), notifications from RX are buffered.
 */
export async function bleTransport(
	device: BluetoothDeviceLike,
	gatt: { service: string; tx: string; rx: string }
): Promise<StreamTransport> {
	if (!device.gatt)
		throw new BridgeError('transport', 'Web Bluetooth: the device has no GATT server');
	let tx: GattCharacteristicLike;
	let rx: GattCharacteristicLike;
	try {
		const server = await device.gatt.connect();
		const service = await server.getPrimaryService(gatt.service);
		tx = await service.getCharacteristic(gatt.tx);
		rx = await service.getCharacteristic(gatt.rx);
		await rx.startNotifications();
	} catch (cause) {
		throw new BridgeError('transport', 'Web Bluetooth: GATT connection failed', { cause });
	}
	const queue = new ChunkQueue();
	rx.addEventListener('characteristicvaluechanged', (event) => {
		const value = (event.target as { value?: DataViewLike | null }).value;
		if (value) queue.push(bytesOf(value));
	});
	const withResponse = !!tx.properties.write && !tx.properties.writeWithoutResponse;
	const transport: StreamTransport = {
		kind: 'ble',
		async write(data) {
			try {
				await (withResponse ? tx.writeValueWithResponse(data) : tx.writeValueWithoutResponse(data));
			} catch (cause) {
				throw new BridgeError('transport', 'Web Bluetooth: write failed', { cause });
			}
		},
		read: (timeoutMs) => queue.read(timeoutMs),
		async close() {
			queue.fail(new Error('closed'));
			device.gatt?.disconnect();
		}
	};
	if (device.name !== undefined) (transport as { bleName?: string }).bleName = device.name;
	return transport;
}

export interface RequestBleOptions {
	/** Database entries whose BLE devices to offer by name. Without any, every device is offered. */
	entries?: Iterable<ChooserEntry>;
	/** Default: `navigator.bluetooth`. */
	bluetooth?: BluetoothLike;
}

/** A chosen BLE device, not yet connected: the GATT layout depends on the protocol. */
export interface BleChoice {
	/** For the client's `matchDevice`: the advertised name. */
	identity: DeviceIdentity;
	/** Connects with the GATT layout of `protocol`'s handler. */
	open(protocol: Protocol): Promise<StreamTransport>;
}

/** Shows the browser's Bluetooth chooser; null if the user cancelled. */
export async function requestBleDevice(options: RequestBleOptions = {}): Promise<BleChoice | null> {
	const api = options.bluetooth ?? browserApis().bluetooth;
	if (!api) throw new BridgeError('unsupported', 'Web Bluetooth is not available in this browser');
	const f = chooserFilters(options.entries);
	let device: BluetoothDeviceLike;
	try {
		device = await api.requestDevice(
			f.bleNames.length > 0
				? { filters: f.bleNames, optionalServices: f.gattServices }
				: { acceptAllDevices: true, optionalServices: f.gattServices }
		);
	} catch (error) {
		if (isCancel(error)) return null;
		throw new BridgeError('transport', 'Web Bluetooth: requestDevice failed', { cause: error });
	}
	return {
		identity: device.name === undefined ? {} : { bluetooth: { name: device.name } },
		open(protocol) {
			const gatt = (HANDLERS[protocol.handler] as AnyHandler).gatt;
			if (!gatt) {
				return Promise.reject(
					new BridgeError('invalid-request', `${protocol.handler} doesn't run over BLE`)
				);
			}
			return bleTransport(device, gatt);
		}
	};
}
