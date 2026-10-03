// The database as the app sees it: index.json for search and identity, bundle.json for the
// profiles themselves. Both come from the same origin (/next/ on Pages, the local build in dev),
// through the client, so the cache, ETag revalidation and failure handling are the consumer's.

import {
	createClient,
	memoryStore,
	webStorageStore,
	type EqcapsClient
} from '@potatosalad775/eqcaps-client';
import type { DataBundle, DataIndex, Profile } from '@potatosalad775/eqcaps-core';
import { dataUrl } from './channel.ts';
import { featuresOf, type Feature } from './search.ts';

function storage() {
	try {
		localStorage.getItem('eqcaps:probe');
		return webStorageStore(localStorage, 'eqcaps-inspector:');
	} catch {
		return memoryStore();
	}
}

class Catalog {
	index: DataIndex | null = $state.raw(null);
	bundle: DataBundle | null = $state.raw(null);
	loading = $state(false);
	errors: string[] = $state([]);

	/** Profiles by id, from the bundle (every non-deprecated profile). */
	profiles = $derived(new Map((this.bundle?.profiles ?? []).map((p) => [p.id, p])));
	features = $derived(
		new Map<string, Set<Feature>>(
			(this.bundle?.profiles ?? []).map((p) => {
				try {
					return [p.id, featuresOf(p)];
				} catch {
					return [p.id, new Set<Feature>()];
				}
			})
		)
	);

	#client: EqcapsClient | null = null;
	#started: Promise<void> | null = null;

	get client(): EqcapsClient {
		this.#client ??= createClient({
			baseUrl: dataUrl(),
			store: storage(),
			// Contributors check their own changes here: revalidate often (an ETag request is cheap).
			ttl: 5 * 60 * 1000,
			onError: (error, context) => {
				const message = error instanceof Error ? error.message : String(error);
				this.errors = [...this.errors, `${context}: ${message}`];
			}
		});
		return this.#client;
	}

	/** Loads the index and bundle once; later calls wait for the same load. */
	load(): Promise<void> {
		this.#started ??= (async () => {
			this.loading = true;
			const [index, bundle] = await Promise.all([
				this.client.loadIndex(),
				this.client.loadBundle()
			]);
			this.index = index;
			this.bundle = bundle;
			this.loading = false;
		})();
		return this.#started;
	}

	/** A profile by id: from the bundle, or fetched (deprecated profiles are not in the bundle). */
	async profile(id: string): Promise<Profile | null> {
		await this.load();
		return this.profiles.get(id) ?? (await this.client.loadProfile(id));
	}
}

export const catalog = new Catalog();
