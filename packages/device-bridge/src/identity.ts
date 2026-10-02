import type { Transport } from './transport.ts';

/**
 * What the transport tells about the device, in the shape the eqcaps client's `matchDevice` takes
 * (USB ids as lower-case 4-digit hex strings). Serial numbers and Bluetooth addresses are never
 * read (INSPECTOR §6).
 */
export interface DeviceIdentity {
	usb?: { vendorId: string; productId?: string; productName?: string };
	bluetooth?: { name?: string; serviceUuids?: string[] };
}

export const usbHex = (id: number) => `0x${id.toString(16).padStart(4, '0')}`;

export function identityOf(transport: Transport): DeviceIdentity {
	switch (transport.kind) {
		case 'hid':
			return {
				usb: {
					vendorId: usbHex(transport.vendorId),
					productId: usbHex(transport.productId),
					productName: transport.productName
				}
			};
		case 'serial': {
			const s = transport.serial ?? {};
			if (s.usbVendorId !== undefined) {
				return {
					usb: {
						vendorId: usbHex(s.usbVendorId),
						...(s.usbProductId !== undefined ? { productId: usbHex(s.usbProductId) } : {})
					}
				};
			}
			return s.bluetoothServiceClassId
				? { bluetooth: { serviceUuids: [s.bluetoothServiceClassId.toLowerCase()] } }
				: {};
		}
		case 'ble':
			return transport.bleName === undefined ? {} : { bluetooth: { name: transport.bleName } };
	}
}
