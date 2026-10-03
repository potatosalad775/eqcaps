import {
	indexFields,
	type DataBundle,
	type DataIndex,
	type IndexEntry,
	type Profile
} from '@potatosalad775/eqcaps-core';
import { memoryStore, type CacheEntry, type CacheStore } from './cache.ts';
import { matchDevice, type DeviceIdentity, type MatchResult } from './match.ts';

/** The format's channel (SPEC §14), the default. */
export const V1_URL = 'https://potatosalad775.github.io/eqcaps/v1/';

/** The subset of `fetch` the client uses. */
export type FetchLike = (
	url: string,
	init: { headers: Record<string, string> }
) => Promise<{
	status: number;
	ok: boolean;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
}>;

export interface ClientOptions {
	/** Channel URL, ending in `/`. Default V1_URL. */
	baseUrl?: string;
	/** Default `globalThis.fetch`. */
	fetch?: FetchLike;
	/** Default an in-memory store. Use webStorageStore(localStorage) to persist. */
	store?: CacheStore;
	/** How long index.json and bundle.json count as fresh, in ms. Default 24 h. */
	ttl?: number;
	/** Per request, in ms. Default 10 s. */
	timeout?: number;
	/**
	 * An embedded bundle.json, used when neither the network nor the cache has an answer, so the
	 * app works offline and without the CDN (invariant 8).
	 */
	snapshot?: DataBundle;
	/** Every failure is reported here and nowhere else; the client never throws. */
	onError?: (error: unknown, context: string) => void;
	/** Clock, for tests. */
	now?: () => number;
}

export interface EqcapsClient {
	/**
	 * index.json, from cache while fresh, revalidated with its ETag after. Falls back to a stale
	 * cache, then to an index derived from the snapshot (its entries have `sha256: ''`), then null.
	 */
	loadIndex(): Promise<DataIndex | null>;
	/** One flat profile, cached by its index sha256. Null when unavailable. */
	loadProfile(id: string): Promise<Profile | null>;
	/** bundle.json, cached like the index. Falls back to the snapshot, then null. */
	loadBundle(): Promise<DataBundle | null>;
	/** matchDevice over the index (SPEC §3). No matches when nothing could be loaded. */
	matchDevice(identity: DeviceIdentity): Promise<MatchResult<IndexEntry>>;
}

type Platform = {
	fetch?: FetchLike;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lenient check (SPEC §15): major version 1 and the fields a consumer relies on. */
const supported = (v: unknown) => typeof v === 'string' && /^1\.\d+$/.test(v);

function readIndex(v: unknown): DataIndex | null {
	if (!isObject(v) || !supported(v.schemaVersion) || !Array.isArray(v.profiles)) return null;
	const profiles = v.profiles.filter(
		(e): e is IndexEntry => isObject(e) && typeof e.id === 'string' && typeof e.path === 'string'
	);
	return { ...(v as unknown as DataIndex), profiles };
}

function readProfile(v: unknown): Profile | null {
	if (
		!isObject(v) ||
		!supported(v.schemaVersion) ||
		typeof v.id !== 'string' ||
		!isObject(v.band) ||
		!isObject(v.device) ||
		!isObject(v.meta) ||
		!(v.bandCount === null || typeof v.bandCount === 'number')
	) {
		return null;
	}
	return v as unknown as Profile;
}

function readBundle(v: unknown): DataBundle | null {
	if (!isObject(v) || !supported(v.schemaVersion) || !Array.isArray(v.profiles)) return null;
	const profiles = v.profiles.map(readProfile).filter((p): p is Profile => p !== null);
	return { ...(v as unknown as DataBundle), profiles };
}

/** An index for a bundle, so lookups and matching work offline. */
function indexOfBundle(bundle: DataBundle): DataIndex {
	return {
		schemaVersion: bundle.schemaVersion,
		dataVersion: bundle.dataVersion,
		generatedAt: bundle.generatedAt,
		profiles: bundle.profiles.map((p) => ({
			...indexFields(p),
			path: `profiles/${p.id}.json`,
			sha256: '',
			bytes: 0
		}))
	};
}

export function createClient(options: ClientOptions = {}): EqcapsClient {
	const platform = globalThis as Platform;
	const baseUrl = options.baseUrl ?? V1_URL;
	const doFetch = options.fetch ?? platform.fetch?.bind(globalThis);
	const store = options.store ?? memoryStore();
	const ttl = options.ttl ?? 24 * 60 * 60 * 1000;
	const timeout = options.timeout ?? 10_000;
	const now = options.now ?? (() => Date.now());
	const report = (error: unknown, context: string) => {
		try {
			options.onError?.(error, context);
		} catch {
			// A throwing error handler must not break the host either.
		}
	};

	const cacheGet = async (key: string): Promise<CacheEntry | undefined> => {
		try {
			return await store.get(key);
		} catch (e) {
			report(e, `cache read ${key}`);
			return undefined;
		}
	};
	const cacheSet = async (key: string, entry: CacheEntry) => {
		try {
			await store.set(key, entry);
		} catch (e) {
			report(e, `cache write ${key}`);
		}
	};
	const parse = <T>(body: string, read: (v: unknown) => T | null, what: string): T | null => {
		try {
			const value = read(JSON.parse(body));
			if (value === null) report(new Error(`${what}: unsupported or malformed`), what);
			return value;
		} catch (e) {
			report(e, what);
			return null;
		}
	};

	/** GET with If-None-Match. `null` body means 304. Undefined on any failure. */
	const get = async (path: string, etag?: string) => {
		if (!doFetch) {
			report(new Error('no fetch available'), path);
			return undefined;
		}
		let timer: unknown;
		try {
			const timedOut = new Promise<never>((_, reject) => {
				timer = platform.setTimeout?.(
					() => reject(new Error(`timed out after ${timeout} ms`)),
					timeout
				);
			});
			const res = await Promise.race([
				doFetch(baseUrl + path, { headers: etag ? { 'If-None-Match': etag } : {} }),
				timedOut
			]);
			if (res.status === 304) return { body: null, etag };
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await Promise.race([res.text(), timedOut]);
			return { body, etag: res.headers.get('ETag') ?? undefined };
		} catch (e) {
			report(e, `fetch ${baseUrl}${path}`);
			return undefined;
		} finally {
			platform.clearTimeout?.(timer);
		}
	};

	/** TTL + ETag revalidation for index.json and bundle.json. */
	const loadDocument = async <T>(
		key: string,
		path: string,
		read: (v: unknown) => T | null
	): Promise<T | null> => {
		const cached = await cacheGet(key);
		if (cached && now() - cached.fetchedAt < ttl) {
			const value = parse(cached.body, read, path);
			if (value) return value;
		}
		const res = await get(path, cached?.etag);
		if (res?.body === null && cached) {
			await cacheSet(key, { ...cached, fetchedAt: now() });
			return parse(cached.body, read, path);
		}
		if (res?.body) {
			const value = parse(res.body, read, path);
			if (value) {
				const entry: CacheEntry = { body: res.body, fetchedAt: now() };
				if (res.etag) entry.etag = res.etag;
				await cacheSet(key, entry);
				return value;
			}
		}
		return cached ? parse(cached.body, read, path) : null;
	};

	const inFlight = new Map<string, Promise<unknown>>();
	const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
		let p = inFlight.get(key) as Promise<T> | undefined;
		if (!p) {
			p = load().finally(() => inFlight.delete(key));
			inFlight.set(key, p);
		}
		return p;
	};

	const loadIndex = () =>
		once('index', async () => {
			const index = await loadDocument('index', 'index.json', readIndex);
			return index ?? (options.snapshot ? indexOfBundle(options.snapshot) : null);
		});

	const loadBundle = () =>
		once('bundle', async () => {
			const bundle = await loadDocument('bundle', 'bundle.json', readBundle);
			return bundle ?? options.snapshot ?? null;
		});

	const fromBundles = async (id: string) => {
		const cached = await cacheGet('bundle');
		const bundle = cached ? parse(cached.body, readBundle, 'bundle.json') : null;
		return (
			bundle?.profiles.find((p) => p.id === id) ??
			options.snapshot?.profiles.find((p) => p.id === id) ??
			null
		);
	};

	const loadProfile = (id: string) =>
		once(`profile:${id}`, async (): Promise<Profile | null> => {
			const index = await loadIndex();
			const entry = index?.profiles.find((e) => e.id === id);
			if (index && !entry) return null;
			const key = `profile:${id}`;
			const path = entry?.path ?? `profiles/${encodeURIComponent(id)}.json`;
			const cached = await cacheGet(key);
			const ok = (p: Profile | null) => (p && p.id === id ? p : null);
			if (cached && entry?.sha256 && cached.sha256 === entry.sha256) {
				const p = ok(parse(cached.body, readProfile, path));
				if (p) return p;
			}
			const res = await get(path, cached?.etag);
			const body = res?.body === null ? cached?.body : res?.body;
			const profile = body === undefined ? null : ok(parse(body, readProfile, path));
			if (profile && body !== undefined) {
				const stored: CacheEntry = { body, fetchedAt: now() };
				const etag = res?.etag ?? cached?.etag;
				if (etag) stored.etag = etag;
				if (entry?.sha256) stored.sha256 = entry.sha256;
				await cacheSet(key, stored);
				return profile;
			}
			return (cached && ok(parse(cached.body, readProfile, path))) ?? (await fromBundles(id));
		});

	return {
		loadIndex,
		loadProfile,
		loadBundle,
		async matchDevice(identity) {
			const index = await loadIndex();
			try {
				return matchDevice(index?.profiles ?? [], identity);
			} catch (e) {
				report(e, 'matchDevice');
				return { matches: [], best: null, ambiguous: false };
			}
		}
	};
}
