/** A cached response. */
export interface CacheEntry {
	body: string;
	etag?: string;
	/** Epoch ms of the last time the server confirmed this body (200 or 304). */
	fetchedAt: number;
	/** For profiles: the index sha256 this body was fetched under. */
	sha256?: string;
}

/**
 * Where the client keeps responses between sessions. Sync or async; failures are caught and
 * treated as a cache miss, so a full or broken store never breaks the host app.
 */
export interface CacheStore {
	get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
	set(key: string, entry: CacheEntry): void | Promise<void>;
}

/** In-memory store, the default. Lives as long as the client. */
export function memoryStore(): CacheStore {
	const map = new Map<string, CacheEntry>();
	return {
		get: (key) => map.get(key),
		set: (key, entry) => void map.set(key, entry)
	};
}

/** The part of the Web Storage API the client needs (localStorage, sessionStorage). */
export interface WebStorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** A store on top of localStorage or anything shaped like it. Keys are prefixed. */
export function webStorageStore(storage: WebStorageLike, prefix = 'eqcaps:'): CacheStore {
	return {
		get(key) {
			const raw = storage.getItem(prefix + key);
			return raw === null ? undefined : (JSON.parse(raw) as CacheEntry);
		},
		set(key, entry) {
			storage.setItem(prefix + key, JSON.stringify(entry));
		}
	};
}
