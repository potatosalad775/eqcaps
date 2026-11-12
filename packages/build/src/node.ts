import { readdirSync, readFileSync, statSync } from 'node:fs';
import { checkLayout, type DataFile } from './layout.ts';
import type { Artifact } from './publish.ts';
import { withLines } from './report.ts';
import { createSchemaValidator, type Schemas } from './schema.ts';
import { validateSources, type FileIssue } from './validate.ts';
import type { Profile } from '@potatosalad775/eqcaps-core';

export { dataVersion, publish } from './publish.ts';
export type { Artifact, PublishInput } from './publish.ts';

/** Repository root, from either src/ or dist/. */
export const repoRoot = new URL('../../../', import.meta.url);

const readJson = (rel: string, root: URL) =>
	JSON.parse(readFileSync(new URL(rel, root), 'utf8')) as object;

export function loadSchemas(root: URL = repoRoot): Schemas {
	return {
		profile: readJson('schema/v1/profile.schema.json', root),
		source: readJson('schema/v1/source.schema.json', root)
	};
}

/** Every file below `dir` (relative to `root`), as paths relative to `root`, sorted. */
function walk(root: URL, dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(new URL(dir, root));
	} catch {
		return [];
	}
	return names
		.sort()
		.flatMap((name) =>
			statSync(new URL(`${dir}${name}`, root)).isDirectory()
				? walk(root, `${dir}${name}/`)
				: [`${dir}${name}`]
		);
}

export interface RepositoryData {
	/** The authoring files: data/profiles/**\/*.json and data/bases/*.json. */
	files: DataFile[];
	/** Paths under data/ of every evidence file, e.g. `evidence/<id>/<file>.json`. */
	evidence: Set<string>;
}

export function readRepositoryData(root: URL = repoRoot): RepositoryData {
	const files = [...walk(root, 'data/profiles/'), ...walk(root, 'data/bases/')]
		.filter((p) => p.endsWith('.json'))
		.map((path) => ({ path, text: readFileSync(new URL(path, root), 'utf8') }));
	const evidence = new Set(walk(root, 'data/evidence/').map((p) => p.slice('data/'.length)));
	return { files, evidence };
}

export interface RepositoryReport {
	/** Layout, schema, semantic and database issues, with lines. */
	issues: FileIssue[];
	/** Flat profiles that passed every check, keyed by id. */
	profiles: Map<string, Profile>;
	files: DataFile[];
}

/** Validates data/ the way CI does: layout, then validateSources. */
export function validateRepository(root: URL = repoRoot): RepositoryReport {
	const { files, evidence } = readRepositoryData(root);
	const layout = checkLayout(files, evidence);
	const report = validateSources(layout.files, {
		schema: createSchemaValidator(loadSchemas(root))
	});
	return {
		issues: withLines([...layout.issues, ...report.issues], files),
		profiles: report.profiles,
		files
	};
}

/** conformance/v1/**, paths relative to it. */
export function readConformance(root: URL = repoRoot): Artifact[] {
	const dir = 'conformance/v1/';
	return walk(root, dir).map((path) => ({
		path: path.slice(dir.length),
		content: readFileSync(new URL(path, root), 'utf8')
	}));
}
