// The editor's form side: the common fields of an authoring file as form values, and back.
// Everything the form doesn't cover (per-slot overrides, variants, rules) is edited
// in the JSON, which stays the source of truth: the form reads it and writes it.

import {
	FILTER_TYPES,
	type AuthoringMeta,
	type AuthoringProfile,
	type AuthoringSource,
	type Domain,
	type FilterType
} from '@potatosalad775/eqcaps-core';

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

// --- Edits that carry a rule ---------------------------------------------------------------------
// Each takes the file as it is and gives it as the edit leaves it; the route's plain setters
// (`edited` with one assignment) stay in the route.

/**
 * The file's `meta`, made where there is none: the form shows for any JSON that parses, also one
 * whose `meta` was deleted by hand, and an edit of its notes or sources puts it back as a draft's.
 */
function metaOf(d: AuthoringProfile): AuthoringMeta {
	const meta = (d as { meta?: AuthoringMeta }).meta;
	if (meta) {
		meta.sources ??= [];
		return meta;
	}
	return (d.meta = { status: 'draft', sources: [] });
}

/**
 * A new id. A new device's evidence file lives under the profile's id, so the source citing it
 * (`moving`, by its ref now and its file name) follows: `evidence/<id>/<name>`, or
 * `evidence/new-device/<name>` while the id is empty.
 */
export function withId(
	data: AuthoringProfile,
	id: string,
	moving?: { ref: string; name: string }
): AuthoringProfile {
	return edited(data, (d) => {
		d.id = id.trim();
		if (!moving) return;
		for (const source of d.meta?.sources ?? []) {
			if (source.ref === moving.ref) source.ref = `evidence/${d.id || 'new-device'}/${moving.name}`;
		}
	});
}

/**
 * The band count as typed. Left empty, a file that extends another inherits it (the key goes),
 * and a complete one has none: `null`, unbounded (SPEC §2). A fraction is rounded.
 */
export function withBandCount(
	data: AuthoringProfile,
	typed: string,
	inherited: boolean
): AuthoringProfile {
	return edited(data, (d) => {
		if (typed.trim() !== '') d.bandCount = Math.round(Number(typed));
		else if (inherited) delete d.bandCount;
		else d.bandCount = null;
	});
}

/** A filter type allowed or not in every band, the list kept in the format's order (D22). */
export function withType(
	data: AuthoringProfile,
	type: FilterType,
	allowed: boolean
): AuthoringProfile {
	return edited(data, (d) => {
		const types = new Set<FilterType>(d.band?.types ?? []);
		if (allowed) types.add(type);
		else types.delete(type);
		const rest = [...types].filter((t) => !FILTER_TYPES.includes(t as never));
		d.band = { ...d.band };
		setOptional(d.band, 'types', [...FILTER_TYPES.filter((t) => types.has(t)), ...rest]);
	});
}

/** The preamp range a `manual` preamp starts with, for the contributor to correct. */
export const MANUAL_PREAMP: Domain = { min: -12, max: 0, step: 0.1 };

/**
 * The preamp mode. `manual` starts with a range to correct; the others have none; '' is "as the
 * profile this one extends says" (the key goes).
 */
export function withPreampMode(
	data: AuthoringProfile,
	mode: '' | 'manual' | 'auto' | 'none' | 'unknown'
): AuthoringProfile {
	return edited(data, (d) => {
		if (mode === '') delete d.preamp;
		else if (mode === 'manual') d.preamp = { mode, gain: { ...MANUAL_PREAMP } };
		else d.preamp = { mode };
	});
}

/** The status. Only a deprecated profile names its replacement (SPEC §10): another loses it. */
export function withStatus(
	data: AuthoringProfile,
	status: AuthoringMeta['status']
): AuthoringProfile {
	return edited(data, (d) => {
		const meta = metaOf(d);
		meta.status = status;
		if (status !== 'deprecated') delete meta.replacedBy;
	});
}

/** One more source to fill in: vendor documentation, dated today. */
export function withNewSource(data: AuthoringProfile, date: string): AuthoringProfile {
	return edited(data, (d) => {
		metaOf(d).sources.push({ kind: 'vendor-docs', ref: '', date });
	});
}

/** A source's field as typed; `firmware` and `by` go when emptied. A source that isn't there is left alone. */
export function withSourceField<K extends 'kind' | 'ref' | 'date' | 'firmware' | 'by'>(
	data: AuthoringProfile,
	index: number,
	field: K,
	value: K extends 'kind' ? AuthoringSource['kind'] : string
): AuthoringProfile {
	return edited(data, (d) => {
		const source = metaOf(d).sources[index];
		if (!source) return;
		const text = value.trim();
		if (field === 'kind') source.kind = value as AuthoringSource['kind'];
		else if (field === 'firmware') setOptional(source, 'firmware', text);
		else if (field === 'by') setOptional(source, 'by', text);
		else if (field === 'ref') source.ref = text;
		else source.date = text;
	});
}

export function withoutSource(data: AuthoringProfile, index: number): AuthoringProfile {
	return edited(data, (d) => {
		metaOf(d).sources.splice(index, 1);
	});
}

/** The notes, or the contributors as a comma-separated list; the key goes when emptied. */
export function withMetaText(
	data: AuthoringProfile,
	field: 'notes' | 'contributors',
	text: string
): AuthoringProfile {
	return edited(data, (d) => {
		if (field === 'notes') setOptional(metaOf(d), 'notes', text.trim());
		else setOptional(metaOf(d), 'contributors', listOf(text));
	});
}
