import { describe, expect, it } from 'vitest';
import { checkDocs, type Exception, type Repo } from './docs-check.ts';

/** The docs every check reads, small. */
const BASE: Record<string, string> = {
	'package.json': JSON.stringify({ scripts: { check: 'tsc' } }),
	'docs/DECISIONS.md': '# Decisions\n\n### D1. Current\n',
	'docs/history/decisions.md': '# Decisions\n\n### D2. Old\n',
	'docs/SPEC.md': '# Spec\n\n## 9. Preamp\n\n### 9.1 Controls\n',
	'docs/INSPECTOR.md': '# Inspector\n\n## 3. Guided reads\n',
	'docs/ARCHITECTURE.md': '# Architecture\n\n## 5. Package boundaries\n',
	'docs/plans/README.md': '# Plans\n\n| Plan | Status |\n| --- | --- |\n'
};

function repo(files: Record<string, string>, otherPaths: string[] = []): Repo {
	const texts = { ...BASE, ...files };
	return { texts: new Map(Object.entries(texts)), paths: [...Object.keys(texts), ...otherPaths] };
}

/** Where the findings are, as `file:line`. */
function at(r: Repo, exceptions: readonly Exception[] = []): string[] {
	return checkDocs(r, exceptions).map((f) => `${f.file}:${f.line}`);
}

describe('checkDocs', () => {
	it('passes the base repo', () => {
		expect(checkDocs(repo({}), [])).toEqual([]);
	});

	it('finds links to missing files and headings', () => {
		const doc = [
			'[spec](SPEC.md#91-controls) [dir](../packages/core) [out](../../issues/new/choose)',
			'[web](https://example.com/x.md#nope) [here](#a-heading)',
			'[gone](missing.md)',
			'[no heading](SPEC.md#10-provenance)',
			'## A heading'
		].join('\n');
		expect(at(repo({ 'docs/a.md': doc }, ['packages/core/src/index.ts']))).toEqual([
			'docs/a.md:3',
			'docs/a.md:4'
		]);
	});

	it('finds decisions that do not exist or are archived without saying so', () => {
		const lines = ['D1', 'D2, archived', 'D2', 'D7', 'a Topping D900'].join('\n');
		expect(
			at(
				repo({
					'docs/a.md': lines,
					'packages/core/src/a.ts': '// D7',
					'packages/core/src/a.json': '"D7"',
					'conformance/v1/a.ts': '// D7',
					'docs/history/plan.md': 'D7'
				})
			)
		).toEqual(['docs/a.md:3', 'docs/a.md:4', 'packages/core/src/a.ts:1']);
	});

	it('finds section citations that name no heading', () => {
		const other = [
			'SPEC §9.1, ARCHITECTURE.md §5, INSPECTOR §3',
			'SPEC §7',
			'SPEC §9 and §8',
			'prior-art.md §2.1, [prior-art §2.1](research/prior-art.md)',
			'(§4)'
		].join('\n');
		const spec = [
			BASE['docs/SPEC.md'],
			'Preamp (§9), controls (§9.1).',
			'Missing (§4).',
			'A range §9–§12.',
			'See INSPECTOR',
			'§3 and ARCHITECTURE §6.'
		].join('\n');
		expect(
			at(repo({ 'docs/a.md': other, 'docs/SPEC.md': spec }, ['docs/research/prior-art.md']))
		).toEqual([
			'docs/SPEC.md:8',
			'docs/SPEC.md:9',
			'docs/SPEC.md:11',
			'docs/a.md:2',
			'docs/a.md:3'
		]);
	});

	it('finds backticked repository paths that do not exist, outside plans', () => {
		const doc = [
			'`packages/core/src/index.ts` `packages/core/` `packages/<p>/src` `node_modules/x/y`',
			'`../uniPEQ/src` `@potatosalad775/eqcaps-core` `dist/site/v1/`',
			'`packages/core/src/gone.ts`'
		].join('\n');
		expect(
			at(
				repo({ 'README.md': doc, 'docs/plans/a.md': doc, 'docs/plans/README.md': rows('a.md') }, [
					'packages/core/src/index.ts'
				])
			)
		).toEqual(['README.md:3']);
	});

	it('finds npm scripts that package.json lacks, outside plans', () => {
		const doc = 'Run `npm run check`.\nRun `npm run nope`.';
		expect(
			at(repo({ 'README.md': doc, 'docs/plans/a.md': doc, 'docs/plans/README.md': rows('a.md') }))
		).toEqual(['README.md:2']);
	});

	it('finds prose lines over 100 columns that could be wrapped', () => {
		const long = 'word '.repeat(25).trim();
		const doc = [
			long,
			`| ${long} |`,
			`## ${long}`,
			'```jsonc',
			long,
			'```',
			`- https://example.com/${'x'.repeat(100)}`,
			`a ${'𝄞'.repeat(98)}`,
			`  - ${long}`
		].join('\n');
		expect(at(repo({ 'docs/a.md': doc }))).toEqual(['docs/a.md:1', 'docs/a.md:9']);
	});

	it('finds plans no row of the plans README links', () => {
		const files = {
			'docs/plans/README.md': rows('a.md'),
			'docs/plans/a.md': '',
			'docs/plans/b.md': ''
		};
		expect(at(repo(files))).toEqual(['docs/plans/b.md:1']);
	});

	it('drops a finding an exception names, and reports an exception that names none', () => {
		const r = repo({ 'README.md': 'Run `npm run nope`.' });
		const used = { file: 'README.md', text: 'npm run nope', why: 'test' };
		const stale = { file: 'docs/SPEC.md', text: 'npm run gone', why: 'test' };
		expect(at(r, [used])).toEqual([]);
		expect(at(r, [used, stale])).toEqual(['docs/SPEC.md:1']);
	});
});

function rows(...plans: string[]): string {
	return [BASE['docs/plans/README.md'], ...plans.map((p) => `| [${p}](${p}) | Started |`)].join(
		'\n'
	);
}
