import { transportsOf } from './device.ts';
import type { AnyHandler } from './handler.ts';
import { HANDLERS } from './handlers/index.ts';
import { KNOWN_HID_VENDORS, protocolOf } from './protocols.ts';

/**
 * A database entry, as the client's index lists it: a profile id, how to recognize the device and
 * how to drive it.
 */
export interface ChooserEntry {
	id: string;
	protocol?: unknown;
	match?: {
		usb?: readonly { vendorId: string | readonly string[] }[];
		bluetooth?: readonly {
			name?: string | readonly string[];
			namePrefix?: string | readonly string[];
		}[];
	};
}

/** What to offer in a browser's device chooser. */
export interface ChooserFilters {
	hidVendorIds: number[];
	/** USB serial ports. */
	serialVendorIds: number[];
	/** Bluetooth serial (RFCOMM) service classes. */
	sppServiceClasses: string[];
	/** BLE advertised names. Empty: offer every device. */
	bleNames: ({ name: string } | { namePrefix: string })[];
	/** Every GATT service a handler uses (Web Bluetooth's `optionalServices`). */
	gattServices: string[];
}

const handlers = Object.values(HANDLERS) as AnyHandler[];
const unique = <T>(list: T[]) => [...new Set(list)];
/** A match field's values: one, or a list of which any matches (SPEC §3). */
const values = <T>(v: T | readonly T[] | undefined): readonly T[] =>
	v === undefined ? [] : Array.isArray(v) ? (v as readonly T[]) : [v as T];

/**
 * Chooser filters for the devices in `entries` that have a protocol, plus the HID vendors
 * `guessProtocol` knows. The bridge holds no device identities (D33): pass the database's
 * entries (`(await client.loadIndex())?.profiles`) to offer the devices it knows.
 */
export function chooserFilters(entries: Iterable<ChooserEntry> = []): ChooserFilters {
	const hid: number[] = [...KNOWN_HID_VENDORS];
	const serial: number[] = [];
	const ble = new Map<string, { name: string } | { namePrefix: string }>();
	for (const entry of entries) {
		const protocol = protocolOf(entry);
		if (!protocol) continue;
		const kinds = transportsOf(HANDLERS[protocol.handler]);
		for (const { vendorId } of entry.match?.usb ?? []) {
			for (const v of values(vendorId)) {
				const id = parseInt(v, 16);
				if (kinds.includes('hid')) hid.push(id);
				if (kinds.includes('serial')) serial.push(id);
			}
		}
		if (!kinds.includes('ble')) continue;
		for (const b of entry.match?.bluetooth ?? []) {
			const filters =
				b.name !== undefined
					? values(b.name).map((name) => ({ name }))
					: values(b.namePrefix).map((namePrefix) => ({ namePrefix }));
			for (const f of filters) ble.set(JSON.stringify(f), f);
		}
	}
	return {
		hidVendorIds: unique(hid),
		serialVendorIds: unique(serial),
		sppServiceClasses: unique(
			handlers.flatMap((h) => (h.sppServiceClass ? [h.sppServiceClass] : []))
		),
		bleNames: [...ble.values()],
		gattServices: unique(handlers.flatMap((h) => (h.gatt ? [h.gatt.service] : [])))
	};
}
