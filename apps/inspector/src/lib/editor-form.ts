// The editor's form side: the common fields of an authoring file as form values, and back.
// Everything the form doesn't cover (per-slot overrides, variants, rules) is edited
// in the JSON, which stays the source of truth: the form reads it and writes it.

import type { AuthoringProfile, Domain } from '@potatosalad775/eqcaps-core';

export type DomainKind = 'range' | 'stepped' | 'values' | 'locked';

export interface DomainForm {
	kind: DomainKind;
	min: string;
	max: string;
	step: string;
	/** Comma-separated, for `values`. */
	values: string;
	value: string;
}

const str = (n: number | undefined) => (n === undefined ? '' : String(n));

export function domainToForm(d: Domain | undefined): DomainForm {
	const form: DomainForm = { kind: 'stepped', min: '', max: '', step: '', values: '', value: '' };
	if (!d) return form;
	if ('values' in d) return { ...form, kind: 'values', values: d.values.join(', ') };
	if ('value' in d) return { ...form, kind: 'locked', value: str(d.value) };
	if ('step' in d)
		return { ...form, kind: 'stepped', min: str(d.min), max: str(d.max), step: str(d.step) };
	return { ...form, kind: 'range', min: str(d.min), max: str(d.max) };
}

const num = (s: string): number | null => {
	if (s.trim() === '') return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
};

/**
 * The domain the form describes, or a message saying what is missing. Whether the domain is
 * sound (on its grid, ascending) is left to validation, which explains it in the format's terms.
 */
export function formToDomain(f: DomainForm): Domain | string {
	switch (f.kind) {
		case 'values': {
			const parts = f.values.split(/[\s,]+/).filter(Boolean);
			const values = parts.map(num);
			if (values.length === 0 || values.some((v) => v === null)) return 'list numbers';
			return { values: values as number[] };
		}
		case 'locked': {
			const value = num(f.value);
			return value === null ? 'enter a value' : { value };
		}
		default: {
			const min = num(f.min);
			const max = num(f.max);
			if (min === null || max === null) return 'enter min and max';
			if (f.kind === 'range') return { min, max };
			const step = num(f.step);
			return step === null ? 'enter a step' : { min, max, step };
		}
	}
}

/** Comma- or space-separated text as a list of strings, empties dropped. */
export function listOf(text: string): string[] {
	return text
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * A copy of `data` with `edit` applied. Empty strings and empty lists remove optional keys, so
 * the file stays as small as the form allows.
 */
export function edited(
	data: AuthoringProfile,
	edit: (d: AuthoringProfile) => void
): AuthoringProfile {
	const copy = structuredClone(data);
	edit(copy);
	return copy;
}

/** Sets or removes (when `value` is '' / undefined / an empty array) a key of an object. */
export function setOptional<T extends object, K extends keyof T>(
	target: T,
	key: K,
	value: T[K] | '' | undefined
): void {
	if (value === '' || value === undefined || (Array.isArray(value) && value.length === 0)) {
		delete target[key];
	} else {
		target[key] = value as T[K];
	}
}
