import { readFileSync } from 'node:fs';
import type { Schemas } from './schema.ts';

/** Repository root, from either src/ or dist/. */
export const repoRoot = new URL('../../../', import.meta.url);

const readJson = (rel: string) =>
	JSON.parse(readFileSync(new URL(rel, repoRoot), 'utf8')) as object;

export function loadSchemas(): Schemas {
	return {
		profile: readJson('schema/v1/profile.schema.json'),
		source: readJson('schema/v1/source.schema.json')
	};
}
