import type { BluetoothMatch, UsbMatch } from './types/schema.generated.ts';

/** The values a match field lists: one, or several of which any matches (SPEC §3). */
export function matchValues<T>(field: T | readonly T[] | undefined): readonly T[] {
	if (field === undefined) return [];
	return Array.isArray(field) ? (field as readonly T[]) : [field as T];
}

/** A USB match entry with one value per field. */
export interface ScalarUsbMatch {
	vendorId: string;
	productId?: string;
	productName?: string;
}

/** A Bluetooth match entry with one value per field. */
export interface ScalarBluetoothMatch {
	name?: string;
	namePrefix?: string;
	serviceUuid?: string;
}

/**
 * The single-valued entries a USB entry stands for: every combination of its fields' values, in
 * field order. An entry that lists 19 vendor ids and 80 product ids stands for 1520.
 */
export function expandUsbMatch(e: UsbMatch): ScalarUsbMatch[] {
	const out: ScalarUsbMatch[] = [];
	const pids = e.productId === undefined ? [undefined] : matchValues(e.productId);
	const names = e.productName === undefined ? [undefined] : matchValues(e.productName);
	for (const vendorId of matchValues(e.vendorId)) {
		for (const productId of pids) {
			for (const productName of names) {
				out.push({
					vendorId,
					...(productId !== undefined ? { productId } : {}),
					...(productName !== undefined ? { productName } : {})
				});
			}
		}
	}
	return out;
}

/** The single-valued entries a Bluetooth entry stands for. */
export function expandBluetoothMatch(e: BluetoothMatch): ScalarBluetoothMatch[] {
	const out: ScalarBluetoothMatch[] = [];
	const names = e.name === undefined ? [undefined] : matchValues(e.name);
	const prefixes = e.namePrefix === undefined ? [undefined] : matchValues(e.namePrefix);
	for (const name of names) {
		for (const namePrefix of prefixes) {
			out.push({
				...(name !== undefined ? { name } : {}),
				...(namePrefix !== undefined ? { namePrefix } : {}),
				...(e.serviceUuid !== undefined ? { serviceUuid: e.serviceUuid } : {})
			});
		}
	}
	return out;
}
