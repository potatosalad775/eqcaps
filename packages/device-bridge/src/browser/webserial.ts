import { BridgeError } from '../errors.ts';
import { chooserFilters, type ChooserEntry } from '../chooser.ts';
import { identityOf, type DeviceIdentity } from '../identity.ts';
import type { Protocol } from '../protocols.ts';
import type { SerialPortIdentity, StreamTransport } from '../transport.ts';
import { ChunkQueue } from './stream.ts';
import { browserApis, isCancel, type SerialLike, type SerialPortLike } from './web-apis.ts';

/**
 * Wraps an open Web Serial port as a stream transport. One reader runs for the life of the
 * transport and buffers what arrives; writes take the writer only for their duration.
 */
export function serialTransport(port: SerialPortLike): StreamTransport {
	const info = port.getInfo();
	const serial: SerialPortIdentity = {};
	if (info.usbVendorId !== undefined) serial.usbVendorId = info.usbVendorId;
	if (info.usbProductId !== undefined) serial.usbProductId = info.usbProductId;
	if (info.bluetoothServiceClassId) {
		serial.bluetoothServiceClassId = info.bluetoothServiceClassId.toLowerCase();
	}
	const queue = new ChunkQueue();
	const reader = port.readable?.getReader();
	let closing = false;
	if (reader) {
		void (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					if (value?.length) queue.push(value);
				}
				queue.fail(new Error('the port stopped sending'));
			} catch (error) {
				queue.fail(error);
			} finally {
				if (!closing) {
					try {
						reader.releaseLock();
					} catch {
						// Already released.
					}
				}
			}
		})();
	} else {
		queue.fail(new Error('the port is not readable'));
	}

	return {
		kind: 'serial',
		serial,
		async write(data) {
			const writer = port.writable?.getWriter();
			if (!writer) throw new BridgeError('transport', 'Web Serial: the port is not writable');
			try {
				await writer.write(data);
			} catch (cause) {
				throw new BridgeError('transport', 'Web Serial: write failed', { cause });
			} finally {
				writer.releaseLock();
			}
		},
		read: (timeoutMs) => queue.read(timeoutMs),
		async close() {
			closing = true;
			await reader?.cancel().catch(() => {});
			try {
				reader?.releaseLock();
			} catch {
				// Already released.
			}
			await port.close().catch((cause: unknown) => {
				throw new BridgeError('transport', 'Web Serial: close failed', { cause });
			});
		}
	};
}

/** The protocol's baud rate, else 9600 over Bluetooth and 115200 over USB. */
export function baudRateFor(identity: SerialPortIdentity, protocol?: Protocol): number {
	return protocol?.baudRate ?? (identity.bluetoothServiceClassId ? 9600 : 115200);
}

/** A chosen serial port, not yet opened: its baud rate depends on which device it is. */
export interface SerialPortChoice {
	/**
	 * For the client's `matchDevice`. A Bluetooth port shows only its service class, which several
	 * devices share: ask the user which device it is.
	 */
	identity: DeviceIdentity;
	port: SerialPortIdentity;
	/** Opens the port at `baudRate`, default `baudRateFor(port, protocol)`. */
	open(protocol?: Protocol, baudRate?: number): Promise<StreamTransport>;
}

export interface RequestSerialOptions {
	/** Database entries whose USB serial devices to offer. Bluetooth ports are always offered. */
	entries?: Iterable<ChooserEntry>;
	/** Offer every serial port. */
	anyDevice?: boolean;
	/** Default: `navigator.serial`. */
	serial?: SerialLike;
}

/** Shows the browser's serial port chooser; null if the user cancelled. */
export async function requestSerialPort(
	options: RequestSerialOptions = {}
): Promise<SerialPortChoice | null> {
	const api = options.serial ?? browserApis().serial;
	if (!api) throw new BridgeError('unsupported', 'Web Serial is not available in this browser');
	const f = chooserFilters(options.entries);
	const filters = [
		...f.serialVendorIds.map((usbVendorId) => ({ usbVendorId })),
		...f.sppServiceClasses.map((bluetoothServiceClassId) => ({ bluetoothServiceClassId }))
	];
	const allowedBluetoothServiceClassIds = f.sppServiceClasses;

	let port: SerialPortLike;
	try {
		port = await api.requestPort(
			options.anyDevice
				? { allowedBluetoothServiceClassIds }
				: { filters, allowedBluetoothServiceClassIds }
		);
	} catch (error) {
		if (isCancel(error)) return null;
		throw new BridgeError('transport', 'Web Serial: requestPort failed', { cause: error });
	}
	const info = port.getInfo();
	const identity: SerialPortIdentity = {};
	if (info.usbVendorId !== undefined) identity.usbVendorId = info.usbVendorId;
	if (info.usbProductId !== undefined) identity.usbProductId = info.usbProductId;
	if (info.bluetoothServiceClassId)
		identity.bluetoothServiceClassId = info.bluetoothServiceClassId.toLowerCase();
	return {
		identity: identityOf({ kind: 'serial', serial: identity } as StreamTransport),
		port: identity,
		async open(protocol, baudRate) {
			await port
				.open({ baudRate: baudRate ?? baudRateFor(identity, protocol) })
				.catch((cause: unknown) => {
					throw new BridgeError('transport', 'Web Serial: open failed', { cause });
				});
			return serialTransport(port);
		}
	};
}
