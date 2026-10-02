// Browser transports for @potatosalad775/eqcaps-device-bridge: WebHID, Web Serial and Web
// Bluetooth. Device APIs need Chromium over HTTPS; check `deviceApis()` before offering them.

export { hidCollections, hidTransport, requestHidDevice } from './webhid.ts';
export type { RequestHidOptions } from './webhid.ts';
export { baudRateFor, requestSerialPort, serialTransport } from './webserial.ts';
export type { RequestSerialOptions, SerialPortChoice } from './webserial.ts';
export { bleTransport, requestBleDevice } from './webbluetooth.ts';
export type { BleChoice, RequestBleOptions } from './webbluetooth.ts';
export type {
	BluetoothDeviceLike,
	BluetoothLike,
	HidDeviceLike,
	HidLike,
	SerialLike,
	SerialPortLike
} from './web-apis.ts';

import { browserApis } from './web-apis.ts';

/** Which device APIs this browser offers. */
export function deviceApis(): { hid: boolean; serial: boolean; bluetooth: boolean } {
	const apis = browserApis();
	return { hid: !!apis.hid, serial: !!apis.serial, bluetooth: !!apis.bluetooth };
}
