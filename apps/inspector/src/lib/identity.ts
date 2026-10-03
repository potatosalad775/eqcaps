// How a profile's match entries read in the views (SPEC §3). A field may list several values.

import {
	matchValues,
	type BluetoothMatch,
	type Match,
	type UsbMatch
} from '@potatosalad775/eqcaps-core';

/**
 * One field's values: the value itself, a few joined by " | ", or a count when there are more
 * than `max` (`Infinity` lists them all).
 */
function listed(values: readonly string[], noun: string, max: number, quote = false): string {
	const shown = quote ? values.map((v) => `"${v}"`) : values;
	if (shown.length <= max) return shown.join(' | ');
	return `${values.length} ${noun}`;
}

/** `0x2972:0x0047 "FIIO KA17"`, `0x0a12 | 0x2972 "FIIO BTR17" | "BTR17"`, `19 vendor ids:80 product ids`. */
export function usbEntryText(u: UsbMatch, max = 3): string {
	const vendors = listed(matchValues(u.vendorId), 'vendor ids', max);
	const products =
		u.productId === undefined ? '' : `:${listed(matchValues(u.productId), 'product ids', max)}`;
	const names =
		u.productName === undefined ? '' : ` ${listed(matchValues(u.productName), 'names', max, true)}`;
	return `${vendors}${products}${names}`;
}

/** `"FIIO EH13"` or `"EDIFIER W830NB…"`, with the service when the entry names one. */
export function bluetoothEntryText(b: BluetoothMatch, max = 3, service = true): string {
	const names =
		b.name !== undefined
			? listed(matchValues(b.name), 'names', max, true)
			: listed(
					matchValues(b.namePrefix).map((p) => `${p}…`),
					'name prefixes',
					max,
					true
				);
	return service && b.serviceUuid ? `${names} service ${b.serviceUuid}` : names;
}

/** A short line for a list of profiles: the first entries, then how many more. */
export function identitySummary(match: Match | undefined): string {
	const all = [
		...(match?.usb ?? []).map((u) => usbEntryText(u, 2)),
		...(match?.bluetooth ?? []).map((b) => `BT ${bluetoothEntryText(b, 2, false)}`)
	];
	return all.length > 3 ? `${all.slice(0, 2).join(', ')} +${all.length - 2} more` : all.join(', ');
}
