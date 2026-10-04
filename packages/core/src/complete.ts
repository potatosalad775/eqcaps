import { fitToSlot } from './fit-slot.ts';
import {
	ascendingBreaks,
	ascendingFillerFreqs,
	defaultFillerFreq,
	fillerFinish,
	fillerStart,
	type FillerStart
} from './filler.ts';
import { isActive, normalizeFilter, type Filter } from './filter.ts';
import { engineProfile, type EngineProfile, type EngineSlot } from './resolve.ts';
import type { Profile } from './types/schema.generated.ts';

export interface CompleteWarning {
	slot: number;
	/**
	 * not-neutral: the filler is active, because the slot can't take a gain of 0 or only allows
	 * gainless types. no-room: no filler frequency satisfies ascendingFrequency.
	 */
	code: 'not-neutral' | 'no-room';
}

export interface CompleteOptions {
	/**
	 * What each slot held before, by slot: typically read back from the engine. An empty slot takes
	 * its hint written flat (type, freq and q projected onto the slot, gain 0) instead of a neutral
	 * filler, so a write keeps the engine's own layout. A hint that can't be flat, or that would add
	 * an ascendingFrequency break, is ignored.
	 */
	hints?: readonly (Filter | null | undefined)[];
}

export interface CompleteResult {
	/** Exactly bandCount written filters; the non-null filters of `slots` when unbounded. */
	filters: Filter[];
	warnings: CompleteWarning[];
}

/**
 * Fill every empty slot with a neutral filter, or its hint written flat, for engines that always
 * take bandCount filters (SPEC §13.7, the hardware write path). Filled slots pass through
 * unchanged. Normative only
 * through its properties: fillers are in their domains, neutral where the slot allows it, and
 * under ascendingFrequency they keep the order whenever validate found no break.
 */
export function complete(
	profile: Profile,
	slots: readonly (Filter | null)[],
	options: CompleteOptions = {}
): CompleteResult {
	const p = engineProfile(profile);
	if (p.bandCount === null) {
		return { filters: slots.flatMap((f) => (f ? [normalizeFilter(f)] : [])), warnings: [] };
	}
	const n = p.bandCount;
	const filled = options.hints ? withHints(p, slots, options.hints) : slots;
	const starts = new Map<number, FillerStart>();
	for (let i = 0; i < n; i++) if (!filled[i]) starts.set(i, fillerStart(p.slots[i] as EngineSlot));

	const warnings: CompleteWarning[] = [];
	const ascending = (profile.rules ?? []).find((r) => r.type === 'ascendingFrequency');
	let freqs: Map<number, number>;
	if (ascending) {
		const chosen = ascendingFillerFreqs(p, filled, starts, ascending.strict ?? true);
		freqs = chosen.freqs;
		for (const slot of chosen.noRoom) warnings.push({ slot, code: 'no-room' });
	} else {
		freqs = new Map([...starts].map(([i, s]) => [i, defaultFillerFreq(s.freqDomain)]));
	}

	const filters: Filter[] = [];
	for (let i = 0; i < n; i++) {
		const f = filled[i];
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

/**
 * `slots` with each empty slot's hint, written flat, wherever it can be: every one when together
 * they add no ascendingFrequency break, otherwise each one, in slot order, that adds none. Kept
 * hints act as filled slots, so the fillers that remain keep the order as before.
 */
function withHints(
	p: EngineProfile,
	slots: readonly (Filter | null)[],
	hints: readonly (Filter | null | undefined)[]
): (Filter | null)[] {
	const n = p.bandCount as number;
	const base = Array.from({ length: n }, (_, i) => slots[i] ?? null);
	const flat = new Map<number, Filter>();
	for (let i = 0; i < n; i++) {
		const h = hints[i];
		if (base[i] || !h) continue;
		const g = fitToSlot(p.slots[i] as EngineSlot, normalizeFilter({ ...h, gain: 0 }));
		if (!isActive(g)) flat.set(i, g);
	}
	const all = [...base];
	for (const [i, g] of flat) all[i] = g;
	const ascending = (p.profile.rules ?? []).find((r) => r.type === 'ascendingFrequency');
	if (!ascending) return all;
	const strict = ascending.strict ?? true;
	let breaks = ascendingBreaks(p, base, strict).length;
	if (ascendingBreaks(p, all, strict).length <= breaks) return all;
	let out = base;
	for (const [i, g] of flat) {
		const trial = [...out];
		trial[i] = g;
		const b = ascendingBreaks(p, trial, strict).length;
		if (b <= breaks) {
			out = trial;
			breaks = b;
		}
	}
	return out;
}
