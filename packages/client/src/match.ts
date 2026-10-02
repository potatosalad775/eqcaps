import {
	compareFirmware,
	type BluetoothMatch,
	type IndexEntry,
	type Match,
	type UsbMatch
} from '@potatosalad775/eqcaps-core';

/**
 * What a consumer knows about a connected device. Give whatever the transport exposes
 * (WebHID: vendorId, productId, productName; Web Bluetooth: name, service UUIDs; …).
 */
export interface DeviceIdentity {
	usb?: {
		/** Number (0x2972) or hex string ("0x2972"). */
		vendorId: number | string;
		productId?: number | string;
		/** Exactly as the device reports it, trailing spaces included. */
		productName?: string;
	};
	bluetooth?: {
		name?: string;
		serviceUuids?: readonly string[];
	};
	/** Leave out when unknown: firmware ranges are then ignored (SPEC §3). */
	firmware?: string;
}

/** A profile that matches, with how strongly. */
export interface DeviceMatch<E extends Candidate = Candidate> {
	id: string;
	/** SPEC §3: vid+pid+name 4, vid+pid 3, vid+name 3, bt name 2, bt namePrefix 1. */
	specificity: number;
	entry: E;
}

export interface MatchResult<E extends Candidate = Candidate> {
	/** Every match, most specific first, then by id. */
	matches: DeviceMatch<E>[];
	/**
	 * The unique most specific match, or null. On a tie the consumer presents a choice and never
	 * picks silently (SPEC §3).
	 */
	best: DeviceMatch<E> | null;
	/** True when two or more profiles tie for the highest specificity. */
	ambiguous: boolean;
}

/** Anything with an id and a match: an index entry, or a profile (status read from meta). */
export type Candidate = Pick<IndexEntry, 'id'> & {
	match?: Match;
	status?: IndexEntry['status'];
	meta?: { status?: IndexEntry['status'] };
};

/** `0x2972` from 0x2972, "0x2972", "2972" or "0X2972". Null if it isn't a 16-bit id. */
export function usbId(id: number | string | undefined): string | null {
	if (id === undefined) return null;
	const n = typeof id === 'number' ? id : parseInt(id.replace(/^0x/i, ''), 16);
	if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
	return `0x${n.toString(16).padStart(4, '0')}`;
}

function usbSpecificity(e: UsbMatch, d: NonNullable<DeviceIdentity['usb']>): number {
	if (e.vendorId !== usbId(d.vendorId)) return 0;
	if (e.productId !== undefined && e.productId !== usbId(d.productId)) return 0;
	if (e.productName !== undefined && e.productName !== d.productName) return 0;
	if (e.productId !== undefined && e.productName !== undefined) return 4;
	return 3;
}

function bluetoothSpecificity(
	e: BluetoothMatch,
	d: NonNullable<DeviceIdentity['bluetooth']>
): number {
	const name = d.name;
	if (name === undefined) return 0;
	if (e.name !== undefined && e.name !== name) return 0;
	if (e.namePrefix !== undefined && !name.startsWith(e.namePrefix)) return 0;
	if (
		e.serviceUuid !== undefined &&
		!(d.serviceUuids ?? []).some((u) => u.toLowerCase() === e.serviceUuid)
	) {
		return 0;
	}
	return e.name !== undefined ? 2 : 1;
}

function inFirmwareRange(range: Match['firmware'], firmware: string | undefined): boolean {
	if (!range || firmware === undefined) return true;
	if (range.min !== undefined && compareFirmware(firmware, range.min) < 0) return false;
	if (range.max !== undefined && compareFirmware(firmware, range.max) >= 0) return false;
	return true;
}

/**
 * Finds the profiles whose `match` fits a device (SPEC §3). Deprecated profiles are skipped:
 * their `replacedBy` is what a device should get. Works on index entries or whole profiles.
 */
export function matchDevice<E extends Candidate>(
	candidates: Iterable<E>,
	identity: DeviceIdentity
): MatchResult<E> {
	const matches: DeviceMatch<E>[] = [];
	for (const entry of candidates) {
		const match = entry.match;
		if (!match || (entry.status ?? entry.meta?.status) === 'deprecated') continue;
		if (!inFirmwareRange(match.firmware, identity.firmware)) continue;
		let specificity = 0;
		if (identity.usb) {
			for (const e of match.usb ?? []) {
				specificity = Math.max(specificity, usbSpecificity(e, identity.usb));
			}
		}
		if (identity.bluetooth) {
			for (const e of match.bluetooth ?? []) {
				specificity = Math.max(specificity, bluetoothSpecificity(e, identity.bluetooth));
			}
		}
		if (specificity > 0) matches.push({ id: entry.id, specificity, entry });
	}
	matches.sort((a, b) => b.specificity - a.specificity || a.id.localeCompare(b.id));
	const top = matches[0];
	const ambiguous = top !== undefined && matches[1]?.specificity === top.specificity;
	return { matches, best: top && !ambiguous ? top : null, ambiguous };
}
