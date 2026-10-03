// Engine output (SPEC §13.4) as sentences for the playground and the device check.

import {
	describeDomain,
	type Domain,
	type Filter,
	type FilterType,
	type Violation
} from '@potatosalad775/eqcaps-core';
import { formatField } from './format.ts';

const isDomain = (a: Violation['allowed']): a is Domain => !!a && !Array.isArray(a);

/** "Filter 3, slot 2: gain 15 is out of range (allowed −12 dB to +12 dB)". */
export function violationText(v: Violation, filters?: readonly (Filter | null)[]): string {
	const where = [
		v.filter !== undefined ? `Filter ${v.filter + 1}` : null,
		v.slot !== null ? `slot ${v.slot + 1}` : null
	]
		.filter(Boolean)
		.join(', ');
	const f =
		v.filter !== undefined ? filters?.[v.filter] : v.slot !== null ? filters?.[v.slot] : null;
	const value = (field: 'freq' | 'q' | 'gain') => (f ? ` ${formatField(field, f[field])}` : '');
	const allowed = (field: 'freq' | 'q' | 'gain' | 'preamp') =>
		isDomain(v.allowed) ? ` (allowed: ${describeDomain(v.allowed, field)})` : '';

	let what: string;
	switch (v.code) {
		case 'type-not-allowed':
		case 'unknown-type': {
			const types = Array.isArray(v.allowed)
				? ` (allowed: ${(v.allowed as FilterType[]).join(', ')})`
				: '';
			what =
				v.code === 'unknown-type'
					? `type ${f?.type ?? ''} is unknown to this engine${types}`
					: `type ${f?.type ?? ''} is not allowed${types}`;
			break;
		}
		case 'out-of-range':
		case 'off-grid':
		case 'not-in-set':
		case 'locked': {
			const field = v.field as 'freq' | 'q' | 'gain' | 'preamp';
			const shown = field === 'preamp' ? '' : value(field);
			const problem = {
				'out-of-range': 'is out of range',
				'off-grid': 'is off the grid',
				'not-in-set': 'is not one of the listed values',
				locked: 'is fixed to another value'
			}[v.code];
			what = `${field}${shown} ${problem}${allowed(field)}`;
			break;
		}
		case 'too-many-bands':
			what = 'no slot left for this filter';
			break;
		case 'rule-violated':
			what = `breaks the ${v.rule} rule`;
			break;
		case 'unknown-rule':
			what = `rule "${v.rule}" is unknown to this app, so it can't be checked`;
			break;
	}
	const sentence = where ? `${where}: ${what}` : what;
	return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
