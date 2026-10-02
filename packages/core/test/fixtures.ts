import { readFileSync } from 'node:fs';
import type { Filter, Profile } from '../src/index.ts';

// Profiles for engine tests: the conformance base profile and the SPEC §12 examples.

const conformance = new URL('../../../conformance/v1/', import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, conformance), 'utf8'));

/** RFC 7386 JSON Merge Patch. */
export function mergePatch(target: unknown, patch: unknown): unknown {
	if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
	const out: Record<string, unknown> =
		target !== null && typeof target === 'object' && !Array.isArray(target)
			? { ...(target as Record<string, unknown>) }
			: {};
	for (const [k, v] of Object.entries(patch)) {
		if (v === null) delete out[k];
		else out[k] = mergePatch(out[k], v);
	}
	return out;
}

/** The conformance base profile (4 PK slots, stepped q and gain, no preamp) with a patch applied. */
export function profile(patch: object = {}): Profile {
	return mergePatch(readJson('profiles/base.json'), patch) as Profile;
}

/** A SPEC §12 example by file name, e.g. "b-jds-labs-element-iv". */
export function example(name: string): Profile {
	return readJson(`profiles/examples/${name}.json`) as Profile;
}

export const pk = (freq: number, gain: number, q = 1): Filter => ({ type: 'PK', freq, q, gain });
