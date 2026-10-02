// Generates everything that derives from schema/v1/profile.schema.json (DECISIONS D13):
//
//   schema/v1/source.schema.json               the authoring schema (SPEC §11)
//   packages/core/src/types/schema.generated.ts TypeScript types for both schemas
//
// Usage: node scripts/codegen.ts [--check]
// With --check nothing is written; the script fails if a generated file is out of date, which
// is how CI catches a schema edit without a regenerate.
//
// The type generator covers exactly the JSON Schema subset the eqcaps schemas use: local $ref,
// $ref with sibling properties (emitted as `extends`), type, enum, const, oneOf/anyOf unions,
// properties/required, items and descriptions. Keywords that only constrain (required-only
// anyOf, if/then/else, not, patternProperties) carry no type information and are skipped. A
// string whose pattern starts with ^x- becomes `x-${string}`.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

type Schema = { [key: string]: unknown };

const root = fileURLToPath(new URL('..', import.meta.url));
const paths = {
	profile: `${root}schema/v1/profile.schema.json`,
	source: `${root}schema/v1/source.schema.json`,
	types: `${root}packages/core/src/types/schema.generated.ts`
};

/** Builds the authoring schema: profile schema + abstract/extends, no `via`, relaxed required. */
export function deriveSourceSchema(profile: Schema): Schema {
	const s = structuredClone(profile) as Schema & {
		properties: Record<string, Schema>;
		$defs: Record<string, Schema>;
	};
	const defs = s.$defs;
	const source = defs.source as { properties: Record<string, unknown> };
	const meta = defs.meta as { properties: { sources: Schema } };
	const realization = defs.realization as { properties: { sources: Schema } };

	s.$id = (profile.$id as string).replace('profile.schema.json', 'source.schema.json');
	s.title = 'eqcaps authoring file (data/profiles, data/bases)';
	s.description =
		'A profile as written in this repository, before the build flattens `extends` (SPEC §11). Generated from profile.schema.json by scripts/codegen.ts; do not edit by hand.';
	s.properties = {
		...s.properties,
		abstract: {
			description: 'A base only: never published, needs no match or device (SPEC §11).',
			type: 'boolean'
		},
		extends: {
			description:
				'Start from this profile and apply this file on top. match, device, meta and id are never inherited (SPEC §11).',
			$ref: '#/$defs/profileId'
		},
		meta: { $ref: '#/$defs/authoringMeta' },
		realization: { $ref: '#/$defs/authoringRealization' }
	};
	s.required = ['id', 'meta'];
	s.allOf = [{ $ref: '#/$defs/authoringRules' }];

	const { via: _via, ...sourceProperties } = source.properties;
	defs.authoringSource = {
		...source,
		description: 'Provenance of a claim. `via` is set only by the build (SPEC §10).',
		properties: sourceProperties
	};
	defs.authoringMeta = {
		...meta,
		properties: {
			...meta.properties,
			sources: { ...meta.properties.sources, items: { $ref: '#/$defs/authoringSource' } }
		}
	};
	defs.authoringRealization = {
		...realization,
		properties: {
			...realization.properties,
			sources: { ...realization.properties.sources, items: { $ref: '#/$defs/authoringSource' } }
		}
	};
	defs.authoringRules = {
		description:
			'Abstract bases may be partial. A file with `extends` needs a device; everything else is inherited and checked after flattening. A standalone file is a complete profile.',
		if: { type: 'object', properties: { abstract: { const: true } }, required: ['abstract'] },
		else: {
			if: { type: 'object', required: ['extends'] },
			then: { type: 'object', required: ['device'] },
			else: {
				type: 'object',
				required: profile.required,
				allOf: [{ $ref: '#/$defs/kindRules' }]
			}
		}
	};
	delete defs.source;
	delete defs.meta;
	delete defs.realization;
	return s;
}

const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
const refName = (ref: string) => pascal(ref.replace('#/$defs/', ''));
const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
const doc = (s: Schema) =>
	typeof s.description === 'string' ? `/** ${s.description.replace(/\*\//g, '*\\/')} */\n` : '';

/** Schemas that only add constraints (e.g. `{ required: [...] }`) and say nothing about type. */
const constraintOnly = (s: Schema) =>
	Object.keys(s).every((k) => ['required', 'not', 'if', 'then', 'else', 'description'].includes(k));

function objectBody(s: Schema, names: (ref: string) => string): string {
	const props = (s.properties ?? {}) as Record<string, Schema>;
	const required = new Set((s.required ?? []) as string[]);
	const lines = Object.entries(props).map(
		([name, p]) => `${doc(p)}${key(name)}${required.has(name) ? '' : '?'}: ${tsType(p, names)};`
	);
	return `{\n${lines.join('\n')}\n}`;
}

function tsType(s: Schema, names: (ref: string) => string): string {
	if (typeof s.$ref === 'string' && !s.properties) return names(s.$ref);
	if ('const' in s) return JSON.stringify(s.const).replace(/"/g, "'");
	if (Array.isArray(s.enum))
		return s.enum.map((v) => JSON.stringify(v).replace(/"/g, "'")).join(' | ');
	for (const k of ['oneOf', 'anyOf'] as const) {
		const parts = (s[k] as Schema[] | undefined)?.filter((p) => !constraintOnly(p));
		if (parts && parts.length > 0) return parts.map((p) => tsType(p, names)).join(' | ');
	}
	const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
	return types
		.map((t) => {
			switch (t) {
				case 'string':
					return typeof s.pattern === 'string' && s.pattern.startsWith('^x-')
						? '`x-${string}`'
						: 'string';
				case 'number':
				case 'integer':
					return 'number';
				case 'boolean':
					return 'boolean';
				case 'null':
					return 'null';
				case 'array': {
					const item = tsType(s.items as Schema, names);
					return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
				}
				case 'object':
					return objectBody(s, names);
				default:
					throw new Error(`codegen: unsupported schema ${JSON.stringify(s).slice(0, 120)}`);
			}
		})
		.join(' | ');
}

function declaration(name: string, s: Schema, names: (ref: string) => string): string | null {
	const union = (['oneOf', 'anyOf'] as const).some((k) =>
		(s[k] as Schema[] | undefined)?.some((p) => !constraintOnly(p))
	);
	const isObject = s.type === 'object' && !union;
	const hasProperties = Object.keys((s.properties ?? {}) as object).length > 0;
	if (isObject && hasProperties) {
		const base = typeof s.$ref === 'string' ? ` extends ${names(s.$ref)}` : '';
		return `${doc(s)}export interface ${name}${base} ${objectBody(s, names)}`;
	}
	if (isObject && typeof s.$ref === 'string')
		return `${doc(s)}export type ${name} = ${names(s.$ref)};`;
	if (constraintOnly(s) || (!s.type && !s.enum && !('const' in s) && !s.oneOf && !s.anyOf)) {
		return null;
	}
	return `${doc(s)}export type ${name} = ${tsType(s, names)};`;
}

export function generateTypes(profile: Schema, source: Schema): string {
	const profileDefs = profile.$defs as Record<string, Schema>;
	const sourceDefs = source.$defs as Record<string, Schema>;
	const out: string[] = [];
	const emit = (name: string, s: Schema) => {
		const d = declaration(name, s, refName);
		if (d) out.push(d);
	};
	const { $defs: _p, ...profileTop } = profile;
	const { $defs: _s, ...sourceTop } = source;
	emit('Profile', { ...profileTop, description: 'A published (flat) profile (SPEC §2).' });
	emit('AuthoringProfile', {
		...sourceTop,
		description: 'A source file under data/, before the build flattens `extends` (SPEC §11).'
	});
	for (const [name, s] of Object.entries(profileDefs)) emit(pascal(name), s);
	for (const [name, s] of Object.entries(sourceDefs))
		if (!(name in profileDefs)) emit(pascal(name), s);
	const banner =
		'// Generated by scripts/codegen.ts from schema/v1/profile.schema.json. Do not edit by hand.\n\n';
	return banner + out.join('\n\n') + '\n';
}

async function main() {
	const check = process.argv.includes('--check');
	const profile = JSON.parse(readFileSync(paths.profile, 'utf8')) as Schema;
	const source = deriveSourceSchema(profile);
	const prettierConfig = JSON.parse(readFileSync(`${root}.prettierrc`, 'utf8')) as object;
	const outputs: [string, string][] = [
		[paths.source, await format(JSON.stringify(source), { ...prettierConfig, parser: 'json' })],
		[
			paths.types,
			await format(generateTypes(profile, source), { ...prettierConfig, parser: 'typescript' })
		]
	];
	let stale = false;
	for (const [path, content] of outputs) {
		let current = '';
		try {
			current = readFileSync(path, 'utf8');
		} catch {
			// missing counts as stale
		}
		if (current === content) continue;
		const rel = path.slice(root.length);
		if (check) {
			console.error(`codegen: ${rel} is out of date. Run \`npm run codegen\`.`);
			stale = true;
		} else {
			writeFileSync(path, content);
			console.log(`codegen: wrote ${rel}`);
		}
	}
	if (stale) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
