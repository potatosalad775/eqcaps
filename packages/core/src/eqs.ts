// A device's other EQs (SPEC §9.2): which EQs a profile lists, and the profile of one of them.
// The engine never reads `protocol`; an app picks an EQ, takes its profile here, and runs the
// engine on that.

import { overrideIndices } from './slots.ts';
import type { BandOverride, Preset, Profile } from './types/schema.generated.ts';

/** One EQ of a device, as an app offers it. */
export interface ProfileEq {
	/** The handler's id of the EQ; undefined for the one the profile itself describes. */
	id?: string;
	/** The EQ's label: `engine` for the profile's own (which may have none), else its `name`. */
	name?: string;
	bandCount: number | null;
	presets: readonly Preset[];
}

/** The device's EQs: the one the profile describes first, then those `protocol.eqs` lists. */
export function profileEqs(profile: Profile): ProfileEq[] {
	const own: ProfileEq = {
		bandCount: profile.bandCount,
		presets: profile.protocol?.presets ?? []
	};
	if (profile.engine !== undefined) own.name = profile.engine;
	return [
		own,
		...(profile.protocol?.eqs ?? []).map((eq) => ({
			id: eq.id,
			name: eq.name,
			bandCount: eq.bandCount ?? profile.bandCount,
			presets: eq.presets ?? []
		}))
	];
}

/**
 * The profile of one of the device's EQs: `profile` itself for no id, and for an id in
 * `protocol.eqs` the profile with that EQ's label, band count and presets, without the list and
 * without the overrides of slots the EQ lacks. Undefined for an id the profile doesn't list.
 */
export function eqProfile(profile: Profile, id?: string): Profile | undefined {
	if (id === undefined) return profile;
	const eq = profile.protocol?.eqs?.find((e) => e.id === id);
	if (!eq || !profile.protocol) return undefined;
	const bandCount = eq.bandCount ?? profile.bandCount;
	const { eqs: _eqs, presets: _presets, ...protocol } = profile.protocol;
	const { bands, ...rest } = profile;
	const kept = (bands ?? []).flatMap((entry): BandOverride[] => {
		const indices = overrideIndices(entry).filter((i) => bandCount === null || i < bandCount);
		if (indices.length === 0) return [];
		return [{ ...entry, index: Array.isArray(entry.index) ? indices : indices[0]! }];
	});
	return {
		...rest,
		engine: eq.name,
		bandCount,
		...(bands !== undefined && kept.length > 0 ? { bands: kept } : {}),
		protocol: { ...protocol, ...(eq.presets ? { presets: eq.presets } : {}) }
	};
}
