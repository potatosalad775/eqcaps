import {
	ascendingFillerFreqs,
	defaultFillerFreq,
	fillerFinish,
	fillerStart,
	type FillerStart
} from './filler.ts';
import { isActive, normalizeFilter, type Filter } from './filter.ts';
import { engineProfile, type EngineSlot } from './resolve.ts';
import type { Profile } from './types/schema.generated.ts';

export interface CompleteWarning {
	slot: number;
	/**
	 * not-neutral: the filler is active, because the slot can't take a gain of 0 or only allows
	 * gainless types. no-room: no filler frequency satisfies ascendingFrequency.
	 */
	code: 'not-neutral' | 'no-room';
}

export interface CompleteResult {
	/** Exactly bandCount written filters; the non-null filters of `slots` when unbounded. */
	filters: Filter[];
	warnings: CompleteWarning[];
}

/**
 * Fill every empty slot with a neutral filter, for engines that always take bandCount filters
 * (SPEC §13.7, the hardware write path). Filled slots pass through unchanged. Normative only
 * through its properties: fillers are in their domains, neutral where the slot allows it, and
 * under ascendingFrequency they keep the order whenever validate found no break.
 */
export function complete(profile: Profile, slots: readonly (Filter | null)[]): CompleteResult {
	const p = engineProfile(profile);
	if (p.bandCount === null) {
		return { filters: slots.flatMap((f) => (f ? [normalizeFilter(f)] : [])), warnings: [] };
	}
	const n = p.bandCount;
	const starts = new Map<number, FillerStart>();
	for (let i = 0; i < n; i++) if (!slots[i]) starts.set(i, fillerStart(p.slots[i] as EngineSlot));

	const warnings: CompleteWarning[] = [];
	const ascending = (profile.rules ?? []).find((r) => r.type === 'ascendingFrequency');
	let freqs: Map<number, number>;
	if (ascending) {
		const chosen = ascendingFillerFreqs(p, slots, starts, ascending.strict ?? true);
		freqs = chosen.freqs;
		for (const slot of chosen.noRoom) warnings.push({ slot, code: 'no-room' });
	} else {
		freqs = new Map([...starts].map(([i, s]) => [i, defaultFillerFreq(s.freqDomain)]));
	}

	const filters: Filter[] = [];
	for (let i = 0; i < n; i++) {
		const f = slots[i];
		if (f) {
			filters.push(normalizeFilter(f));
			continue;
		}
		const filler = fillerFinish(
			p.slots[i] as EngineSlot,
			starts.get(i) as FillerStart,
			freqs.get(i) as number
		);
		if (isActive(filler)) warnings.push({ slot: i, code: 'not-neutral' });
		filters.push(filler);
	}
	warnings.sort((a, b) => a.slot - b.slot);
	return { filters, warnings };
}
