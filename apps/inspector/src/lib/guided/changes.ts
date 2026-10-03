// Change detection between two reads (INSPECTOR §3.1 step 4). Every change is reported, not only
// the one a step asked for: users touch other controls, and a step whose read shows nothing new
// usually means the app hasn't saved yet.

import { near } from '@potatosalad775/eqcaps-core';
import { formatNumber } from '../format.ts';
import type { Change, NumField, Snapshot } from './types.ts';

const FIELDS = ['type', 'freq', 'q', 'gain'] as const;

/** Every difference from `before` to `after`, band by band (1-based), then the preamp. */
export function changes(before: Snapshot, after: Snapshot): Change[] {
	const out: Change[] = [];
	const count = Math.max(before.filters.length, after.filters.length);
	for (let i = 0; i < count; i++) {
		const a = before.filters[i] ?? null;
		const b = after.filters[i] ?? null;
		const band = i + 1;
		if (!a || !b) {
			if (a !== b)
				out.push({ band, field: 'filter', from: a ? 'on' : 'off', to: b ? 'on' : 'off' });
			continue;
		}
		for (const field of FIELDS) {
			const x = a[field];
			const y = b[field];
			const same = typeof x === 'number' && typeof y === 'number' ? near(x, y) : x === y;
			if (!same) out.push({ band, field, from: x, to: y });
		}
	}
	const p = before.preamp;
	const q = after.preamp;
	if (p !== q && !(p !== undefined && q !== undefined && near(p, q))) {
		out.push({ field: 'preamp', from: p ?? null, to: q ?? null });
	}
	return out;
}

/** The value of `field` in `band` (1-based; ignored for the preamp), or undefined if not read. */
export function valueAt(read: Snapshot, field: NumField, band?: number): number | undefined {
	if (field === 'preamp') return read.preamp;
	const f = band === undefined ? undefined : read.filters[band - 1];
	return f ? f[field] : undefined;
}

/** "band 2 gain 0 → 3", "preamp −1 → 0", "band 4 off → on". */
export function changeText(c: Change): string {
	const where =
		c.band === undefined ? c.field : `band ${c.band} ${c.field === 'filter' ? '' : c.field}`;
	const v = (x: Change['from']) =>
		typeof x === 'number' ? formatNumber(x).replace('-', '−') : String(x);
	return `${where.trimEnd()} ${v(c.from)} → ${v(c.to)}`;
}
