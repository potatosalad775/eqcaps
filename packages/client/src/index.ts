export { createClient, V1_URL } from './client.ts';
export type { ClientOptions, EqcapsClient, FetchLike } from './client.ts';
export { memoryStore, webStorageStore } from './cache.ts';
export type { CacheEntry, CacheStore, WebStorageLike } from './cache.ts';
export { matchDevice, usbId } from './match.ts';
export type { Candidate, DeviceIdentity, DeviceMatch, MatchResult } from './match.ts';
