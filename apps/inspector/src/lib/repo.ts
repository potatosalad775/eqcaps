// Where the database lives on GitHub (DECISIONS D24). Links only; the app never calls the API.

import { brandSlug } from '@potatosalad775/eqcaps-build';
import type { Profile, Source } from '@potatosalad775/eqcaps-core';

export const REPO_URL = 'https://github.com/potatosalad775/eqcaps';

/** data/profiles/<brand>/<id>.json, the authoring file (CLAUDE.md conventions). */
export function profilePath(p: Pick<Profile, 'id' | 'device'>): string {
	return `data/profiles/${brandSlug(p.device.brand)}/${p.id}.json`;
}

export function profileSourceUrl(p: Pick<Profile, 'id' | 'device'>): string {
	return `${REPO_URL}/blob/main/${profilePath(p)}`;
}

/** A source's ref as a link: URLs as they are, evidence paths into the repository (SPEC §10). */
export function sourceHref(s: Source): string | null {
	if (/^https?:\/\//.test(s.ref)) return s.ref;
	if (s.ref.startsWith('evidence/')) return `${REPO_URL}/blob/main/data/${s.ref}`;
	return null;
}
