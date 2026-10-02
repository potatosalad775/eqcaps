import { normalizeFilter, type Filter } from './filter.ts';
import type { FilterType, Law, Profile, ShelfFrequencyShiftLaw } from './types/schema.generated.ts';

// Realization laws (SPEC §8). `f`, `q` and `gain` are written values; gainless types count as
// gain 0 (callers pass normalized filters). A law with a designRate is the identity outside
// 0 < f < designRate/2, where its formula has no meaning (SPEC §13.3).

const applies = (law: Law, type: FilterType) => (law.types as readonly FilterType[]).includes(type);
const amplitude = (gain: number) => 10 ** (Math.abs(gain) / 40);
const inBand = (f: number, designRate: number) => f > 0 && f < designRate / 2;

/** Product of the q factors of every q law that applies to `type`. */
export function qFactor(
	laws: readonly Law[],
	type: FilterType,
	freq: number,
	gain: number
): number {
	let factor = 1;
	for (const law of laws) {
		if (!applies(law, type)) continue;
		if (law.law === 'gainScaledQ') factor /= amplitude(gain);
		else if (law.law === 'nyquistScaledQ' && inBand(freq, law.designRate)) {
			factor *= Math.cos((Math.PI * freq) / law.designRate);
		}
	}
	return factor;
}

function freqLaw(laws: readonly Law[], type: FilterType): ShelfFrequencyShiftLaw | undefined {
	return laws.find(
		(law): law is ShelfFrequencyShiftLaw => law.law === 'shelfFrequencyShift' && applies(law, type)
	);
}

function shelfShift(type: FilterType, gain: number): number {
	const root = Math.sqrt(amplitude(gain));
	return type === 'HSC' ? 1 / root : root;
}

/** Realized frequency of a written one. */
export function realizedFreq(
	laws: readonly Law[],
	type: FilterType,
	f: number,
	gain: number
): number {
	const law = freqLaw(laws, type);
	if (!law || !inBand(f, law.designRate)) return f;
	const r = law.designRate;
	return (r / Math.PI) * Math.atan(Math.tan((Math.PI * f) / r) * shelfShift(type, gain));
}

/** Written frequency that realizes `f`. */
export function writtenFreq(
	laws: readonly Law[],
	type: FilterType,
	f: number,
	gain: number
): number {
	const law = freqLaw(laws, type);
	if (!law || !inBand(f, law.designRate)) return f;
	const r = law.designRate;
	return (r / Math.PI) * Math.atan(Math.tan((Math.PI * f) / r) / shelfShift(type, gain));
}

/** Written q that realizes `q`, given the written freq and gain. */
export function writtenQ(
	laws: readonly Law[],
	type: FilterType,
	q: number,
	freq: number,
	gain: number
): number {
	return q / qFactor(laws, type, freq, gain);
}

/** The filter the engine produces from these written values (SPEC §13.3). Exact and normative. */
export function toRealized(profile: Profile, filter: Filter): Filter {
	return realize(profile.realization?.laws ?? [], filter);
}

/** The written values that make the engine produce this filter (SPEC §13.3). Exact and normative. */
export function toWritten(profile: Profile, filter: Filter): Filter {
	return unrealize(profile.realization?.laws ?? [], filter);
}

export function realize(laws: readonly Law[], filter: Filter): Filter {
	const f = normalizeFilter(filter);
	if (laws.length === 0) return f;
	return {
		type: f.type,
		freq: realizedFreq(laws, f.type, f.freq, f.gain),
		q: f.q * qFactor(laws, f.type, f.freq, f.gain),
		gain: f.gain
	};
}

export function unrealize(laws: readonly Law[], filter: Filter): Filter {
	const f = normalizeFilter(filter);
	if (laws.length === 0) return f;
	const freq = writtenFreq(laws, f.type, f.freq, f.gain);
	return { type: f.type, freq, q: writtenQ(laws, f.type, f.q, freq, f.gain), gain: f.gain };
}
