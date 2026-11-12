// A guided read's log: entries appended as the user reads, skips and finishes steps. Changes are
// measured from the previous read of any step, or from the first read for the restore step.

import { changes } from './changes.ts';
import type { Entry, GuidedContext, Snapshot, Step } from './types.ts';

/** The latest read: the last read entry's, or the first read before any step. */
export function lastRead(ctx: GuidedContext, entries: readonly Entry[]): Snapshot {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.kind === 'read') return e.read;
	}
	return ctx.first;
}

/** The entry for a read made for `step`. */
export function readEntry(
	ctx: GuidedContext,
	entries: readonly Entry[],
	step: Step,
	read: Snapshot,
	opts: { typed?: number; already?: boolean } = {}
): Entry {
	const before = step.ask === 'restore' ? ctx.first : lastRead(ctx, entries);
	return {
		kind: 'read',
		step,
		read,
		changed: changes(before, read),
		...(opts.typed !== undefined ? { typed: opts.typed } : {}),
		...(opts.already ? { already: true } : {})
	};
}
