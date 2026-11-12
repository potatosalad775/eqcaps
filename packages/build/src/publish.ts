import { createHash } from 'node:crypto';
import {
	indexFields,
	SCHEMA_VERSION,
	type DataBundle,
	type DataIndex,
	type IndexEntry,
	type Profile
} from '@potatosalad775/eqcaps-core';

export interface PublishInput {
	/** Flat profiles that passed validation. */
	profiles: Iterable<Profile>;
	/** schema/v1/profile.schema.json */
	schema: object;
	/** Files under conformance/v1/, paths relative to it. */
	conformance: readonly Artifact[];
	/** `YYYY.MM.DD-<short git sha>` (SPEC §14). */
	dataVersion: string;
	/** ISO 8601 */
	generatedAt: string;
}

export interface Artifact {
	/** Relative to the channel directory (`/v1/`). */
	path: string;
	content: string;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The published files of one channel (SPEC §14): `profiles/<id>.json`, `index.json`,
 * `bundle.json`, `schema/profile.schema.json` and `conformance/`. Profiles are pretty-printed so
 * they read well in a browser; the index and the bundle are compact.
 */
export function publish(input: PublishInput): Artifact[] {
	const profiles = [...input.profiles].sort((a, b) => a.id.localeCompare(b.id));
	const head = {
		schemaVersion: SCHEMA_VERSION,
		dataVersion: input.dataVersion,
		generatedAt: input.generatedAt
	};
	const artifacts: Artifact[] = [];
	const entries: IndexEntry[] = [];

	for (const profile of profiles) {
		const path = `profiles/${profile.id}.json`;
		const content = `${JSON.stringify(profile, null, '\t')}\n`;
		artifacts.push({ path, content });
		entries.push({
			...indexFields(profile),
			path,
			sha256: sha256(content),
			bytes: Buffer.byteLength(content, 'utf8')
		});
	}

	const index: DataIndex = { ...head, profiles: entries };
	const bundle: DataBundle = {
		...head,
		profiles: profiles.filter((p) => p.meta.status !== 'deprecated')
	};
	artifacts.push(
		{ path: 'index.json', content: `${JSON.stringify(index)}\n` },
		{ path: 'bundle.json', content: `${JSON.stringify(bundle)}\n` },
		{
			path: 'schema/profile.schema.json',
			content: `${JSON.stringify(input.schema, null, '\t')}\n`
		},
		...input.conformance.map((f) => ({ path: `conformance/${f.path}`, content: f.content }))
	);
	return artifacts;
}

/** `2026.10.02-b7f649b` from a commit date (YYYY-MM-DD) and a short sha. */
export function dataVersion(date: string, shortSha: string): string {
	return `${date.replace(/-/g, '.')}-${shortSha}`;
}
