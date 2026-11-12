import { describe, expect, it } from 'vitest';
import type { AuthoringProfile } from '@potatosalad775/eqcaps-core';
import {
	CATALOG_REF,
	applyToProfile,
	diffProducts,
	formatDiff,
	groupMatch,
	parseCatalog,
	serializeCatalog,
	type Catalog,
	type CatalogProduct
} from './walkplay-catalog.ts';

function product(over: Partial<CatalogProduct> = {}): CatalogProduct {
	return {
		vendorId: '0x3302',
		productId: '0x12c1',
		scheme: '11',
		brand: 'Walk Play',
		model: 'WP01 - Q',
		title: 'USB DSP Audio',
		updated: '2024-12-18',
		...over
	};
}

function catalog(over: Partial<Catalog> = {}): Catalog {
	return {
		source: 'https://example.test/product',
		fetched: '2026-11-12',
		extra: [],
		products: [],
		...over
	};
}

describe('serializeCatalog', () => {
	const full = catalog({
		extra: [
			{ scheme: '10', vendorId: ['0x0a12', '0x2972'], productId: ['0x0104'], note: 'a: b, c' }
		],
		products: [product(), product({ productId: '0x12c2', model: 'say "hi"' })]
	});

	it('writes one row per line and round-trips', () => {
		const out = serializeCatalog(full);
		expect(out).toBe(
			[
				'{',
				'\t"source": "https://example.test/product",',
				'\t"fetched": "2026-11-12",',
				'\t"extra": [',
				'\t\t{ "scheme": "10", "vendorId": ["0x0a12", "0x2972"], "productId": ["0x0104"], "note": "a: b, c" }',
				'\t],',
				'\t"products": [',
				'\t\t{ "vendorId": "0x3302", "productId": "0x12c1", "scheme": "11", "brand": "Walk Play", "model": "WP01 - Q", "title": "USB DSP Audio", "updated": "2024-12-18" },',
				'\t\t{ "vendorId": "0x3302", "productId": "0x12c2", "scheme": "11", "brand": "Walk Play", "model": "say \\"hi\\"", "title": "USB DSP Audio", "updated": "2024-12-18" }',
				'\t]',
				'}',
				''
			].join('\n')
		);
		expect(JSON.parse(out)).toEqual(full);
		expect(parseCatalog(out)).toEqual(full);
	});

	it('writes empty lists as []', () => {
		const out = serializeCatalog(catalog());
		expect(out).toContain('"extra": [],');
		expect(out).toContain('"products": []\n}');
		expect(out.endsWith('}\n')).toBe(true);
		expect(JSON.parse(out)).toEqual(catalog());
	});
});

describe('groupMatch', () => {
	const products = [
		product({ vendorId: '0x3302', productId: '0x12c2' }),
		product({ vendorId: '0x3302', productId: '0x12c1' }),
		product({ vendorId: '0x3302', productId: '0x12c1', model: 'duplicate' }),
		product({ vendorId: '0x0104', productId: '0x0880' }),
		product({ vendorId: '0x3302', productId: '0xeeee' }),
		product({ vendorId: '0x3302', productId: '0x43h1' }),
		product({ vendorId: '0x33', productId: '0x0001' }),
		product({ scheme: '13', vendorId: '0x1111', productId: '0x2222' })
	];

	it('groups by vendor, sorted, one id as a plain string, skipping junk', () => {
		expect(groupMatch(catalog({ products }), '11')).toEqual([
			{ vendorId: '0x0104', productId: '0x0880' },
			{ vendorId: '0x3302', productId: ['0x12c1', '0x12c2'] }
		]);
		expect(groupMatch(catalog({ products }), '13')).toEqual([
			{ vendorId: '0x1111', productId: '0x2222' }
		]);
		expect(groupMatch(catalog({ products }), '99')).toEqual([]);
	});

	it('appends the extra entries of the scheme, collapsed and sorted', () => {
		const extra = [
			{ scheme: '11', vendorId: ['0x2972', '0x0a12'], productId: ['0x0104'], note: 'n' },
			{ scheme: '13', vendorId: ['0x9999'], productId: ['0x0002', '0x0001'] },
			{ scheme: '11', vendorId: ['0x5555'], productId: ['0x0003'] }
		];
		expect(groupMatch(catalog({ products, extra }), '11')).toEqual([
			{ vendorId: '0x0104', productId: '0x0880' },
			{ vendorId: '0x3302', productId: ['0x12c1', '0x12c2'] },
			{ vendorId: ['0x0a12', '0x2972'], productId: '0x0104' },
			{ vendorId: '0x5555', productId: '0x0003' }
		]);
	});
});

describe('diffProducts', () => {
	const a = product({ productId: '0x0001' });
	const b = product({ productId: '0x0002' });
	const c = product({ productId: '0x0003' });
	const d = product({ productId: '0x0004' });

	it('reports nothing for equal lists', () => {
		expect(diffProducts([a, b], [b, a])).toEqual({
			added: [],
			removed: [],
			schemeChanged: [],
			renamed: []
		});
	});

	it('reports added, removed, scheme changes and renames', () => {
		const moved = { ...b, scheme: '13' };
		const renamed = { ...c, model: 'New name' };
		const diff = diffProducts([a, b, c], [moved, renamed, d]);
		expect(diff.added).toEqual([d]);
		expect(diff.removed).toEqual([a]);
		expect(diff.schemeChanged).toEqual([{ before: b, after: moved }]);
		expect(diff.renamed).toEqual([{ before: c, after: renamed }]);
	});
});

describe('formatDiff', () => {
	const a = product({ productId: '0x0001' });
	const b = product({ productId: '0x0002' });
	const c = product({ productId: '0x0003' });
	const d = product({ productId: '0x0004' });

	it('says so when nothing changed', () => {
		expect(formatDiff(diffProducts([a], [a]))).toEqual(['no changes']);
	});

	it('lists each change, then a count line', () => {
		const moved = { ...b, scheme: '13' };
		const renamed = { ...c, model: 'New name' };
		expect(formatDiff(diffProducts([a, b, c], [moved, renamed, d]))).toEqual([
			'  added    0x3302:0x0004 scheme 11: Walk Play WP01 - Q (USB DSP Audio)',
			'  removed  0x3302:0x0001 scheme 11: Walk Play WP01 - Q (USB DSP Audio)',
			'  scheme   0x3302:0x0002: 11 -> 13',
			'  renamed  0x3302:0x0003: Walk Play WP01 - Q (USB DSP Audio) -> Walk Play New name (USB DSP Audio)',
			'1 added, 1 removed, 1 scheme changes, 1 renamed'
		]);
	});
});

describe('applyToProfile', () => {
	const profile = {
		id: 'walkplay-schemeno11-devices',
		extends: 'base',
		device: { brand: 'Walkplay', model: 'SchemeNo11 devices', group: true },
		match: { usb: [{ vendorId: '0x0001', productId: '0x0002' }] },
		meta: {
			status: 'draft',
			notes: 'kept',
			sources: [{ kind: 'handler-code', ref: 'https://example.test/handler', date: '2026-10-02' }]
		}
	} as AuthoringProfile;
	const cat = catalog({ products: [product()] });

	it('replaces match.usb and puts the catalog source first', () => {
		const out = applyToProfile(profile, cat, '11');
		expect(out.match?.usb).toEqual([{ vendorId: '0x3302', productId: '0x12c1' }]);
		expect(out.meta?.sources).toEqual([
			{ kind: 'vendor-app', ref: CATALOG_REF, date: '2026-11-12' },
			{ kind: 'handler-code', ref: 'https://example.test/handler', date: '2026-10-02' }
		]);
	});

	it('does not duplicate the source on a second apply, and refreshes its date', () => {
		const once = applyToProfile(profile, cat, '11');
		const twice = applyToProfile(once, { ...cat, fetched: '2027-01-01' }, '11');
		expect(twice.meta?.sources).toHaveLength(2);
		expect(twice.meta?.sources[0]).toEqual({
			kind: 'vendor-app',
			ref: CATALOG_REF,
			date: '2027-01-01'
		});
		expect(applyToProfile(once, cat, '11')).toEqual(once);
	});

	it('leaves every other field alone and does not mutate the input', () => {
		const before = structuredClone(profile);
		const out = applyToProfile(profile, cat, '11');
		expect(out.id).toBe(profile.id);
		expect(out.extends).toBe('base');
		expect(out.device).toEqual(profile.device);
		expect(out.meta?.status).toBe('draft');
		expect(out.meta?.notes).toBe('kept');
		expect(profile).toEqual(before);
	});
});
