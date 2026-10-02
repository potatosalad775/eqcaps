import { lowestAtLeast } from './filler.ts';
import { usesGain, type Filter } from './filter.ts';
import { project, projectType } from './project.ts';
import { writtenFreq, writtenQ } from './realization.ts';
import { resolveField, type EngineSlot } from './resolve.ts';
import type { Law } from './types/schema.generated.ts';

/**
 * Written values for one slot that come closest to a wanted (normalized) filter (SPEC §13.6 step
 * 2): project the type, then each field in evaluation order, computing its written value from the
 * wanted value and the fields already final, and projecting it onto its domain resolved against
 * those fields. With no laws, this projects a written filter onto the slot.
 *
 * `freqAtLeast` replaces the wanted frequency by the lowest written frequency at or above it that
 * the domain allows, which is how minSpacing moves a filter.
 */
export function fitToSlot(
	slot: EngineSlot,
	laws: readonly Law[],
	wanted: Filter,
	freqAtLeast?: number
): Filter {
	const type = projectType(wanted.type, slot.types);
	const v: Partial<Filter> & Pick<Filter, 'type'> = { type };
	for (const f of slot.order) {
		if (f === 'gain') {
			v.gain = usesGain(type) ? project(wanted.gain, resolveField(slot, 'gain', v), 'gain') : 0;
		} else if (f === 'freq') {
			const domain = resolveField(slot, 'freq', v);
			v.freq =
				freqAtLeast === undefined
					? project(writtenFreq(laws, type, wanted.freq, v.gain ?? 0), domain, 'freq')
					: (lowestAtLeast(domain, freqAtLeast) ?? project(freqAtLeast, domain, 'freq'));
		} else {
			const target = writtenQ(laws, type, wanted.q, v.freq ?? wanted.freq, v.gain ?? 0);
			v.q = project(target, resolveField(slot, 'q', v), 'q');
		}
	}
	return v as Filter;
}
