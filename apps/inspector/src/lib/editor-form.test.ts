import { describe, expect, it } from 'vitest';
import { domainToForm, formToDomain, listOf, setOptional } from './editor-form.ts';

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
