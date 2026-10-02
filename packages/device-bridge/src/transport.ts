// Transports carry bytes between a handler and a device. Handlers only ever
// see these interfaces, never a browser or platform API (DECISIONS D20, D27, D33), so the same
// handler runs over WebHID in a browser and over a native USB plugin in an Android app.
//
// The browser implementations are in `./browser`. Anyone else (a Capacitor plugin, a Node test
// rig) implements the interface for their platform. Implementations should keep these rules:
// - an input listener sees every report that arrives after it subscribes, in order;
// - `read()` returns the bytes that arrived since the last read, buffered, so nothing is lost
//   between two reads;
// - methods reject with a `BridgeError` of code `transport` when the device is gone.

/** One report a HID collection declares, as the descriptor states it. */
export interface HidReportInfo {
	reportId: number;
	/** Payload size in bytes, report id excluded. Undefined when the descriptor doesn't say. */
	size?: number;
}

/** A HID collection, as far as a bridge or a descriptor dump needs it (INSPECTOR §2 T1). */
export interface HidCollectionInfo {
	usagePage: number;
	usage: number;
	inputReports: HidReportInfo[];
	outputReports: HidReportInfo[];
	featureReports: HidReportInfo[];
	children: HidCollectionInfo[];
}

export interface HidTransport {
	readonly kind: 'hid';
	readonly vendorId: number;
	readonly productId: number;
	/** Exactly as the device reports it, trailing spaces included. */
	readonly productName: string;
	readonly collections: readonly HidCollectionInfo[];
	/** Output report. `data` excludes the report id. */
	sendReport(reportId: number, data: Uint8Array): Promise<void>;
	sendFeatureReport(reportId: number, data: Uint8Array): Promise<void>;
	/**
	 * Feature report as the platform returns it. WebHID prepends the report id on numbered
	 * reports; handlers that read feature reports cope with both shapes.
	 */
	receiveFeatureReport(reportId: number): Promise<Uint8Array>;
	/** Subscribes to input reports (`data` excludes the report id). Returns the unsubscribe. */
	onInputReport(listener: (reportId: number, data: Uint8Array) => void): () => void;
	close(): Promise<void>;
}

/** Identity of a serial port, as Web Serial's `getInfo()` exposes it. */
export interface SerialPortIdentity {
	usbVendorId?: number;
	usbProductId?: number;
	/** Bluetooth RFCOMM (SPP) ports: the service class UUID, lower case. */
	bluetoothServiceClassId?: string;
}

/**
 * A byte stream: a USB CDC or Bluetooth SPP serial port, or a BLE GATT pair (writes go to the TX
 * characteristic, notifications come back through `read`). Framing is the handler's job.
 */
export interface StreamTransport {
	readonly kind: 'serial' | 'ble';
	/** Serial ports only. */
	readonly serial?: SerialPortIdentity;
	/** BLE devices only: the advertised name, if any. */
	readonly bleName?: string;
	write(data: Uint8Array): Promise<void>;
	/** The next received bytes, or null if nothing arrives within `timeoutMs`. */
	read(timeoutMs: number): Promise<Uint8Array | null>;
	close(): Promise<void>;
}

export type Transport = HidTransport | StreamTransport;
export type TransportKind = Transport['kind'];
