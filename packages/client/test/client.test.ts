import { describe, expect, it } from 'vitest';
import type { DataBundle, DataIndex, IndexEntry, Profile } from '@potatosalad775/eqcaps-core';
import { webStorageStore } from '../src/cache.ts';
import { createClient, type FetchLike } from '../src/client.ts';
import { matchDevice, usbId } from '../src/match.ts';

const entry = (id: string, match: IndexEntry['match'], extra: Partial<IndexEntry> = {}) =>
	({
		id,
		kind: 'hardware',
		brand: 'Acme',
		model: id,
		status: 'draft',
		match,
		path: `profiles/${id}.json`,
		sha256: `sha-${id}`,
		bytes: 1,
		...extra
	}) as IndexEntry;

describe('matchDevice', () => {
	const entries = [
		entry('by-name', { usb: [{ vendorId: '0x2972', productName: 'FIIO FX17 ' }] }),
		entry('by-pid', { usb: [{ vendorId: '0x2972', productId: '0x0047' }] }),
		entry('by-both', { usb: [{ vendorId: '0x2972', productId: '0x0047', productName: 'X' }] }),
		entry('old', { usb: [{ vendorId: '0x2972', productId: '0x0047' }] }, { status: 'deprecated' }),
		entry('fw2', { usb: [{ vendorId: '0x0001', productId: '0x0002' }], firmware: { min: '2.0' } }),
		entry('fw1', { usb: [{ vendorId: '0x0001', productId: '0x0002' }], firmware: { max: '2.0' } }),
		entry('bt-name', { bluetooth: [{ name: 'EH13' }] }),
		entry('bt-prefix', {
			bluetooth: [{ namePrefix: 'EH1', serviceUuid: '00001101-0000-1000-8000-00805f9b34fb' }]
		})
	];
	const ids = (r: ReturnType<typeof matchDevice>) =>
		r.matches.map((m) => `${m.id}:${m.specificity}`);

	it('normalizes USB ids', () => {
		expect(usbId(0x2972)).toBe('0x2972');
		expect(usbId('0X47')).toBe('0x0047');
		expect(usbId(0x10000)).toBeNull();
	});

	it('ranks by specificity and skips deprecated profiles', () => {
		const r = matchDevice(entries, {
			usb: { vendorId: 0x2972, productId: 0x47, productName: 'X' }
		});
		expect(ids(r)).toEqual(['by-both:4', 'by-pid:3']);
		expect(r.best?.id).toBe('by-both');
	});

	it('compares product names exactly', () => {
		const usb = { vendorId: '0x2972', productId: '0x0001' };
		expect(ids(matchDevice(entries, { usb: { ...usb, productName: 'FIIO FX17' } }))).toEqual([]);
		expect(ids(matchDevice(entries, { usb: { ...usb, productName: 'FIIO FX17 ' } }))).toEqual([
			'by-name:3'
		]);
	});

	it('reports ties instead of picking', () => {
		const r = matchDevice(entries, { usb: { vendorId: '0x0001', productId: '0x0002' } });
		expect(r).toMatchObject({ best: null, ambiguous: true });
		expect(ids(r)).toEqual(['fw1:3', 'fw2:3']);
	});

	it('uses firmware ranges when the firmware is known', () => {
		const usb = { vendorId: '0x0001', productId: '0x0002' };
		expect(matchDevice(entries, { usb, firmware: '2.1' }).best?.id).toBe('fw2');
		expect(matchDevice(entries, { usb, firmware: '1.9.9' }).best?.id).toBe('fw1');
	});

	it('matches bluetooth names, prefixes and service UUIDs', () => {
		const uuid = '00001101-0000-1000-8000-00805F9B34FB';
		expect(
			ids(matchDevice(entries, { bluetooth: { name: 'EH13', serviceUuids: [uuid] } }))
		).toEqual(['bt-name:2', 'bt-prefix:1']);
		expect(ids(matchDevice(entries, { bluetooth: { name: 'EH13' } }))).toEqual(['bt-name:2']);
	});

	it('matches any value a field lists, at the same specificity', () => {
		const listed = [
			entry('family', {
				usb: [{ vendorId: ['0x0001', '0x0002'], productId: ['0x0010', '0x0011'] }]
			}),
			entry('names', { usb: [{ vendorId: '0x0003', productName: ['A', 'B'] }] }),
			entry('bt', { bluetooth: [{ namePrefix: ['W830', 'W820'] }, { name: ['X1', 'X2'] }] })
		];
		const usb = (vendorId: string, productId?: string, productName?: string) =>
			ids(
				matchDevice(listed, {
					usb: {
						vendorId,
						...(productId !== undefined ? { productId } : {}),
						...(productName !== undefined ? { productName } : {})
					}
				})
			);
		expect(usb('0x0002', '0x0011')).toEqual(['family:3']);
		expect(usb('0x0002', '0x0012')).toEqual([]);
		expect(usb('0x0001')).toEqual([]);
		expect(usb('0x0003', undefined, 'B')).toEqual(['names:3']);
		expect(ids(matchDevice(listed, { bluetooth: { name: 'W820NB' } }))).toEqual(['bt:1']);
		expect(ids(matchDevice(listed, { bluetooth: { name: 'X2' } }))).toEqual(['bt:2']);
	});

	it('prefers a device profile over a group profile of equal specificity', () => {
		const family = entry(
			'group',
			{ usb: [{ vendorId: ['0x0001', '0x0002'], productId: '0x0010' }] },
			{ group: true }
		);
		const device = entry('device', { usb: [{ vendorId: '0x0002', productName: 'Device' }] });
		const other = entry('other', { usb: [{ vendorId: '0x0002', productName: 'Device' }] });
		const identity = { usb: { vendorId: '0x0002', productId: '0x0010', productName: 'Device' } };

		const r = matchDevice([family, device], identity);
		expect(r.matches.map((m) => `${m.id}:${m.specificity}:${m.group}`)).toEqual([
			'device:3:false',
			'group:3:true'
		]);
		expect(r).toMatchObject({ best: { id: 'device' }, ambiguous: false });
		// Whole profiles carry the flag in device.group.
		const asProfile = { id: 'group', match: family.match!, device: { group: true } };
		expect(matchDevice([asProfile, device], identity).best?.id).toBe('device');
		// Two device profiles still tie.
		expect(matchDevice([family, device, other], identity)).toMatchObject({
			best: null,
			ambiguous: true
		});
	});
});

// --- client -----------------------------------------------------------------------------------

const profile = (id: string, gain = 12) =>
	({
		schemaVersion: '1.0',
		id,
		kind: 'hardware',
		device: { brand: 'Acme', model: id },
		match: { usb: [{ vendorId: '0x1234', productId: '0x0001' }] },
		bandCount: 1,
		band: {
			types: ['PK'],
			freq: { min: 20, max: 20000 },
			q: { min: 0.1, max: 10 },
			gain: { min: -gain, max: gain }
		},
		preamp: { mode: 'unknown' },
		meta: { status: 'draft', sources: [{ kind: 'community', ref: 't', date: '2026-10-02' }] }
	}) as unknown as Profile;

const index = (sha = 'v1'): DataIndex => ({
	schemaVersion: '1.0',
	dataVersion: '2026.10.02-abc',
	generatedAt: '2026-10-02T00:00:00Z',
	profiles: [entry('a', profile('a').match, { sha256: sha })]
});

/** A fake server: path → [body, etag]. Records every request. */
function server(files: Record<string, [unknown, string?]>) {
	const requests: string[] = [];
	let down = false;
	const fetch: FetchLike = async (url, init) => {
		const path = url.replace('https://x/', '');
		requests.push(
			`${path}${init.headers['If-None-Match'] ? ` (${init.headers['If-None-Match']})` : ''}`
		);
		if (down) throw new Error('offline');
		const file = files[path];
		const status = !file ? 404 : file[1] && file[1] === init.headers['If-None-Match'] ? 304 : 200;
		return {
			status,
			ok: status === 200,
			headers: { get: (h: string) => (h === 'ETag' ? (file?.[1] ?? null) : null) },
			text: async () => (typeof file?.[0] === 'string' ? file[0] : JSON.stringify(file?.[0]))
		};
	};
	return { fetch, requests, files, setDown: (d: boolean) => (down = d) };
}

describe('createClient', () => {
	const setup = (files: Record<string, [unknown, string?]>, extra = {}) => {
		const s = server(files);
		let t = 0;
		const errors: string[] = [];
		const client = createClient({
			baseUrl: 'https://x/',
			fetch: s.fetch,
			ttl: 100,
			now: () => t,
			onError: (_e, context) => errors.push(context),
			...extra
		});
		return { s, client, errors, tick: (ms: number) => (t += ms) };
	};

	it('caches the index for the TTL, then revalidates with its ETag', async () => {
		const { s, client, tick } = setup({ 'index.json': [index(), '"e1"'] });
		expect((await client.loadIndex())?.profiles[0]?.id).toBe('a');
		await client.loadIndex();
		expect(s.requests).toEqual(['index.json']);
		tick(150);
		expect(await client.loadIndex()).not.toBeNull();
		expect(s.requests).toEqual(['index.json', 'index.json ("e1")']);
	});

	it('caches profiles by the sha256 in the index', async () => {
		const { s, client, tick } = setup({
			'index.json': [index('v1')],
			'profiles/a.json': [profile('a'), '"p1"']
		});
		expect((await client.loadProfile('a'))?.id).toBe('a');
		expect((await client.loadProfile('a'))?.id).toBe('a');
		expect(s.requests).toEqual(['index.json', 'profiles/a.json']);

		s.files['index.json'] = [index('v2')];
		s.files['profiles/a.json'] = [profile('a', 6), '"p2"'];
		tick(150);
		const p = await client.loadProfile('a');
		expect(p?.band.gain).toEqual({ min: -6, max: 6 });
		expect(s.requests.slice(2)).toEqual(['index.json', 'profiles/a.json ("p1")']);
	});

	it('returns null for unknown ids without fetching them', async () => {
		const { s, client } = setup({ 'index.json': [index()] });
		expect(await client.loadProfile('nope')).toBeNull();
		expect(s.requests).toEqual(['index.json']);
	});

	it('never throws: failures yield null and go to onError', async () => {
		const { s, client, errors } = setup({ 'index.json': ['{ not json'] });
		expect(await client.loadIndex()).toBeNull();
		s.setDown(true);
		expect(await client.loadBundle()).toBeNull();
		expect((await client.matchDevice({ usb: { vendorId: 0x1234, productId: 1 } })).matches).toEqual(
			[]
		);
		expect(errors).toContain('index.json');
		expect(errors.some((e) => e.startsWith('fetch https://x/bundle.json'))).toBe(true);
	});

	it('rejects other major versions and keeps the stale cache when offline', async () => {
		const { s, client, tick } = setup({ 'index.json': [index()] });
		await client.loadIndex();
		s.setDown(true);
		tick(500);
		expect((await client.loadIndex())?.profiles).toHaveLength(1);

		const other = setup({ 'index.json': [{ ...index(), schemaVersion: '2.0' }] });
		expect(await other.client.loadIndex()).toBeNull();
	});

	it('works offline from an embedded snapshot', async () => {
		const snapshot: DataBundle = {
			schemaVersion: '1.0',
			dataVersion: 'd',
			generatedAt: 'g',
			profiles: [profile('a')]
		};
		const { s, client } = setup({}, { snapshot });
		s.setDown(true);
		expect((await client.loadIndex())?.profiles.map((e) => [e.id, e.sha256])).toEqual([['a', '']]);
		expect((await client.loadProfile('a'))?.id).toBe('a');
		expect((await client.loadBundle())?.dataVersion).toBe('d');
		const m = await client.matchDevice({ usb: { vendorId: '0x1234', productId: '0x0001' } });
		expect(m.best?.id).toBe('a');
	});

	it('persists through a web storage store', async () => {
		const map = new Map<string, string>();
		const storage = {
			getItem: (k: string) => map.get(k) ?? null,
			setItem: (k: string, v: string) => void map.set(k, v)
		};
		const first = setup({ 'index.json': [index(), '"e1"'] }, { store: webStorageStore(storage) });
		await first.client.loadIndex();
		expect([...map.keys()]).toEqual(['eqcaps:index']);
		const second = setup({ 'index.json': [index(), '"e1"'] }, { store: webStorageStore(storage) });
		await second.client.loadIndex();
		expect(second.s.requests).toEqual([]);
	});
});
