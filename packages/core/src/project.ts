import type { NumericField } from './dependencies.ts';
import { domainBounds, near, onGrid } from './domain.ts';
import type { Domain, FilterType } from './types/schema.generated.ts';

/** A field with a domain: a filter's numeric fields, or the preamp gain. */
export type DomainField = NumericField | 'preamp';

/** Why a value is not a member of its domain (SPEC §13.4). */
export type DomainViolation = 'out-of-range' | 'off-grid' | 'not-in-set' | 'locked';

/** Fixed to 10 decimal places, so grid points come out as written (SPEC §13.2). */
export function normalizeDecimal(x: number): number {
	const r = Number(x.toFixed(10));
	return r === 0 ? 0 : r;
}

/** Distance used to pick the nearest set value: log ratio for freq and q, difference otherwise. */
function distance(a: number, b: number, field: DomainField): number {
	return field === 'freq' || field === 'q' ? Math.abs(Math.log(a / b)) : Math.abs(a - b);
}

/** The value a field takes when nothing else asks for one: 0 dB, Q 1, the domain's log centre. */
export function neutralValue(domain: Domain, field: DomainField): number {
	if (field === 'gain' || field === 'preamp') return 0;
	if (field === 'q') return 1;
	const { min, max } = domainBounds(domain);
	return Math.sqrt(min * max);
}

/**
 * The domain member closest to `value` (SPEC §13.2). Exact and normative. A NaN projects as the
 * field's neutral value would; ±∞ project onto the bounds.
 */
export function project(value: number, domain: Domain, field: DomainField): number {
	if (Number.isNaN(value)) return project(neutralValue(domain, field), domain, field);
	if ('value' in domain) return domain.value;
	if ('values' in domain) {
		const values = domain.values;
		const first = values[0] as number;
		const last = values[values.length - 1] as number;
		const x = Math.min(Math.max(value, first), last);
		let best = first;
		let bestDistance = distance(x, first, field);
		for (const v of values) {
			const d = distance(x, v, field);
			// Ties go to the lower value, and values are ascending: only a strictly closer one wins.
			if (d < bestDistance && !near(d, bestDistance)) {
				best = v;
				bestDistance = d;
			}
		}
		return best;
	}
	const c = Math.min(Math.max(value, domain.min), domain.max);
	if (!('step' in domain)) return c;
	const { min, max, step } = domain;
	const k = Math.floor(c / step + 0.5);
	let v = k * step;
	if (v > max && !near(v, max)) v = (k - 1) * step;
	else if (v < min && !near(v, min)) v = (k + 1) * step;
	return normalizeDecimal(v);
}

/** Keep the type if the slot allows it, otherwise the slot's first type (SPEC §13.2). */
export function projectType(type: FilterType, types: readonly FilterType[]): FilterType {
	return types.includes(type) ? type : (types[0] as FilterType);
}

/** Why `value` is not in `domain`, or null if it is (SPEC §4 tolerance). */
export function domainViolation(value: number, domain: Domain): DomainViolation | null {
	if ('value' in domain)
		return Number.isFinite(value) && near(value, domain.value) ? null : 'locked';
	if ('values' in domain) {
		return Number.isFinite(value) && domain.values.some((v) => near(value, v))
			? null
			: 'not-in-set';
	}
	if (!Number.isFinite(value)) return 'out-of-range';
	if (value < domain.min && !near(value, domain.min)) return 'out-of-range';
	if (value > domain.max && !near(value, domain.max)) return 'out-of-range';
	if ('step' in domain && !onGrid(value, domain.step)) return 'off-grid';
	return null;
}

export function inDomain(value: number, domain: Domain): boolean {
	return domainViolation(value, domain) === null;
}
