// Evidence files (INSPECTOR §6): what the inspector saw on a device, as a JSON file the contributor
// reviews, downloads and submits with a profile change. Stored in the repository at
// data/evidence/<profile id>/<date>-<short hash>.json and referenced from meta.sources.

import type { Filter, Source } from '@potatosalad775/eqcaps-core';
import type { DeviceIdentity, PullResult } from '@potatosalad775/eqcaps-device-bridge';

/** A read-back (T2): the EQ the device holds, as its protocol reports it. No push. */
export interface ReadExperiment {
	id: 'read';
	readBack: {
		/** Written values in band order; null for a band that is off or unset. */
		filters: (Filter | null)[];
		preamp?: number;
		slot?: number;
	};
	/** What the read-back says about the profile it was checked against (violation texts). */
	findings: string[];
}

export interface EvidenceReport {
	evidenceVersion: 1;
	tool: { name: 'eqcaps inspector'; commit: string; userAgent?: string };
	device: {
		transport: 'hid' | 'serial' | 'ble';
		vendorId?: string;
		productId?: string;
		productName?: string;
		bluetoothName?: string;
		firmware?: string;
	};
	/** The device bridge handler that read it; `experimental` when guessed from the USB vendor. */
	handler: string;
	experimental?: true;
	/** The profile the device was checked against. */
	profile?: string;
	date: string;
	experiments: ReadExperiment[];
	caveats: string[];
}

export const READ_CAVEATS = [
	'Read-back only: shows values the device holds, not the limits of what it accepts.',
	'Realization not verified: the written values are what the device stores, not what it plays.'
];

/** The evidence for one read. Serial numbers and Bluetooth addresses are never included. */
export function readEvidence(input: {
	transport: 'hid' | 'serial' | 'ble';
	identity: DeviceIdentity;
	handler: string;
	experimental: boolean;
	profile?: string;
	pull: PullResult;
	findings: string[];
	commit: string;
	userAgent?: string;
	date: string;
}): EvidenceReport {
	const u = input.identity.usb;
	const b = input.identity.bluetooth;
	const device: EvidenceReport['device'] = { transport: input.transport };
	if (u?.vendorId !== undefined) device.vendorId = u.vendorId;
	if (u?.productId !== undefined) device.productId = u.productId;
	if (u?.productName !== undefined) device.productName = u.productName;
	if (b?.name !== undefined) device.bluetoothName = b.name;
	const readBack: ReadExperiment['readBack'] = { filters: [...input.pull.filters] };
	if (input.pull.preamp !== undefined) readBack.preamp = input.pull.preamp;
	if (input.pull.slot !== undefined) readBack.slot = input.pull.slot;
	return {
		evidenceVersion: 1,
		tool: {
			name: 'eqcaps inspector',
			commit: input.commit,
			...(input.userAgent ? { userAgent: input.userAgent } : {})
		},
		device,
		handler: input.handler,
		...(input.experimental ? { experimental: true as const } : {}),
		...(input.profile ? { profile: input.profile } : {}),
		date: input.date,
		experiments: [{ id: 'read', readBack, findings: input.findings }],
		caveats: [...READ_CAVEATS]
	};
}

/** A string in the report, by JSON Pointer, for the PII review (INSPECTOR §6). */
export interface StringField {
	pointer: string;
	value: string;
	/** Strings that can identify a person or a single device: reviewed first. */
	personal: boolean;
}

/** Fields whose text comes from the device or the browser rather than from the app. */
const PERSONAL = /^\/(device\/(productName|bluetoothName|firmware)|tool\/userAgent)$/;

/** Every string in `value`, so the export screen can show each one and let the user redact it. */
export function stringFields(value: unknown, pointer = ''): StringField[] {
	if (typeof value === 'string') {
		return [{ pointer, value, personal: PERSONAL.test(pointer) }];
	}
	if (Array.isArray(value)) return value.flatMap((v, i) => stringFields(v, `${pointer}/${i}`));
	if (value && typeof value === 'object') {
		return Object.entries(value).flatMap(([k, v]) =>
			stringFields(v, `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`)
		);
	}
	return [];
}

/**
 * `report` with strings replaced: `edits` maps a pointer to its new text, and an empty text
 * removes an object member (an array item becomes "redacted"). Returns a copy.
 */
export function applyEdits<T>(report: T, edits: ReadonlyMap<string, string>): T {
	const walk = (value: unknown, pointer: string): unknown => {
		if (typeof value === 'string') {
			const edit = edits.get(pointer);
			return edit === undefined ? value : edit;
		}
		if (Array.isArray(value)) {
			return value.map((v, i) => {
				const out = walk(v, `${pointer}/${i}`);
				return out === '' ? 'redacted' : out;
			});
		}
		if (value && typeof value === 'object') {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value)) {
				const next = walk(v, `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`);
				if (next !== '') out[k] = next;
			}
			return out;
		}
		return value;
	};
	return walk(report, '') as T;
}

/** The file's text: pretty-printed with tabs, one trailing newline. */
export function evidenceText(report: EvidenceReport): string {
	return `${JSON.stringify(report, null, '\t')}\n`;
}

/** `evidence/<profile id>/<date>-<6 hex of the text's SHA-256>.json`, relative to data/. */
export async function evidencePath(profileId: string, date: string, text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `evidence/${profileId}/${date}-${hex.slice(0, 6)}.json`;
}

/**
 * The source a profile cites a read-back with. A read-back shows values the device holds, not the
 * limits of what it accepts, so it is `community` evidence: it doesn't count toward a verified
 * status (SPEC §10).
 */
export function readSource(ref: string, date: string, by?: string, firmware?: string): Source {
	return {
		kind: 'community',
		ref,
		...(firmware ? { firmware } : {}),
		date,
		...(by ? { by } : {})
	};
}

/** YYYY-MM-DD in the user's time zone. */
export function today(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
