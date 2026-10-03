// eqcaps data CLI. Run from the repository root:
//
//   node --conditions=eqcaps:source packages/build/src/cli.ts <command> [options]
//
// (npm run data:validate / data:build do this.) Commands:
//
//   validate             Check data/: layout, schemas, semantic rules, cross-profile rules.
//   check-collisions     Only the cross-profile rules (duplicate ids, replacedBy, match collisions).
//   build --out <dir>    Validate, then write the published files of one channel into <dir>:
//                        profiles/<id>.json, index.json, bundle.json, schema/, conformance/.
//                        --data-version <v>  default: date and short sha of HEAD
//                        --generated-at <t>  default: now (ISO 8601)
//                        --schema-url <url>  `$schema` of published profiles (default: the v1 URL)
//
// Exit code 1 on any error. Inside GitHub Actions, issues are also printed as annotations, so
// they show up on the offending line of a pull request.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { dataVersion, loadSchemas, publish, readConformance, validateRepository } from './node.ts';
import { formatGithub, formatText } from './report.ts';
import type { FileIssue } from './validate.ts';

const DATABASE_CODES = new Set(['duplicate-id', 'replaced-by-missing', 'match-collision']);

function report(issues: FileIssue[], ok: string): boolean {
	const errors = issues.filter((i) => i.severity === 'error').length;
	if (issues.length > 0) {
		console.log(formatText(issues));
		if (process.env.GITHUB_ACTIONS === 'true') console.log(formatGithub(issues));
	}
	if (errors > 0) {
		console.error(`\n${errors} error${errors === 1 ? '' : 's'}. Rules: docs/SPEC.md`);
		return false;
	}
	console.log(ok);
	return true;
}

function gitDataVersion(): string {
	try {
		const out = execFileSync('git', ['log', '-1', '--format=%cs %h'], { encoding: 'utf8' });
		const [date, sha] = out.trim().split(' ');
		if (date && sha) return dataVersion(date, sha);
	} catch {
		// Not a git checkout.
	}
	return dataVersion(new Date().toISOString().slice(0, 10), 'local');
}

function main(argv: string[]): number {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			out: { type: 'string' },
			'data-version': { type: 'string' },
			'generated-at': { type: 'string' },
			'schema-url': { type: 'string' }
		}
	});
	const command = positionals[0];
	if (command !== 'validate' && command !== 'check-collisions' && command !== 'build') {
		console.error('usage: cli.ts validate | check-collisions | build --out <dir>');
		return 2;
	}

	const repo = validateRepository();
	const count = `${repo.profiles.size} profiles from ${repo.files.length} files`;
	if (command === 'check-collisions') {
		const issues = repo.issues.filter((i) => DATABASE_CODES.has(i.code));
		return report(issues, `No collisions among ${count}.`) ? 0 : 1;
	}
	if (!report(repo.issues, `OK: ${count}.`)) return 1;
	if (command === 'validate') return 0;

	if (!values.out) {
		console.error('build needs --out <dir>');
		return 2;
	}
	const out = resolve(values.out);
	const artifacts = publish({
		profiles: repo.profiles.values(),
		schema: loadSchemas().profile,
		conformance: readConformance(),
		dataVersion: values['data-version'] ?? gitDataVersion(),
		generatedAt: values['generated-at'] ?? new Date().toISOString(),
		...(values['schema-url'] ? { schemaUrl: values['schema-url'] } : {})
	});
	rmSync(out, { recursive: true, force: true });
	for (const a of artifacts) {
		const file = resolve(out, a.path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, a.content);
	}
	console.log(`Wrote ${artifacts.length} files to ${out}.`);
	return 0;
}

process.exitCode = main(process.argv.slice(2));
