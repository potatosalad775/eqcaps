// Sets the version of the published packages, and their dependencies on each other, to the one
// given. The release workflow runs it from the tag (v1.2.3 → 1.2.3); package.json files in the
// repository stay at 0.0.0.
//
// Usage: node scripts/set-version.ts <version>

import { readFileSync, writeFileSync } from 'node:fs';

const PUBLISHED = ['core', 'client'];

const version = process.argv[2]?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
	console.error('usage: node scripts/set-version.ts <semver>');
	process.exit(2);
}
const names = new Set(PUBLISHED.map((p) => `@potatosalad775/eqcaps-${p}`));
for (const pkg of PUBLISHED) {
	const path = new URL(`../packages/${pkg}/package.json`, import.meta.url);
	const json = JSON.parse(readFileSync(path, 'utf8')) as {
		version: string;
		dependencies?: Record<string, string>;
	};
	json.version = version;
	for (const dep of Object.keys(json.dependencies ?? {})) {
		if (names.has(dep)) json.dependencies![dep] = version;
	}
	writeFileSync(path, `${JSON.stringify(json, null, '\t')}\n`);
	console.log(`${pkg}: ${version}`);
}
