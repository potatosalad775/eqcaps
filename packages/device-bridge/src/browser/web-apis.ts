// The parts of WebHID, Web Serial and Web Bluetooth the browser transports use, declared
// structurally so the package needs no DOM types (D33). Any object of this shape works, which is
// also how the tests drive the transports.

export interface HidReportItemLike {
	reportSize?: number;
	reportCount?: number;
}

export interface HidReportInfoLike {
	reportId?: number;
	items?: readonly HidReportItemLike[];
}

export interface HidCollectionInfoLike {
	usagePage?: number;
	usage?: number;
	inputReports?: readonly HidReportInfoLike[];
	outputReports?: readonly HidReportInfoLike[];
	featureReports?: readonly HidReportInfoLike[];
	children?: readonly HidCollectionInfoLike[];
}

export interface HidInputReportEventLike {
	reportId: number;
	data: DataViewLike;
}

export interface DataViewLike {
	readonly buffer: ArrayBufferLike;
	readonly byteOffset: number;
	readonly byteLength: number;
}

export interface HidDeviceLike {
	readonly opened: boolean;
	readonly vendorId: number;
	readonly productId: number;
	readonly productName: string;
	readonly collections: readonly HidCollectionInfoLike[];
	open(): Promise<void>;
	close(): Promise<void>;
	sendReport(reportId: number, data: Uint8Array): Promise<void>;
	sendFeatureReport(reportId: number, data: Uint8Array): Promise<void>;
	receiveFeatureReport(reportId: number): Promise<DataViewLike>;
	addEventListener(type: 'inputreport', listener: (event: HidInputReportEventLike) => void): void;
	removeEventListener(
		type: 'inputreport',
		listener: (event: HidInputReportEventLike) => void
	): void;
}

export interface HidLike {
	requestDevice(options: {
		filters: { vendorId?: number; productId?: number; usagePage?: number }[];
	}): Promise<HidDeviceLike[]>;
	getDevices(): Promise<HidDeviceLike[]>;
}

export interface ReadableStreamReaderLike {
	read(): Promise<{ value?: Uint8Array; done: boolean }>;
	cancel(): Promise<void>;
	releaseLock(): void;
}

export interface WritableStreamWriterLike {
	write(data: Uint8Array): Promise<void>;
	releaseLock(): void;
}

export interface SerialPortLike {
	getInfo(): { usbVendorId?: number; usbProductId?: number; bluetoothServiceClassId?: string };
	open(options: { baudRate: number }): Promise<void>;
	close(): Promise<void>;
	readonly readable: { getReader(): ReadableStreamReaderLike } | null;
	readonly writable: { getWriter(): WritableStreamWriterLike } | null;
}

export interface SerialLike {
	requestPort(options?: {
		filters?: { usbVendorId?: number; bluetoothServiceClassId?: string }[];
		allowedBluetoothServiceClassIds?: string[];
	}): Promise<SerialPortLike>;
}

export interface GattCharacteristicLike {
	readonly properties: { write?: boolean; writeWithoutResponse?: boolean };
	readonly value?: DataViewLike | null;
	writeValueWithResponse(data: Uint8Array): Promise<void>;
	writeValueWithoutResponse(data: Uint8Array): Promise<void>;
	startNotifications(): Promise<unknown>;
	stopNotifications?(): Promise<unknown>;
	addEventListener(
		type: 'characteristicvaluechanged',
		listener: (event: { target: unknown }) => void
	): void;
}

export interface BluetoothDeviceLike {
	readonly name?: string;
	readonly gatt?: {
		readonly connected: boolean;
		connect(): Promise<{
			getPrimaryService(uuid: string): Promise<{
				getCharacteristic(uuid: string): Promise<GattCharacteristicLike>;
			}>;
		}>;
		disconnect(): void;
	};
}

export interface BluetoothLike {
	requestDevice(options: {
		filters?: { name?: string; namePrefix?: string; services?: string[] }[];
		acceptAllDevices?: boolean;
		optionalServices?: string[];
	}): Promise<BluetoothDeviceLike>;
}

interface Navigator {
	hid?: HidLike;
	serial?: SerialLike;
	bluetooth?: BluetoothLike;
}

/** The browser's device APIs, where present. */
export function browserApis(): Navigator {
	return ((globalThis as { navigator?: Navigator }).navigator ?? {}) as Navigator;
}

export const bytesOf = (view: DataViewLike) =>
	new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();

/** A browser's chooser was dismissed: WebHID returns no device, the others throw NotFoundError. */
export const isCancel = (error: unknown) =>
	typeof error === 'object' &&
	error !== null &&
	(error as { name?: string }).name === 'NotFoundError';
