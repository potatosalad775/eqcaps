import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	near,
	project,
	projectType,
	resolveSlot,
	validate,
	type Domain,
	type Filter,
	type FilterType,
	type Profile,
	type ViolationCode
} from '../src/index.ts';
import { checkAssign, checkComplete, checkFit } from './checks.ts';
import { complete } from '../src/complete.ts';
import { fit } from '../src/fit.ts';
import { mergePatch } from './fixtures.ts';

// Runs the engine conformance vectors conformance/v1/<op>.json (SPEC §13.8, see its README.md).

const dir = new URL('../../../conformance/v1/', import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, dir), 'utf8')) as unknown;

interface Vector {
	description: string;
	profile?: string | { $base?: string };
	op: string;
	input: Record<string, unknown>;
	expect: unknown;
}

function resolveProfile(ref: Vector['profile']): Profile {
	if (typeof ref === 'string') return readJson(`profiles/${ref}.json`) as Profile;
	const { $base = 'base', ...patch } = ref ?? {};
	return mergePatch(readJson(`profiles/${$base}.json`), patch) as Profile;
}

/** JSON has no NaN or infinities: vectors spell them as strings. */
const number = (x: unknown) => (typeof x === 'string' ? Number(x) : (x as number));

/** Equal within ε for numbers, exactly otherwise; object keys must match. */
function matches(actual: unknown, expected: unknown): boolean {
	if (typeof expected === 'number') return typeof actual === 'number' && near(actual, expected);
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			actual.length === expected.length &&
			expected.every((e, i) => matches(actual[i], e))
		);
	}
	if (expected !== null && typeof expected === 'object') {
		if (actual === null || typeof actual !== 'object') return false;
		const a = actual as Record<string, unknown>;
		const e = expected as Record<string, unknown>;
		const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
		return [...keys].every((k) => matches(a[k], e[k]));
	}
	return actual === expected;
}

const EXACT = ['project', 'resolveSlot', 'validate'] as const;
const PROPERTY = ['assign', 'fit', 'complete'] as const;

function runExact(v: Vector): unknown {
	const i = v.input;
	if (v.op === 'project') {
		return i['field'] === 'type'
			? projectType(i['value'] as FilterType, i['domain'] as FilterType[])
			: project(number(i['value']), i['domain'] as Domain, i['field'] as 'freq');
	}
	const p = resolveProfile(v.profile);
	if (v.op === 'resolveSlot') {
		const filter = i['filter'] as Filter | undefined;
		return filter
			? resolveSlot(p, i['slot'] as number, filter)
			: resolveSlot(p, i['slot'] as number);
	}
	return validate(p, i['slots'] as (Filter | null)[], i['preamp'] as number | undefined);
}

function runProperty(v: Vector): void {
	const p = resolveProfile(v.profile);
	const i = v.input;
	if (v.op === 'assign') {
		checkAssign(p, i['filters'] as Filter[], (v.expect as { valid: boolean }).valid);
	} else if (v.op === 'fit') {
		const filters = i['filters'] as Filter[];
		const preamp = (i['preamp'] as number | undefined) ?? 0;
		checkFit(p, filters, preamp);
		expect(fit(p, filters, preamp).feasible).toBe((v.expect as { feasible: boolean }).feasible);
	} else {
		const slots = i['slots'] as (Filter | null)[];
		checkComplete(p, slots);
		expect(complete(p, slots).warnings).toEqual((v.expect as { warnings: unknown[] }).warnings);
	}
}

const files = readdirSync(dir)
	.filter((f) => f.endsWith('.json'))
	.sort();
const vectors = files.flatMap((file) =>
	(readJson(file) as { vectors: Vector[] }).vectors.map((v) => [file, v] as const)
);

describe('engine conformance vectors (SPEC §13.8)', () => {
	it.each(vectors.map(([file, v]) => [`${file}: ${v.description}`, v] as const))('%s', (_, v) => {
		if ((EXACT as readonly string[]).includes(v.op)) {
			const actual = runExact(v);
			expect(matches(actual, v.expect), JSON.stringify(actual)).toBe(true);
		} else {
			expect(PROPERTY as readonly string[]).toContain(v.op);
			runProperty(v);
		}
	});

	it('every op has vectors, in the file named after it', () => {
		for (const op of [...EXACT, ...PROPERTY]) {
			expect(vectors.filter(([f, v]) => f === `${op}.json` && v.op === op).length).toBeGreaterThan(
				0
			);
		}
		expect(vectors.every(([f, v]) => f === `${v.op}.json`)).toBe(true);
	});

	it('every violation code has a validate vector that produces it', () => {
		const codes: ViolationCode[] = [
			'type-not-allowed',
			'unknown-type',
			'out-of-range',
			'off-grid',
			'not-in-set',
			'locked',
			'too-many-bands',
			'rule-violated',
			'unknown-rule'
		];
		const produced = new Set(
			vectors
				.filter(([, v]) => v.op === 'validate')
				.flatMap(([, v]) => (v.expect as { code: string }[]).map((x) => x.code))
		);
		expect(codes.filter((c) => !produced.has(c))).toEqual([]);
	});
});
