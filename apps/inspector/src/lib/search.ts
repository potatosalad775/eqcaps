// Search over index entries (SPEC §14) and feature flags from flat profiles, for the browse page.

import {
	isGraphic,
	matchValues,
	type Domain,
	type IndexEntry,
	type Meta,
	type Profile
} from '@potatosalad775/eqcaps-core';

/** Profile traits a user can filter by (INSPECTOR §2 T0). */
export const FEATURES = {
	stepped: 'Stepped values',
	sets: 'Value sets',
	partitioned: 'Per-slot differences',
	conditional: 'Conditional domains',
	graphic: 'Graphic EQ',
	rules: 'Cross-band rules',
	preamp: 'Adjustable preamp'
} as const;

export type Feature = keyof typeof FEATURES;

function domainsOf(p: Profile): Domain[] {
	const slots = [p.band, ...(p.bands ?? [])];
	const out: Domain[] = [];
	for (const s of slots) {
		for (const d of [s.freq, s.q, s.gain]) if (d) out.push(d);
		for (const v of s.variants ?? []) for (const d of [v.freq, v.q, v.gain]) if (d) out.push(d);
	}
	if (p.preamp.mode === 'manual') out.push(p.preamp.gain);
	return out;
}

export function featuresOf(p: Profile): Set<Feature> {
	const out = new Set<Feature>();
	const domains = domainsOf(p);
	if (domains.some((d) => 'step' in d)) out.add('stepped');
	if (domains.some((d) => 'values' in d)) out.add('sets');
	if ((p.bands ?? []).length > 0) out.add('partitioned');
	if ([p.band, ...(p.bands ?? [])].some((s) => (s.variants ?? []).length > 0)) {
		out.add('conditional');
	}
	if (p.bandCount !== 0 && isGraphic(p)) out.add('graphic');
	if ((p.rules ?? []).length > 0) out.add('rules');
	if (p.preamp.mode === 'manual') out.add('preamp');
	return out;
}

export interface SearchFilters {
	query: string;
	status: Meta['status'] | '';
	kind: Profile['kind'] | '';
	features: readonly Feature[];
	/** Deprecated profiles are hidden unless asked for, or unless the query is their exact id. */
	showDeprecated: boolean;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** "0x2972", "2972", "2972:0047" and "0x2972:0x0047" all name USB ids. */
function usbQuery(q: string): { vendorId: string; productId?: string } | null {
	const m = /^(?:0x)?([0-9a-f]{4})(?:\s*[:/]\s*(?:0x)?([0-9a-f]{4}))?$/i.exec(q.trim());
	if (!m) return null;
	const hex = (s: string) => `0x${s.toLowerCase()}`;
	return m[2]
		? { vendorId: hex(m[1] as string), productId: hex(m[2]) }
		: { vendorId: hex(m[1] as string) };
}

function haystack(e: IndexEntry): string {
	const parts = [e.id, e.brand, e.model, e.engine ?? '', ...(e.aliases ?? [])];
	for (const u of e.match?.usb ?? []) parts.push(...matchValues(u.productName));
	for (const b of e.match?.bluetooth ?? []) {
		parts.push(...matchValues(b.name), ...matchValues(b.namePrefix));
	}
	return norm(parts.join(' \u0000 '));
}

/** Higher is better; 0 is no match. */
function score(e: IndexEntry, text: string, tokens: string[]): number {
	if (tokens.length === 0) return 1;
	const q = tokens.join(' ');
	const name = norm(`${e.brand} ${e.model}`);
	if (norm(e.id) === q) return 100;
	if (name === q || norm(e.model) === q) return 90;
	if (!tokens.every((t) => text.includes(t))) return 0;
	if (name.startsWith(q) || norm(e.model).startsWith(q)) return 50;
	if (tokens.every((t) => name.includes(t))) return 30;
	return 10;
}

export function searchEntries(
	entries: readonly IndexEntry[],
	features: ReadonlyMap<string, Set<Feature>>,
	f: SearchFilters
): IndexEntry[] {
	const tokens = norm(f.query).split(/\s+/).filter(Boolean);
	const usb = usbQuery(f.query);
	const scored: { e: IndexEntry; s: number }[] = [];
	for (const e of entries) {
		if (f.status && e.status !== f.status) continue;
		if (f.kind && e.kind !== f.kind) continue;
		if (f.features.length > 0) {
			const has = features.get(e.id);
			if (!has || !f.features.every((x) => has.has(x))) continue;
		}
		let s = score(e, haystack(e), tokens);
		if (usb) {
			const hit = (e.match?.usb ?? []).some(
				(u) =>
					matchValues(u.vendorId).includes(usb.vendorId) &&
					(usb.productId === undefined || matchValues(u.productId).includes(usb.productId))
			);
			if (hit) s = Math.max(s, usb.productId ? 95 : 40);
		}
		if (s === 0) continue;
		if (e.status === 'deprecated' && !f.showDeprecated && s < 100) continue;
		scored.push({ e, s });
	}
	scored.sort(
		(a, b) =>
			b.s - a.s ||
			a.e.brand.localeCompare(b.e.brand) ||
			a.e.model.localeCompare(b.e.model) ||
			a.e.id.localeCompare(b.e.id)
	);
	return scored.map((x) => x.e);
}
