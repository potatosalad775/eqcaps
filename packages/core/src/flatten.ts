import { error, type Issue } from './issues.ts';
import { overrideIndices } from './slots.ts';
import type {
	AuthoringProfile,
	AuthoringSource,
	BandOverride,
	Profile,
	Source
} from './types/schema.generated.ts';

/** `$schema` written into every published profile (SPEC §2, DECISIONS D24). */
export const PROFILE_SCHEMA_URL =
	'https://potatosalad775.github.io/eqcaps/v1/schema/profile.schema.json';

/** Longest allowed `extends` chain, counted in hops (SPEC §11). */
export const MAX_EXTENDS_DEPTH = 4;

/** Top-level keys a file never takes from its base (SPEC §11). */
const NOT_INHERITED = new Set(['$schema', 'id', 'match', 'device', 'meta', 'abstract', 'extends']);

/** Key order of published profiles: SPEC §2, then extension keys. */
const KEY_ORDER = [
	'$schema',
	'schemaVersion',
	'id',
	'kind',
	'device',
	'engine',
	'match',
	'bandCount',
	'band',
	'bands',
	'rules',
	'preamp',
	'channels',
	'protocol',
	'meta'
];

export interface FlattenResult {
	/**
	 * The published form. Not validated: run the profile schema and `validateProfile` on it. Null
	 * when the chain could not be resolved.
	 */
	profile: Profile | null;
	issues: Issue[];
}

type Resolved = AuthoringProfile & { meta: { sources: Source[] } };

/**
 * Resolves an authoring file's `extends` chain into a flat, published profile (SPEC §11).
 * `lookup` returns the authoring file with a given id (profiles and abstract bases alike).
 * Files without `extends` come out unchanged except for `$schema` and key order.
 */
export function flattenProfile(
	file: AuthoringProfile,
	lookup: (id: string) => AuthoringProfile | undefined
): FlattenResult {
	const issues: Issue[] = [];
	const resolved = resolve(file, lookup, [], issues);
	if (!resolved) return { profile: null, issues };
	const { abstract: _a, extends: _e, ...rest } = resolved;
	return {
		profile: ordered({ ...rest, $schema: PROFILE_SCHEMA_URL }) as unknown as Profile,
		issues
	};
}

function resolve(
	file: AuthoringProfile,
	lookup: (id: string) => AuthoringProfile | undefined,
	chain: string[],
	issues: Issue[]
): Resolved | null {
	const own = file as Resolved;
	if (file.extends === undefined) return own;
	const path = [...chain, file.id];
	const shown = [...path, file.extends].join(' → ');
	// Reported against the file being flattened (the head of the chain), whose `extends` leads
	// to the problem; the message names the whole chain.
	const fail = (code: Issue['code'], message: string) => {
		issues.push({ ...error(code, '/extends', message), profileId: path[0] as string });
		return null;
	};
	if (path.includes(file.extends)) return fail('extends-cycle', `extends chain loops: ${shown}`);
	if (path.length > MAX_EXTENDS_DEPTH) {
		return fail('extends-too-deep', `extends chain ${shown} is longer than ${MAX_EXTENDS_DEPTH}`);
	}
	const baseFile = lookup(file.extends);
	if (!baseFile) {
		return fail('extends-missing', `no profile or base has id "${file.extends}" (${shown})`);
	}
	const base = resolve(baseFile, lookup, path, issues);
	return base ? merge(base, own) : null;
}

const inherit = (s: Source | AuthoringSource, baseId: string): Source => ({
	...s,
	via: (s as Source).via ?? baseId
});

function merge(base: Resolved, file: Resolved): Resolved {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(base)) {
		if (!NOT_INHERITED.has(k)) out[k] = JSON.parse(JSON.stringify(v)) as unknown;
	}
	for (const [k, v] of Object.entries(file)) {
		if (k === 'extends' || k === 'abstract') continue;
		if (k === 'band' && base.band) out.band = { ...base.band, ...file.band };
		else if (k === 'protocol' && base.protocol)
			out.protocol = { ...base.protocol, ...file.protocol };
		else if (k === 'bands' && base.bands) out.bands = mergeBands(base.bands, file.bands ?? []);
		else if (k === 'schemaVersion' && base.schemaVersion) {
			out.schemaVersion = laterVersion(base.schemaVersion, file.schemaVersion as string);
		} else out[k] = v;
	}
	out.meta = {
		...file.meta,
		sources: [...file.meta.sources, ...base.meta.sources.map((s) => inherit(s, base.id))]
	};
	return out as unknown as Resolved;
}

/** "1.<minor>" with the higher minor: the flat profile needs what any file in its chain needs. */
function laterVersion(a: string, b: string): string {
	const minor = (v: string) => Number(v.split('.')[1]);
	return minor(b) >= minor(a) ? b : a;
}

/**
 * `bands` merge by index (SPEC §11): for each slot the file overrides, its keys replace the
 * base's keys for that slot (the §5.2 per-key rule). Base entries keep the slots the file
 * doesn't touch. Entries come out sorted by their first index.
 */
function mergeBands(base: BandOverride[], derived: BandOverride[]): BandOverride[] {
	const touched = new Set(derived.flatMap(overrideIndices));
	const baseFor = (i: number) => base.find((e) => overrideIndices(e).includes(i));
	const out: BandOverride[] = [];
	const withIndex = (fields: object, indices: number[], wasArray: boolean): BandOverride =>
		({
			...fields,
			index: indices.length === 1 && !wasArray ? (indices[0] as number) : indices
		}) as BandOverride;

	for (const entry of base) {
		const { index: _i, ...fields } = entry;
		const kept = overrideIndices(entry).filter((i) => !touched.has(i));
		if (kept.length > 0) out.push(withIndex(fields, kept, Array.isArray(entry.index)));
	}
	for (const entry of derived) {
		const { index: _i, ...fields } = entry;
		const groups = new Map<BandOverride | undefined, number[]>();
		for (const i of overrideIndices(entry)) {
			const b = baseFor(i);
			groups.set(b, [...(groups.get(b) ?? []), i]);
		}
		for (const [b, indices] of groups) {
			const { index: _bi, ...baseFields } = b ?? { index: 0 };
			out.push(withIndex({ ...baseFields, ...fields }, indices, Array.isArray(entry.index)));
		}
	}
	const first = (e: BandOverride) => Math.min(...overrideIndices(e));
	return out.sort((a, b) => first(a) - first(b));
}

function ordered(o: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of KEY_ORDER) if (o[k] !== undefined) out[k] = o[k];
	for (const k of Object.keys(o).sort()) if (!(k in out)) out[k] = o[k];
	return out;
}
