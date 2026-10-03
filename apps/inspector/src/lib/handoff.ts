// What the connect page hands the editor: a reviewed evidence file and the read-back in it, so a
// profile change can cite it and be checked against it (connect → read → validate → PR).
// Kept in sessionStorage: it stays in this tab and is never sent anywhere.

import type { AuthoringProfile, Filter } from '@potatosalad775/eqcaps-core';
import type { DeviceIdentity } from '@potatosalad775/eqcaps-device-bridge';
import { blankProfile } from './editor.ts';
import { readSource } from './evidence.ts';

export interface Handoff {
	/** The profile the device was checked against; absent for a device the database lacks. */
	profileId?: string;
	/** The reviewed evidence file: its path under data/ and its text. */
	evidence: { path: string; text: string };
	date: string;
	firmware?: string;
	identity: DeviceIdentity;
	readBack: { filters: (Filter | null)[]; preamp?: number };
	/** The protocol reads as many bands as it is asked for, so the count says nothing (D33). */
	needsBandCount: boolean;
}

const KEY = 'eqcaps-inspector:handoff';

export function saveHandoff(handoff: Handoff): void {
	try {
		sessionStorage.setItem(KEY, JSON.stringify(handoff));
	} catch {
		// Private mode: the editor then starts without it.
	}
}

export function loadHandoff(): Handoff | null {
	try {
		const text = sessionStorage.getItem(KEY);
		return text ? (JSON.parse(text) as Handoff) : null;
	} catch {
		return null;
	}
}

/** `data` citing the handoff's evidence, once. */
export function citeEvidence(data: AuthoringProfile, handoff: Handoff, by?: string) {
	const sources = data.meta?.sources ?? [];
	if (sources.some((s) => s.ref === handoff.evidence.path)) return data;
	const source = readSource(handoff.evidence.path, handoff.date, by, handoff.firmware);
	return { ...data, meta: { ...data.meta, sources: [...sources, source] } };
}

/**
 * A new profile for a device the database doesn't know, from what it said about itself: the USB
 * identity as its match (exact product name, SPEC §3), and as many bands as it returned. Bluetooth
 * names are left out: people rename their devices, so the user writes the match by hand.
 */
export function profileForDevice(handoff: Handoff): AuthoringProfile {
	const data = blankProfile();
	const u = handoff.identity.usb;
	const b = handoff.identity.bluetooth;
	data.device = { brand: '', model: u?.productName?.trim() ?? '' };
	data.match = u
		? {
				usb: [
					{
						vendorId: u.vendorId,
						...(u.productId !== undefined ? { productId: u.productId } : {}),
						...(u.productName !== undefined ? { productName: u.productName } : {})
					}
				]
			}
		: b
			? { bluetooth: [{ namePrefix: '' }] }
			: {};
	if (handoff.readBack.filters.length > 0) data.bandCount = handoff.readBack.filters.length;
	return citeEvidence(data, handoff);
}
