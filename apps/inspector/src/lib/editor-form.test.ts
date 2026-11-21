import { describe, expect, it } from 'vitest';
import type { AuthoringProfile } from '@potatosalad775/eqcaps-core';
import {
	domainToForm,
	formToDomain,
	listOf,
	MANUAL_PREAMP,
	setOptional,
	withBandCount,
	withId,
	withMetaText,
	withNewSource,
	withoutSource,
	withPreampMode,
	withSourceField,
	withStatus,
	withType
} from './editor-form.ts';

describe('domain forms', () => {
	it('round-trip every domain form', () => {
		for (const d of [
			{ min: 20, max: 20000 },
			{ min: -12, max: 12, step: 0.5 },
			{ values: [31, 62, 125] },
			{ value: 1.41 }
		]) {
			expect(formToDomain(domainToForm(d))).toEqual(d);
		}
	});

	it('say what is missing', () => {
		const form = domainToForm(undefined);
		expect(form.kind).toBe('stepped');
		expect(formToDomain(form)).toBe('enter min and max');
		expect(formToDomain({ ...form, min: '1', max: '2' })).toBe('enter a step');
		expect(formToDomain({ ...form, kind: 'values', values: '1, x' })).toBe('list numbers');
		expect(formToDomain({ ...form, kind: 'values', values: '1 2,3' })).toEqual({
			values: [1, 2, 3]
		});
	});
});

describe('optional keys', () => {
	it('are removed when emptied', () => {
		const o: { a?: string; b?: string[] } = { a: 'x', b: ['y'] };
		setOptional(o, 'a', '');
		setOptional(o, 'b', listOf(' , '));
		expect(o).toEqual({});
		setOptional(o, 'b', listOf('p, q'));
		expect(o).toEqual({ b: ['p', 'q'] });
	});
});

// The form edits that carry a rule: the file in, the file out, the file given left as it was.

const file = (extra: Partial<AuthoringProfile> = {}): AuthoringProfile => ({
	id: 'acme-one',
	kind: 'hardware',
	device: { brand: 'Acme', model: 'One' },
	bandCount: 10,
	band: { types: ['PK', 'LSC'], gain: { min: -12, max: 12, step: 0.1 } },
	preamp: { mode: 'unknown' },
	meta: {
		status: 'draft',
		sources: [
			{ kind: 'community', ref: 'evidence/new-device/2026-11-22-ab12.json', date: '2026-11-22' },
			{ kind: 'vendor-docs', ref: 'https://example.com/manual', date: '2026-11-01', by: 'someone' }
		]
	},
	...extra
});
/** A file whose `meta` was deleted in the JSON pane: the form still shows for it. */
const withoutMeta = (): AuthoringProfile => {
	const { meta: _meta, ...rest } = file();
	return rest as AuthoringProfile;
};

describe('an edit', () => {
	it('leaves the file it was given untouched', () => {
		const before = file();
		const snapshot = structuredClone(before);
		withId(before, 'x', { ref: before.meta.sources[0]!.ref, name: 'f.json' });
		withBandCount(before, '', true);
		withType(before, 'HSC', true);
		withPreampMode(before, 'manual');
		withStatus(before, 'deprecated');
		withNewSource(before, '2026-11-22');
		withSourceField(before, 0, 'ref', 'x');
		withoutSource(before, 0);
		withMetaText(before, 'notes', 'x');
		expect(before).toEqual(snapshot);
	});
});

describe('the id', () => {
	const moving = { ref: 'evidence/new-device/2026-11-22-ab12.json', name: '2026-11-22-ab12.json' };

	it('is trimmed', () => {
		expect(withId(file(), '  acme-two ').id).toBe('acme-two');
	});

	it("takes a new device's evidence with it, and only that source", () => {
		const renamed = withId(file(), 'acme-two', moving);
		expect(renamed.meta.sources.map((s) => s.ref)).toEqual([
			'evidence/acme-two/2026-11-22-ab12.json',
			'https://example.com/manual'
		]);
		// Renamed again: found where it now is.
		const again = withId(renamed, 'acme-three', { ...moving, ref: renamed.meta.sources[0]!.ref });
		expect(again.meta.sources[0]!.ref).toBe('evidence/acme-three/2026-11-22-ab12.json');
	});

	it('keeps the evidence under new-device while the id is empty', () => {
		const start = withId(file(), 'acme-two', moving);
		const emptied = withId(start, ' ', { ...moving, ref: start.meta.sources[0]!.ref });
		expect(emptied.meta.sources[0]!.ref).toBe(moving.ref);
	});

	it('leaves the sources alone when no evidence moves: a fix of an existing profile', () => {
		expect(withId(file(), 'acme-two').meta.sources).toEqual(file().meta.sources);
		expect(withId(withoutMeta(), 'acme-two', moving)).not.toHaveProperty('meta');
	});
});

describe('the band count', () => {
	it.each([
		['12', false, 12],
		['12', true, 12],
		['7.6', false, 8],
		['', false, null],
		[' ', false, null]
	] as const)('typed %j (inherited: %s) is %j', (typed, inherited, expected) => {
		expect(withBandCount(file(), typed, inherited).bandCount).toBe(expected);
	});

	it('left empty in a file that extends another is inherited: the key goes', () => {
		expect(withBandCount(file(), '', true)).not.toHaveProperty('bandCount');
	});
});

describe('the types of every band', () => {
	it.each([
		['HSC', true, ['PK', 'LSC', 'HSC']],
		['AP', true, ['PK', 'LSC', 'AP']],
		['PK', true, ['PK', 'LSC']],
		['PK', false, ['LSC']],
		['HSC', false, ['PK', 'LSC']]
	] as const)('%s allowed: %s', (type, allowed, expected) => {
		expect(withType(file(), type, allowed).band?.types).toEqual(expected);
	});

	it("keep the format's order whatever order they are ticked in", () => {
		const ticked = (['AP', 'HSC', 'LPQ'] as const).reduce((d, t) => withType(d, t, true), file());
		expect(ticked.band?.types).toEqual(['PK', 'LSC', 'HSC', 'LPQ', 'AP']);
	});

	it("keep a vendor's own type the form has no box for", () => {
		const d = file({ band: { types: ['PK', 'x-tilt'] } });
		expect(withType(d, 'LSC', true).band?.types).toEqual(['PK', 'LSC', 'x-tilt']);
	});

	it('go when the last one is unticked, the other band fields kept', () => {
		const none = withType(withType(file(), 'PK', false), 'LSC', false);
		expect(none.band).toEqual({ gain: { min: -12, max: 12, step: 0.1 } });
		const { band: _band, ...bandless } = file();
		expect(withType(bandless, 'PK', true).band).toEqual({ types: ['PK'] });
	});
});

describe('the preamp mode', () => {
	it('manual starts with a range to correct, its own copy', () => {
		const manual = withPreampMode(file(), 'manual');
		expect(manual.preamp).toEqual({ mode: 'manual', gain: MANUAL_PREAMP });
		expect((manual.preamp as { gain: unknown }).gain).not.toBe(MANUAL_PREAMP);
	});

	it.each(['auto', 'none', 'unknown'] as const)('%s has no range', (mode) => {
		const manual = withPreampMode(file(), 'manual');
		expect(withPreampMode(manual, mode).preamp).toEqual({ mode });
	});

	it("'' is inherited: the key goes", () => {
		expect(withPreampMode(file(), '')).not.toHaveProperty('preamp');
	});
});

describe('the status', () => {
	it('only a deprecated profile names its replacement', () => {
		const deprecated = withStatus(file(), 'deprecated');
		deprecated.meta.replacedBy = 'acme-two';
		expect(withStatus(deprecated, 'deprecated').meta.replacedBy).toBe('acme-two');
		const back = withStatus(deprecated, 'draft');
		expect(back.meta).not.toHaveProperty('replacedBy');
		expect(back.meta.sources).toEqual(file().meta.sources);
	});
});

describe('sources, notes and contributors', () => {
	it('a new source is vendor documentation dated today, after the others', () => {
		expect(withNewSource(file(), '2026-11-22').meta.sources.at(-1)).toEqual({
			kind: 'vendor-docs',
			ref: '',
			date: '2026-11-22'
		});
		expect(withNewSource(file(), '2026-11-22').meta.sources).toHaveLength(3);
	});

	it.each([
		['kind', 'measurement', { kind: 'measurement' }],
		['ref', ' https://example.com/new ', { ref: 'https://example.com/new' }],
		['date', ' 2026-12-01', { date: '2026-12-01' }],
		['firmware', ' 1.4.6 ', { firmware: '1.4.6' }],
		['by', 'octocat', { by: 'octocat' }]
	] as const)("a source's %s as typed", (field, value, expected) => {
		const source = withSourceField(file(), 1, field, value as never).meta.sources[1]!;
		expect(source).toMatchObject(expected);
	});

	it("a source's firmware and handle go when emptied; its ref and date stay, empty", () => {
		expect(withSourceField(file(), 1, 'by', ' ').meta.sources[1]).not.toHaveProperty('by');
		expect(withSourceField(file(), 1, 'ref', ' ').meta.sources[1]!.ref).toBe('');
	});

	it('a source that is not there is left alone', () => {
		expect(withSourceField(file(), 9, 'ref', 'x')).toEqual(file());
	});

	it('a source is removed by its place', () => {
		expect(withoutSource(file(), 0).meta.sources.map((s) => s.kind)).toEqual(['vendor-docs']);
	});

	it('notes are trimmed, contributors listed, and each goes when emptied', () => {
		const noted = withMetaText(file(), 'notes', '  Reads back 0.1 dB steps. ');
		expect(noted.meta.notes).toBe('Reads back 0.1 dB steps.');
		expect(withMetaText(noted, 'notes', ' ').meta).not.toHaveProperty('notes');
		const credited = withMetaText(file(), 'contributors', 'octocat, , hubot');
		expect(credited.meta.contributors).toEqual(['octocat', 'hubot']);
		expect(withMetaText(credited, 'contributors', '').meta).not.toHaveProperty('contributors');
	});

	it("put a missing meta back as a draft's rather than failing", () => {
		const draft = { status: 'draft', sources: [] };
		expect(withMetaText(withoutMeta(), 'notes', 'x').meta).toEqual({ ...draft, notes: 'x' });
		expect(withMetaText(withoutMeta(), 'contributors', 'a').meta).toEqual({
			...draft,
			contributors: ['a']
		});
		expect(withStatus(withoutMeta(), 'deprecated').meta).toEqual({
			status: 'deprecated',
			sources: []
		});
		expect(withNewSource(withoutMeta(), '2026-11-22').meta.sources).toHaveLength(1);
		expect(withSourceField(withoutMeta(), 0, 'ref', 'x').meta).toEqual(draft);
		expect(withoutSource(withoutMeta(), 0).meta).toEqual(draft);
	});
});
