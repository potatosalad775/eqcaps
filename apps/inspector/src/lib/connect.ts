// Identify (T1) and read (T2) helpers: what a connected device says about itself, and what its
// read-back says about its profile (INSPECTOR §2). Nothing here writes to a device.

import {
	describeDomain,
	validate,
	type Domain,
	type Filter,
	type Profile,
	type Violation
} from '@potatosalad775/eqcaps-core';
import type {
	DeviceCapabilities,
	DeviceIdentity,
	HidCollectionInfo,
	PullResult,
	WireField
} from '@potatosalad775/eqcaps-device-bridge';
import { formatNumber } from './format.ts';
import { REPO_URL } from './repo.ts';

const hex = (n: number, digits = 4) => `0x${n.toString(16).padStart(digits, '0')}`;

/** 'USB 0x2972:0x0093 "FIIO KA17"', 'Bluetooth "Nothing Ear (2)"'. One line per transport. */
export function identityText(identity: DeviceIdentity): string {
	const lines: string[] = [];
	const u = identity.usb;
	if (u) {
		const name = u.productName !== undefined ? ` "${u.productName}"` : '';
		lines.push(`USB ${u.vendorId}${u.productId ? `:${u.productId}` : ''}${name}`);
	}
	const b = identity.bluetooth;
	if (b) {
		const parts = [b.name !== undefined ? `"${b.name}"` : null, ...(b.serviceUuids ?? [])];
		lines.push(`Bluetooth ${parts.filter(Boolean).join(' ')}`);
	}
	return lines.join('\n');
}

/**
 * The HID descriptor as an indented outline (INSPECTOR §2 T1): collections with their usage page
 * and usage, and every report id with its payload size.
 */
export function descriptorText(collections: readonly HidCollectionInfo[], depth = 0): string {
	const pad = '  '.repeat(depth);
	const lines: string[] = [];
	for (const c of collections) {
		const vendor = c.usagePage >= 0xff00 ? ' (vendor-defined)' : '';
		lines.push(`${pad}collection usagePage ${hex(c.usagePage)} usage ${hex(c.usage)}${vendor}`);
		for (const [kind, reports] of [
			['input', c.inputReports],
			['output', c.outputReports],
			['feature', c.featureReports]
		] as const) {
			for (const r of reports) {
				const size = r.size === undefined ? '' : `, ${r.size} bytes`;
				lines.push(`${pad}  ${kind} report ${r.reportId}${size}`);
			}
		}
		if (c.children.length) lines.push(descriptorText(c.children, depth + 1));
	}
	return lines.join('\n');
}

/** A prefilled "New device" issue (.github/ISSUE_TEMPLATE/new-device.yml). */
export function newDeviceIssueUrl(fields: {
	device: string;
	identity: string;
	eq?: string;
	evidence?: string;
}): string {
	const url = new URL(`${REPO_URL}/issues/new`);
	url.searchParams.set('template', 'new-device.yml');
	url.searchParams.set('title', `New device: ${fields.device}`);
	url.searchParams.set('device', fields.device);
	url.searchParams.set('identity', fields.identity);
	if (fields.eq) url.searchParams.set('eq', fields.eq);
	if (fields.evidence) url.searchParams.set('evidence', fields.evidence);
	return url.href;
}

/** A prefilled "Wrong constraint" issue (.github/ISSUE_TEMPLATE/wrong-constraint.yml). */
export function wrongConstraintIssueUrl(fields: {
	profile: string;
	wrong: string;
	evidence: string;
}): string {
	const url = new URL(`${REPO_URL}/issues/new`);
	url.searchParams.set('template', 'wrong-constraint.yml');
	url.searchParams.set('title', `Wrong constraint: ${fields.profile}`);
	url.searchParams.set('profile', fields.profile);
	url.searchParams.set('wrong', fields.wrong);
	url.searchParams.set('evidence', fields.evidence);
	url.searchParams.set('app', 'eqcaps inspector');
	return url.href;
}

/** What a read-back says about the profile (INSPECTOR §2 T2). Each finding is a discrepancy. */
export interface ReadFindings {
	/** The device returned a different number of bands than the profile has. */
	bandCount: { read: number; profile: number } | null;
	/** validate(profile, read-back): values the profile says the device can't hold. */
	violations: Violation[];
}

export function readFindings(
	profile: Profile,
	pull: PullResult,
	capabilities: Pick<DeviceCapabilities, 'needsBandCount'>
): ReadFindings {
	const n = pull.filters.length;
	const bandCount =
		profile.bandCount !== null && !capabilities.needsBandCount && n !== profile.bandCount
			? { read: n, profile: profile.bandCount }
			: null;
	// Bands past the profile's count are already the band-count finding.
	const slots =
		profile.bandCount === null ? pull.filters : pull.filters.slice(0, profile.bandCount);
	return {
		bandCount,
		violations: validate(profile, slots, pull.preamp).filter((v) => v.code !== 'too-many-bands')
	};
}

const describeWire = (
	w: WireField | { values: readonly number[] },
	field: 'freq' | 'q' | 'gain' | 'preamp'
) =>
	'values' in w
		? describeDomain({ values: [...w.values] }, field)
		: w.step === undefined
			? `${describeDomain({ min: w.min, max: w.max }, field)} (floating point)`
			: describeDomain({ min: w.min, max: w.max, step: w.step }, field);

/** The profile's template domain beside what the protocol's write frames can carry (D33). */
export function wireRows(
	profile: Profile,
	wire: DeviceCapabilities['wire']
): { field: string; profile: string; wire: string }[] {
	const show = (d: Domain | undefined, field: 'freq' | 'q' | 'gain' | 'preamp') =>
		d ? describeDomain(d, field) : '—';
	const pre = profile.preamp.mode === 'manual' ? profile.preamp.gain : undefined;
	const rows = [
		{
			field: 'freq',
			profile: show(profile.band.freq, 'freq'),
			wire: describeWire(wire.freq, 'freq')
		},
		{
			field: 'q',
			profile: show(profile.band.q, 'q'),
			wire: wire.q ? describeWire(wire.q, 'q') : 'not written'
		},
		{
			field: 'gain',
			profile: show(profile.band.gain, 'gain'),
			wire: describeWire(wire.gain, 'gain')
		},
		{
			field: 'preamp',
			profile: pre ? show(pre, 'preamp') : profile.preamp.mode,
			wire: wire.preamp ? describeWire(wire.preamp, 'preamp') : 'not written'
		}
	];
	return rows;
}

/** One read-back band as text: "PK 1000 Hz −3 dB Q 1.41". */
export function filterText(f: Filter): string {
	return `${f.type} ${formatNumber(f.freq)} Hz ${formatNumber(f.gain)} dB Q ${formatNumber(f.q)}`;
}
