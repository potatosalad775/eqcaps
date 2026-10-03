import { describe, expect, it } from 'vitest';
import type { IndexEntry } from '@potatosalad775/eqcaps-core';
import { featuresOf, searchEntries, type Feature, type SearchFilters } from './search.ts';
import { example } from './test-fixtures.ts';

const entry = (
	e: Partial<IndexEntry> & Pick<IndexEntry, 'id' | 'brand' | 'model'>
): IndexEntry => ({
	kind: 'hardware',
	status: 'draft',
	path: `profiles/${e.id}.json`,
	sha256: '',
	bytes: 0,
	...e
});

const ENTRIES = [
	entry({
		id: 'fiio-k13-r2r',
		brand: 'FiiO',
		model: 'K13 R2R',
		match: { usb: [{ vendorId: '0x2972', productId: '0x0047' }] }
	}),
	entry({ id: 'fiio-k17', brand: 'FiiO', model: 'K17', aliases: ['K17 Desktop'] }),
	entry({
		id: 'jds-labs-element-iv',
		brand: 'JDS Labs',
		model: 'Element IV',
		status: 'community-verified'
	}),
	entry({ id: 'poweramp', brand: 'Poweramp', model: 'Equalizer', kind: 'software' }),
	entry({
		id: 'old-fiio',
		brand: 'FiiO',
		model: 'Old',
		status: 'deprecated',
		replacedBy: 'fiio-k17'
	})
];

const none: SearchFilters = {
	query: '',
	status: '',
	kind: '',
	features: [],
	showDeprecated: false
};
const ids = (f: Partial<SearchFilters>, features = new Map<string, Set<Feature>>()) =>
	searchEntries(ENTRIES, features, { ...none, ...f }).map((e) => e.id);

describe('searchEntries', () => {
	it('matches every token against names, aliases and ids, best match first', () => {
		expect(ids({ query: 'fiio' })).toEqual(['fiio-k13-r2r', 'fiio-k17']);
		expect(ids({ query: 'k17' })).toEqual(['fiio-k17']);
		expect(ids({ query: 'desktop' })).toEqual(['fiio-k17']);
		expect(ids({ query: 'élément' })).toEqual(['jds-labs-element-iv']);
		expect(ids({ query: 'fiio jds' })).toEqual([]);
	});

	it('finds USB ids in any common spelling', () => {
		expect(ids({ query: '0x2972' })).toEqual(['fiio-k13-r2r']);
		expect(ids({ query: '2972:0047' })).toEqual(['fiio-k13-r2r']);
		expect(ids({ query: '2972:0048' })).toEqual([]);
	});

	it('filters by status, kind and features; hides deprecated unless asked or named', () => {
		expect(ids({ status: 'community-verified' })).toEqual(['jds-labs-element-iv']);
		expect(ids({ kind: 'software' })).toEqual(['poweramp']);
		expect(ids({ query: 'old' })).toEqual([]);
		expect(ids({ query: 'old-fiio' })).toEqual(['old-fiio']);
		expect(ids({ query: 'old', showDeprecated: true })).toEqual(['old-fiio']);
		const features = new Map([['fiio-k17', new Set<Feature>(['stepped'])]]);
		expect(ids({ features: ['stepped'] }, features)).toEqual(['fiio-k17']);
	});
});

describe('featuresOf', () => {
	it('reads the traits of the SPEC examples', () => {
		expect([...featuresOf(example('a-edifier-w830nb'))].sort()).toContain('sets');
		expect(featuresOf(example('b-jds-labs-element-iv')).has('partitioned')).toBe(true);
		expect(featuresOf(example('d-gain-dependent-window')).has('conditional')).toBe(true);
		expect(featuresOf(example('e-graphic-10')).has('graphic')).toBe(true);
		expect(featuresOf(example('c-partitioned-windows')).has('rules')).toBe(true);
		const h = featuresOf(example('h-realization-laws'));
		expect(h.has('realization') && h.has('preamp') && h.has('stepped')).toBe(true);
		expect(featuresOf(example('g-equalizer-apo')).has('graphic')).toBe(false);
	});
});
