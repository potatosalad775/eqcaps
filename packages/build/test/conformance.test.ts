import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	checkDatabase,
	ISSUE_CODES,
	validateProfile,
	type Issue,
	type Profile
} from '@potatosalad775/eqcaps-core';
import { loadSchemas, repoRoot } from '../src/node.ts';
import { createSchemaValidator } from '../src/schema.ts';
import { validateSources } from '../src/validate.ts';

// Runs conformance/v1/profiles/ (format conformance, see its README.md).

const dir = new URL('conformance/v1/profiles/', repoRoot);
const readJson = (url: URL) => JSON.parse(readFileSync(url, 'utf8')) as unknown;
const jsonFiles = (sub: string) =>
	readdirSync(new URL(sub, dir))
		.filter((f) => f.endsWith('.json'))
		.sort();

const schema = createSchemaValidator(loadSchemas());
const base = readJson(new URL('base.json', dir));

/** RFC 7386 JSON Merge Patch. */
function mergePatch(target: unknown, patch: unknown): unknown {
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

/** Structural, then (if clean) semantic validation of one published profile. */
function checkPublished(profile: unknown): Issue[] {
	const structural = schema.published(profile);
	return structural.length > 0 ? structural : validateProfile(profile as Profile);
}

interface Case {
	description: string;
	spec: string;
	profile?: object;
	profiles?: object[];
	files?: { id: string }[];
	expect: { code: string; path: string; profileId?: string }[];
}

function runCase(c: Case): Issue[] {
	if (c.profile) return checkPublished(mergePatch(base, c.profile));
	if (c.profiles) {
		const profiles = c.profiles.map((p) => mergePatch(base, p) as Profile);
		const own = profiles.flatMap((p) => checkPublished(p));
		return own.length > 0 ? own : checkDatabase(profiles);
	}
	if (c.files) {
		const files = c.files.map((data) => ({ path: data.id, data }));
		return validateSources(files, { schema }).issues;
	}
	throw new Error('a case has profile, profiles or files');
}

const show = (issues: Issue[]) =>
	issues.map((i) => `${i.code} ${i.path}${i.profileId ? ` (${i.profileId})` : ''}: ${i.message}`);

describe('examples (SPEC §12)', () => {
	const examples = jsonFiles('examples/').map((f) => readJson(new URL(`examples/${f}`, dir)));

	it.each(jsonFiles('examples/'))('%s is valid', (f) => {
		expect(show(checkPublished(readJson(new URL(`examples/${f}`, dir))))).toEqual([]);
	});

	it('examples form a valid database together', () => {
		expect(show(checkDatabase(examples as Profile[]))).toEqual([]);
	});

	it('authoring examples flatten into valid profiles', () => {
		const files = jsonFiles('examples/source/').map((f) => ({
			path: f,
			data: readJson(new URL(`examples/source/${f}`, dir))
		}));
		const report = validateSources(files, { schema });
		expect(show(report.issues)).toEqual([]);
		expect([...report.profiles.keys()]).toEqual(['truthear-keyx']);
	});
});

describe('cases', () => {
	const cases = jsonFiles('cases/').map(
		(f) => [f, readJson(new URL(`cases/${f}`, dir)) as Case] as const
	);

	it.each(cases)('%s', (_f, c) => {
		const actual = runCase(c);
		const matches = (a: Issue, e: Case['expect'][number]) =>
			a.code === e.code &&
			a.path === e.path &&
			(e.profileId === undefined || a.profileId === e.profileId);

		for (const e of c.expect) {
			expect(
				actual.some((a) => matches(a, e)),
				`expected ${e.code} at "${e.path}"\n${show(actual).join('\n')}`
			).toBe(true);
		}
		// A case fails for exactly the reasons it lists. Ajv reports a failed oneOf with one error
		// per branch, so extra `schema` issues are tolerated when a schema failure is expected.
		const schemaExpected = c.expect.some((e) => e.code === 'schema');
		const unexpected = actual.filter(
			(a) => !c.expect.some((e) => matches(a, e)) && !(schemaExpected && a.code === 'schema')
		);
		expect(show(unexpected)).toEqual([]);
	});

	it('every issue code has a case that triggers it', () => {
		const covered = new Set(cases.flatMap(([, c]) => c.expect.map((e) => e.code)));
		const missing = Object.keys(ISSUE_CODES).filter((code) => !covered.has(code));
		expect(missing).toEqual([]);
	});
});
