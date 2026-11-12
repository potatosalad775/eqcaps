import { describe, expect, it } from 'vitest';
import type { IndexEntry } from '@potatosalad775/eqcaps-core';
import {
	connectionsOf,
	featuresOf,
	searchEntries,
	type Feature,
	type SearchFilters
} from './search.ts';
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
		match: { usb: [{ vendorId: '0x2972', productId: '0x0047' }] },
		protocol: { handler: 'fiio-usb-hid' }
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
		id: 'walkplay-family',
		brand: 'Walkplay',
		model: 'Family',
		match: {
			usb: [
				{ vendorId: ['0x0104', '0x3302'], productId: ['0x43cc', '0x4322'] },
				{ vendorId: '0x3302', productName: ['KEYX', 'Truthear KEYX'] }
			]
		},
		protocol: { handler: 'walkplay-hid' }
	}),
	entry({
		id: 'nothing-ear-2',
		brand: 'Nothing',
		model: 'Ear (2)',
		match: { bluetooth: [{ name: 'Nothing Ear (2)' }] },
		protocol: { handler: 'nothing-usb-serial' }
	}),
	entry({
		id: 'serial-dac',
		brand: 'Serial',
		model: 'DAC',
		match: { usb: [{ vendorId: '0x152a' }] },
		protocol: { handler: 'jds-labs-usb-serial' }
	}),
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
	connection: '',
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
		expect(ids({ query: 'walkplay-hid' })).toEqual(['walkplay-family']);
	});

	it('finds USB ids in any common spelling', () => {
		expect(ids({ query: '0x2972' })).toEqual(['fiio-k13-r2r']);
		expect(ids({ query: '2972:0047' })).toEqual(['fiio-k13-r2r']);
		expect(ids({ query: '2972:0048' })).toEqual([]);
	});

	it('finds every value a match field lists', () => {
		expect(ids({ query: '0104:4322' })).toEqual(['walkplay-family']);
		expect(ids({ query: '0x3302' })).toEqual(['walkplay-family']);
		expect(ids({ query: 'truthear keyx' })).toEqual(['walkplay-family']);
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

describe('connections', () => {
	it("classifies hardware by its protocol's transport and its match", () => {
		const of = (id: string) => [...connectionsOf(ENTRIES.find((e) => e.id === id)!)];
		expect(of('fiio-k13-r2r')).toEqual(['hid']);
		expect(of('serial-dac')).toEqual(['usb-serial']);
		expect(of('nothing-ear-2')).toEqual(['bluetooth']);
		expect(of('fiio-k17')).toEqual(['none']);
		expect(of('poweramp')).toEqual([]);
		const unknown = entry({
			id: 'x',
			brand: 'X',
			model: 'Y',
			match: { usb: [{ vendorId: '0x0001' }] }
		});
		expect([...connectionsOf({ ...unknown, protocol: { handler: 'from-the-future' } })]).toEqual([
			'none'
		]);
	});

	it('filters by connection', () => {
		expect(ids({ connection: 'hid' })).toEqual(['fiio-k13-r2r', 'walkplay-family']);
		expect(ids({ connection: 'bluetooth' })).toEqual(['nothing-ear-2']);
		expect(ids({ connection: 'none' })).toEqual(['fiio-k17', 'jds-labs-element-iv']);
	});
});

describe('featuresOf', () => {
	it('reads the traits of the SPEC examples', () => {
		expect([...featuresOf(example('a-edifier-w830nb'))].sort()).toContain('sets');
		expect(featuresOf(example('b-jds-labs-element-iv')).has('partitioned')).toBe(true);
		expect(featuresOf(example('d-gain-dependent-window')).has('conditional')).toBe(true);
		expect(featuresOf(example('e-graphic-10')).has('graphic')).toBe(true);
		expect(featuresOf(example('c-partitioned-windows')).has('rules')).toBe(true);
		const graphic = featuresOf(example('e-graphic-10'));
		expect(graphic.has('preamp') && graphic.has('stepped')).toBe(true);
		expect(featuresOf(example('g-equalizer-apo')).has('graphic')).toBe(false);
	});
});
