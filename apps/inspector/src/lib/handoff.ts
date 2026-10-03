// What the connect page hands the editor: a reviewed evidence file and the read-back in it, so a
// profile change can cite it and be checked against it (connect → read → validate → PR).
// Kept in sessionStorage: it stays in this tab and is never sent anywhere.

import type { AuthoringProfile, Filter, Profile } from '@potatosalad775/eqcaps-core';
import type { DeviceIdentity } from '@potatosalad775/eqcaps-device-bridge';
import { blankProfile } from './editor.ts';
import { readSource } from './evidence.ts';

export interface Handoff {
	/**
	 * What the editor should do: `fix` the profile the device was checked against, or start a
	 * `new` profile for the device (one the database lacks, or a member of a group profile).
	 */
	action: 'fix' | 'new';
	/** The profile the device was checked against; absent for a device the database lacks. */
	profileId?: string;
	/** For a new profile: what it extends (a group's base, SPEC §3). */
	extends?: string;
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
 * What a device profile for a member of `group` extends: the base the group extends (the first
 * file its inherited sources came from, SPEC §11), or the group itself when it extends nothing.
 * SPEC §3: members extend the group's base, since groups shrink as members get profiles.
 */
export function memberBase(group: Profile): string {
	const via = [...group.meta.sources, ...(group.realization?.sources ?? [])].find(
		(s) => s.via !== undefined
	)?.via;
	return via ?? group.id;
}

/**
 * A new profile for a device, from what it said about itself: the USB identity as its match
 * (exact product name, SPEC §3). It extends `handoff.extends` when set, so only identity and
 * provenance are written; otherwise it is a whole profile with as many bands as the device
 * returned. Bluetooth names are left out: people rename their devices, so the user writes the
 * match by hand.
 */
export function profileForDevice(handoff: Handoff): AuthoringProfile {
	const data = blankProfile(handoff.extends ? { extends: handoff.extends } : {});
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
	if (!handoff.extends && handoff.readBack.filters.length > 0) {
		data.bandCount = handoff.readBack.filters.length;
	}
	return citeEvidence(data, handoff);
}
