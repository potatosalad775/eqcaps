import { lowestAtLeast } from './filler.ts';
import { usesGain, type Filter } from './filter.ts';
import { project, projectType } from './project.ts';
import { resolveField, type EngineSlot } from './resolve.ts';

/**
 * Written values for one slot that come closest to a wanted (normalized) filter (SPEC §13.6 step
 * 2): project the type, then each field in evaluation order onto its domain resolved against the
 * fields already final.
 *
 * `freqAtLeast` replaces the wanted frequency by the lowest written frequency at or above it that
 * the domain allows, which is how minSpacing moves a filter.
 */
export function fitToSlot(slot: EngineSlot, wanted: Filter, freqAtLeast?: number): Filter {
	const type = projectType(wanted.type, slot.types);
	const v: Partial<Filter> & Pick<Filter, 'type'> = { type };
	for (const f of slot.order) {
		if (f === 'gain') {
			v.gain = usesGain(type) ? project(wanted.gain, resolveField(slot, 'gain', v), 'gain') : 0;
		} else if (f === 'freq') {
			const domain = resolveField(slot, 'freq', v);
			v.freq =
				freqAtLeast === undefined
					? project(wanted.freq, domain, 'freq')
					: (lowestAtLeast(domain, freqAtLeast) ?? project(freqAtLeast, domain, 'freq'));
		} else {
			v.q = project(wanted.q, resolveField(slot, 'q', v), 'q');
		}
	}
	return v as Filter;
}
