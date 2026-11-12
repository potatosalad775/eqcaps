// What the connect page hands the editor: a reviewed evidence file and the read-back in it, so a
// profile change can cite it and be checked against it (connect → read → validate → PR).
// Kept in sessionStorage: it stays in this tab and is never sent anywhere.

import type { AuthoringProfile, Filter, Profile, Source } from '@potatosalad775/eqcaps-core';
import {
	analyzeCodec,
	handlerCodeUrl,
	type DeviceIdentity,
	type Protocol
} from '@potatosalad775/eqcaps-device-bridge';
import { blankProfile } from './editor.ts';
import { guidedSource, readSource } from './evidence.ts';
import type { GuidedConstraints } from './guided/constraints.ts';

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
	/**
	 * A guided read (T3) rather than a single read: the evidence file is cited as `vendor-app`
	 * (D41), and the constraints it found go into the profile, with what it didn't settle in the
	 * notes.
	 */
	guided?: { constraints: GuidedConstraints; notes: string[]; vendorApp: string };
	/**
	 * The protocol that drove the device, and the commit of the bridge's code: a new profile
	 * starts from what the protocol's wire can carry (`handler-code`).
	 */
	protocol?: { handler: Protocol['handler']; options?: object; commit: string };
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

/**
 * `data` citing the handoff's evidence, once: a read-back as `community`, a guided read as
 * `vendor-app` (SPEC §10, D41). A guided read's constraints replace the file's (they override
 * what it extends).
 */
export function citeEvidence(data: AuthoringProfile, handoff: Handoff, by?: string) {
	const sources = data.meta?.sources ?? [];
	if (sources.some((s) => s.ref === handoff.evidence.path)) return data;
	const cite = handoff.guided ? guidedSource : readSource;
	const source = cite(handoff.evidence.path, handoff.date, by, handoff.firmware);
	const cited = { ...data, meta: { ...data.meta!, sources: [...sources, source] } };
	return handoff.guided ? withGuided(cited, handoff.guided, handoff.date) : cited;
}

/** `data` with a guided read's constraints, and its notes appended to `meta.notes`. */
export function withGuided(
	data: AuthoringProfile,
	guided: NonNullable<Handoff['guided']>,
	date: string
): AuthoringProfile {
	const { bands, ...rest } = guided.constraints;
	const out = { ...data, ...rest } as AuthoringProfile;
	if (bands) out.bands = bands;
	else delete out.bands;
	const line = `Guided read with the eqcaps inspector on ${date}: the values were set in ${guided.vendorApp} and read back from the device.${guided.notes.length ? ` ${guided.notes.join(' ')}` : ''}`;
	const notes = data.meta?.notes ? `${data.meta.notes}\n${line}` : line;
	return { ...out, meta: { ...out.meta!, notes } };
}

/**
 * What a protocol's wire can carry, as profile constraints for `bandCount` bands, with the
 * `handler-code` source that says so (SPEC §10: wire limits only, never verified). A float field
 * the wire doesn't bound keeps the editor's placeholder, and the notes say which.
 */
export function codecDraft(
	protocol: NonNullable<Handoff['protocol']>,
	bandCount: number,
	date: string
): {
	constraints: Pick<AuthoringProfile, 'bandCount' | 'band' | 'preamp'>;
	source: Source;
	notes: string;
} {
	const analysis = analyzeCodec({
		handler: protocol.handler,
		options: protocol.options
	} as Protocol);
	const blank = blankProfile();
	const placeholders: string[] = [];
	const field = <K extends 'freq' | 'q' | 'gain'>(k: K) => {
		const d = analysis[k];
		if (d) return d;
		placeholders.push(k);
		return blank.band![k]!;
	};
	const band = {
		types: analysis.types.filter((t) => !t.startsWith('x-')),
		freq: field('freq'),
		q: field('q'),
		gain: field('gain')
	};
	const count = Math.min(Math.max(bandCount, analysis.bands.min), analysis.bands.max);
	return {
		constraints: {
			bandCount: count,
			band,
			preamp: analysis.preamp ? { mode: 'manual', gain: analysis.preamp } : { mode: 'unknown' }
		},
		source: { kind: 'handler-code', ref: handlerCodeUrl(protocol.handler, protocol.commit), date },
		notes: `Started from what the ${protocol.handler} protocol can write: wire limits, not what the device accepts.${placeholders.length ? ` ${placeholders.join(', ')}: placeholders (the wire carries any value).` : ''}`
	};
}

/**
 * What a device profile for a member of `group` extends: the base the group extends (the first
 * file its inherited sources came from, SPEC §11), or the group itself when it extends nothing.
 * SPEC §3: members extend the group's base, since groups shrink as members get profiles.
 */
export function memberBase(group: Profile): string {
	const via = group.meta.sources.find((s) => s.via !== undefined)?.via;
	return via ?? group.id;
}

/**
 * A new profile for a device, from what it said about itself: the USB identity as its match
 * (exact product name, SPEC §3). It extends `handoff.extends` when set, so only identity and
 * provenance are written (the protocol comes from the base too, D42); otherwise it is a whole
 * profile with as many bands as the device returned, driven by the protocol that read it. Bluetooth names are left out: people rename their devices, so the user writes the
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
	if (!handoff.extends && handoff.protocol) {
		const { handler, options = {} } = handoff.protocol;
		data.protocol = Object.keys(options).length
			? { handler, options: { ...options } }
			: { handler };
	}
	if (!handoff.extends && !handoff.guided && handoff.protocol) {
		const draft = codecDraft(handoff.protocol, data.bandCount ?? 10, handoff.date);
		Object.assign(data, draft.constraints);
		data.meta = { ...data.meta!, sources: [draft.source], notes: draft.notes };
	}
	return citeEvidence(data, handoff);
}
