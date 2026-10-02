import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import type { Issue } from '@potatosalad775/eqcaps-core';

export interface Schemas {
	/** schema/v1/profile.schema.json */
	profile: object;
	/** schema/v1/source.schema.json */
	source: object;
}

export interface SchemaValidator {
	/** Strict structural check of a published (flat) profile. */
	published(data: unknown): Issue[];
	/** Strict structural check of an authoring file under data/. */
	authoring(data: unknown): Issue[];
}

/** Ajv over both schemas. Browser-safe: the caller supplies the schema objects. */
export function createSchemaValidator(schemas: Schemas): SchemaValidator {
	const ajv = new Ajv2020({
		allErrors: true,
		strict: true,
		// The schemas put `required` inside if/then/else and anyOf, next to properties declared one
		// level up. That is valid JSON Schema; strictRequired only flags it as unusual.
		strictRequired: false,
		allowUnionTypes: true
	});
	const published = ajv.compile(schemas.profile);
	const authoring = ajv.compile(schemas.source);
	const run = (validate: typeof published) => (data: unknown) =>
		validate(data) ? [] : toIssues(validate.errors ?? []);
	return { published: run(published), authoring: run(authoring) };
}

const pointerSegment = (s: unknown) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

/** Keys the schemas forbid in some contexts (`false` subschemas), explained. */
const FORBIDDEN_KEYS: Record<string, string> = {
	match: 'a software profile has no match; it is selected by id (SPEC §2)',
	replacedBy: 'replacedBy is only allowed when status is deprecated (SPEC §10)'
};

/**
 * Ajv errors as issues. Errors about a missing or unexpected key point at that key, not its
 * parent. Dropped as noise: `if` errors, which only repeat the then/else error underneath, and
 * `unevaluatedProperties` errors next to another error in the same object. When a `$ref`'d
 * subschema fails, Ajv counts none of its keys as evaluated and flags every sibling key.
 */
function toIssues(errors: ErrorObject[]): Issue[] {
	const seen = new Set<string>();
	const issues: Issue[] = [];
	const realErrorPaths = errors
		.filter((e) => e.keyword !== 'unevaluatedProperties' && e.keyword !== 'if')
		.map((e) => e.instancePath);
	for (const e of errors) {
		if (e.keyword === 'if') continue;
		if (
			e.keyword === 'unevaluatedProperties' &&
			realErrorPaths.some((p) => p === e.instancePath || p.startsWith(`${e.instancePath}/`))
		) {
			continue;
		}
		const p = e.params as Record<string, unknown>;
		const key = p.missingProperty ?? p.additionalProperty ?? p.unevaluatedProperty;
		const path = key === undefined ? e.instancePath : `${e.instancePath}/${pointerSegment(key)}`;
		let message = e.message ?? e.keyword;
		if (e.keyword === 'false schema') {
			message = FORBIDDEN_KEYS[path.split('/').pop() ?? ''] ?? 'not allowed here';
		}
		if (p.allowedValues) message += `: ${(p.allowedValues as unknown[]).join(', ')}`;
		const k = `${path} ${message}`;
		if (seen.has(k)) continue;
		seen.add(k);
		issues.push({ code: 'schema', severity: 'error', path, message });
	}
	return issues;
}
