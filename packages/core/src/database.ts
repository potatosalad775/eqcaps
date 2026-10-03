import { firmwareRangesOverlap } from './firmware.ts';
import { error, type Issue } from './issues.ts';
import {
	expandBluetoothMatch,
	expandUsbMatch,
	type ScalarBluetoothMatch,
	type ScalarUsbMatch
} from './match.ts';
import type { Profile } from './types/schema.generated.ts';

/**
 * Rules that span profiles: unique ids, `replacedBy` targets that exist (SPEC §10), and no two
 * non-deprecated profiles with the same engine label claiming the same match entry for
 * overlapping firmware (SPEC §3). Entries that list several values claim each combination of
 * them. Input: every published profile of the database.
 */
export function checkDatabase(profiles: readonly Profile[]): Issue[] {
	const issues: Issue[] = [];
	const at = (p: Profile, issue: Issue): Issue => ({ ...issue, profileId: p.id });

	const ids = new Set<string>();
	for (const p of profiles) {
		if (ids.has(p.id))
			issues.push(at(p, error('duplicate-id', '/id', `id "${p.id}" is used twice`)));
		ids.add(p.id);
	}
	for (const p of profiles) {
		const target = p.meta.replacedBy;
		if (target !== undefined && !ids.has(target)) {
			issues.push(
				at(p, error('replaced-by-missing', '/meta/replacedBy', `no profile has id "${target}"`))
			);
		}
	}

	const claims = new Map<string, { profile: Profile; path: string }[]>();
	for (const p of profiles) {
		if (p.meta.status === 'deprecated' || !p.match) continue;
		const entries: [string, string][] = [
			...(p.match.usb ?? []).flatMap((e, i) =>
				expandUsbMatch(e).map((x): [string, string] => [usbKey(x), `/match/usb/${i}`])
			),
			...(p.match.bluetooth ?? []).flatMap((e, i) =>
				expandBluetoothMatch(e).map((x): [string, string] => [
					bluetoothKey(x),
					`/match/bluetooth/${i}`
				])
			)
		];
		const reported = new Set<string>();
		for (const [entryKey, path] of entries) {
			const k = `${p.engine ?? ''}\u0000${entryKey}`;
			for (const other of claims.get(k) ?? []) {
				if (other.profile.id === p.id) continue;
				const pair = `${path}\u0000${other.profile.id}\u0000${other.path}`;
				if (reported.has(pair)) continue;
				reported.add(pair);
				if (firmwareRangesOverlap(p.match.firmware, other.profile.match?.firmware)) {
					issues.push(
						at(
							p,
							error(
								'match-collision',
								path,
								`same match entry as ${other.profile.id} (${other.path}) for overlapping firmware; give them different engine labels or firmware ranges`
							)
						)
					);
				}
			}
			claims.set(k, [...(claims.get(k) ?? []), { profile: p, path }]);
		}
	}
	return issues;
}

const usbKey = (e: ScalarUsbMatch) =>
	JSON.stringify(['usb', e.vendorId, e.productId ?? null, e.productName ?? null]);

const bluetoothKey = (e: ScalarBluetoothMatch) =>
	JSON.stringify(['bt', e.name ?? null, e.namePrefix ?? null, e.serviceUuid ?? null]);
