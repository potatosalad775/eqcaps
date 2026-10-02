import type { BandOverride, Profile, SlotFields } from './types/schema.generated.ts';

export interface SlotOverride {
	entry: BandOverride;
	/** JSON Pointer of the bands[] entry. */
	path: string;
}

/** Indices listed by one bands[] entry. */
export function overrideIndices(entry: BandOverride): number[] {
	return Array.isArray(entry.index) ? entry.index : [entry.index];
}

/** The override for each slot index. When a slot is overridden twice, the first one wins. */
export function slotOverrides(profile: Pick<Profile, 'bands'>): Map<number, SlotOverride> {
	const map = new Map<number, SlotOverride>();
	(profile.bands ?? []).forEach((entry, k) => {
		for (const i of overrideIndices(entry)) {
			if (!map.has(i)) map.set(i, { entry, path: `/bands/${k}` });
		}
	});
	return map;
}

/** Template merged with an override, per key, replace (SPEC §5.2). */
export function mergeSlotFields(band: SlotFields, override: BandOverride | undefined): SlotFields {
	if (!override) return { ...band };
	const { index: _index, ...fields } = override;
	return { ...band, ...fields };
}
