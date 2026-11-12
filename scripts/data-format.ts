// Formats every authoring file in data/ the way the inspector's editor writes it (formatAuthoring):
// keys in the repository order, then Prettier over compact JSON, so an object is on one line when
// it fits. Prettier alone keeps an object expanded if the file breaks the line after its `{`, so
// `prettier --write` accepts a hand-formatted file that this script rewrites.
//
// Usage: node --conditions=eqcaps:source scripts/data-format.ts [--check]
// With --check nothing is written; the script fails if a file isn't formatted.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthoringProfile } from '@potatosalad775/eqcaps-core';
import { formatAuthoring } from '../apps/inspector/src/lib/editor.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function dataFiles(dir: string): string[] {
	return readdirSync(join(root, dir), { withFileTypes: true, recursive: true })
		.filter((d) => d.isFile() && d.name.endsWith('.json'))
		.map((d) => join(d.parentPath, d.name))
		.sort();
}

async function main() {
	const check = process.argv.includes('--check');
	let stale = false;
	for (const path of [...dataFiles('data/bases'), ...dataFiles('data/profiles')]) {
		const current = readFileSync(path, 'utf8');
		const rel = relative(root, path).replaceAll('\\', '/');
		let content: string;
		try {
			content = await formatAuthoring(JSON.parse(current) as AuthoringProfile);
		} catch (e) {
			console.error(`data:format: ${rel}: ${(e as Error).message}`);
			stale = true;
			continue;
		}
		if (current === content) continue;
		if (check) {
			console.error(`data:format: ${rel} is not formatted. Run \`npm run format\`.`);
			stale = true;
		} else {
			writeFileSync(path, content);
			console.log(`data:format: wrote ${rel}`);
		}
	}
	if (stale) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
