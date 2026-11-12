// Authoring files: what the editor (T4) edits. They live in the repository's data/, may use
// `extends` and `abstract` (SPEC §11), and are never published, so the editor reads them from
// the repository itself (sourcesUrl), not from the data channel.

import { brandSlug, type DataFile } from '@potatosalad775/eqcaps-build';
import {
	MAX_EXTENDS_DEPTH,
	type AuthoringProfile,
	type IndexEntry,
	type Profile
} from '@potatosalad775/eqcaps-core';

/** Repository path of an authoring file: data/bases/<id>.json or data/profiles/<brand>/<id>.json. */
export function authoringPath(
	p: Pick<AuthoringProfile, 'id' | 'abstract'> & { device?: { brand?: string } }
): string {
	if (p.abstract) return `data/bases/${p.id}.json`;
	return `data/profiles/${brandSlug(p.device?.brand ?? '') || '_'}/${p.id}.json`;
}

/**
 * Where the file an `extends` id names lives: a published profile's own path (from the index), or
 * a base. Bases are never published, so any id the index doesn't know is looked for in data/bases/.
 */
export function extendsPath(id: string, entries: readonly IndexEntry[]): string {
	const entry = entries.find((e) => e.id === id);
	return entry ? authoringPath({ id, device: { brand: entry.brand } }) : `data/bases/${id}.json`;
}

/**
 * The ids of the bases the database's profiles extend. Bases are not published, but a flat
 * profile carries its inherited sources marked `via` the file that declared them (SPEC §11).
 */
export function baseIds(profiles: readonly Profile[]): string[] {
	const ids = new Set(profiles.map((p) => p.id));
	const bases = new Set<string>();
	for (const p of profiles) {
		for (const s of p.meta.sources) {
			if (s.via !== undefined && !ids.has(s.via)) bases.add(s.via);
		}
	}
	return [...bases].sort();
}

/** Reads a repository-relative path such as data/bases/x.json; null when it doesn't exist. */
export type ReadFile = (path: string) => Promise<string | null>;

/** A ReadFile over HTTP, `root` being the URL of data/ (sourcesUrl). */
export function httpReader(root: string, fetcher: typeof fetch = fetch): ReadFile {
	return async (path) => {
		const url = new URL(path.replace(/^data\//, ''), root);
		const response = await fetcher(url, { cache: 'no-cache' });
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
		return response.text();
	};
}

/**
 * The files `data` extends, nearest first, as far as they can be read. Stops at a cycle, at
 * the depth limit, or at a file that is missing or not JSON: validation then reports the
 * broken link where it is.
 */
export async function loadChain(
	data: unknown,
	entries: readonly IndexEntry[],
	read: ReadFile
): Promise<DataFile[]> {
	const chain: DataFile[] = [];
	const seen = new Set<string>();
	let next = extendsOf(data);
	while (next !== undefined && !seen.has(next) && chain.length <= MAX_EXTENDS_DEPTH) {
		seen.add(next);
		const path = extendsPath(next, entries);
		const text = await read(path);
		if (text === null) break;
		chain.push({ path, text });
		try {
			next = extendsOf(JSON.parse(text));
		} catch {
			break;
		}
	}
	return chain;
}

function extendsOf(data: unknown): string | undefined {
	const e = (data as { extends?: unknown } | null)?.extends;
	return typeof e === 'string' ? e : undefined;
}
