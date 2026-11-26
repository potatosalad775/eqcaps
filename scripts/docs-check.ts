// Checks the docs against the repository, so a stale reference fails `npm run check` instead of
// waiting for a reader to trip on it. "Docs" are the tracked Markdown files.
//
//   links       a relative Markdown link names a tracked file or directory, and its #fragment a
//               heading of the linked Markdown file
//   decisions   a D<n> citation is a decision in docs/DECISIONS.md; one under its "Archived"
//               heading says "archived" on the same line. Two digits only: D900 is a Topping DAC.
//   sections    a SPEC, INSPECTOR or ARCHITECTURE §N citation is a numbered heading of that doc;
//               inside one of them, a §N with no doc name before it is one of its own
//   repoPaths   a backticked repository path names a tracked file or directory (not in plans)
//   npmScripts  an `npm run <name>` is a root package.json script (not in plans)
//   wrap        no prose line is wider than 100 columns where it could be wrapped (Prettier
//               skips Markdown); tables, headings and code blocks are left alone
//   planRows    every plan is linked from a row of docs/plans/README.md
//
// Usage: node scripts/docs-check.ts
// Prints `path:line: message` for every finding and fails if there is one.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Finding {
	file: string;
	line: number;
	message: string;
}

/** `texts`: tracked text files the checks read, path → content. `paths`: every tracked path. */
export interface Repo {
	texts: ReadonlyMap<string, string>;
	paths: readonly string[];
}

/** A finding that is right as written: it matches by file and a substring of the message. */
export interface Exception {
	file: string;
	text: string;
	why: string;
}

type Check = (repo: Repo) => Finding[];

export const EXCEPTIONS: readonly Exception[] = [
	{
		file: 'docs/SPEC.md',
		text: 'schema/profile.schema.json',
		why: 'a published path under /v1/, not a repository path'
	},
	{
		file: 'AGENTS.md',
		text: 'npm run walkplay:fetch',
		why: 'a script in ../eqcaps_private (D52)'
	}
];

const DECISIONS = 'docs/DECISIONS.md';
/** The heading of DECISIONS.md under which the decisions that no longer apply are listed. */
const ARCHIVED_HEADING = /^## Archived$/m;
const PLANS = 'docs/plans/';
const PLANS_README = 'docs/plans/README.md';
/** The docs whose numbered sections are cited as `<NAME> §N`. */
const SECTION_DOCS: Readonly<Record<string, string>> = {
	SPEC: 'docs/SPEC.md',
	INSPECTOR: 'docs/INSPECTOR.md',
	ARCHITECTURE: 'docs/ARCHITECTURE.md'
};
/** Source files whose comments and text may cite decisions and sections. */
const SOURCE = /\.(ts|js|svelte|yml)$/;
const WIDTH = 100;

const isLiveDoc = (path: string) => path.endsWith('.md');
const isSource = (path: string) => SOURCE.test(path) && !path.startsWith('conformance/');

function texts(repo: Repo, keep: (path: string) => boolean): [string, string][] {
	return [...repo.texts].filter(([path]) => keep(path));
}

/** For each line, whether it is part of a fenced code block, the fence lines included. */
function fenced(lines: readonly string[]): boolean[] {
	let open: string | undefined;
	return lines.map((line) => {
		const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (open === undefined) {
			if (fence) open = fence[0];
			return fence !== undefined;
		}
		if (fence?.[0] === open) open = undefined;
		return true;
	});
}

/** Each ATX heading outside code blocks, with its 1-based line. */
function headings(text: string): { line: number; text: string }[] {
	const lines = text.split('\n');
	const code = fenced(lines);
	return lines.flatMap((line, i) => {
		const m = /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
		return m && !code[i] ? [{ line: i + 1, text: m[1]! }] : [];
	});
}

/** The anchors GitHub gives a Markdown file's headings, repeats numbered `-1`, `-2`, …. */
function anchors(text: string): Set<string> {
	const seen = new Map<string, number>();
	const out = new Set<string>();
	for (const h of headings(text)) {
		const rendered = h.text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
		const slug = rendered
			.toLowerCase()
			.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
			.replace(/ /g, '-');
		const n = seen.get(slug) ?? 0;
		seen.set(slug, n + 1);
		out.add(n === 0 ? slug : `${slug}-${n}`);
	}
	return out;
}

/** Every tracked path and every directory above one. */
function pathsAndDirs(repo: Repo): Set<string> {
	const out = new Set<string>();
	for (const path of repo.paths) {
		out.add(path);
		for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
			out.add(path.slice(0, i));
		}
	}
	return out;
}

/** The 1-based line of a character offset. */
function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++;
	return line;
}

const links: Check = (repo) => {
	const known = pathsAndDirs(repo);
	const findings: Finding[] = [];
	for (const [file, text] of texts(repo, isLiveDoc)) {
		const lines = text.split('\n');
		const code = fenced(lines);
		lines.forEach((line, i) => {
			if (code[i]) return;
			for (const m of line.matchAll(/\]\(([^)\s]+)/g)) {
				const href = m[1]!;
				if (/^(https?|mailto):/.test(href)) continue;
				const [target, fragment] = href.split('#', 2);
				const path = target ? posix.normalize(posix.join(posix.dirname(file), target)) : file;
				if (path.startsWith('..')) continue;
				const resolved = path.replace(/\/$/, '');
				const finding = (message: string) => findings.push({ file, line: i + 1, message });
				if (!known.has(resolved)) finding(`link ${href}: no such file or directory`);
				else if (fragment && resolved.endsWith('.md')) {
					const linked = repo.texts.get(resolved);
					if (linked !== undefined && !anchors(linked).has(fragment)) {
						finding(`link ${href}: ${resolved} has no heading #${fragment}`);
					}
				}
			}
		});
	}
	return findings;
};

function decisionNumbers(text: string | undefined): Set<number> {
	return new Set([...(text ?? '').matchAll(/^### D(\d+)\./gm)].map((m) => Number(m[1])));
}

const decisions: Check = (repo) => {
	const [live, retired] = (repo.texts.get(DECISIONS) ?? '').split(ARCHIVED_HEADING, 2);
	const current = decisionNumbers(live);
	const archived = decisionNumbers(retired);
	const findings: Finding[] = [];
	for (const [file, text] of texts(repo, (p) => isLiveDoc(p) || isSource(p))) {
		text.split('\n').forEach((line, i) => {
			for (const m of line.matchAll(/\bD(\d{1,2})\b/g)) {
				const n = Number(m[1]);
				if (current.has(n)) continue;
				if (archived.has(n)) {
					if (/\barchived\b/i.test(line)) continue;
					findings.push({
						file,
						line: i + 1,
						message: `D${n} is archived (${DECISIONS}): say "archived" on the line, or cite a current decision`
					});
				} else {
					findings.push({ file, line: i + 1, message: `D${n}: no such decision in ${DECISIONS}` });
				}
			}
		});
	}
	return findings;
};

/** The section numbers of a doc's numbered headings (`## 9.`, `### 13.8`). */
function sectionNumbers(text: string | undefined): Set<string> {
	const out = new Set<string>();
	for (const h of headings(text ?? '')) {
		const m = /^(\d+(?:\.\d+)*)\.?\s/.exec(h.text);
		if (m) out.add(m[1]!);
	}
	return out;
}

/**
 * The section doc a `§N` in `file` cites, from the word before it: a section doc's name
 * (`SPEC §9`, `[SPEC §9]`, `docs/SPEC.md §9`), or with none, `file` itself if it is a section doc.
 * Another doc's name (`prior-art.md §2.1`, a link's text `[prior-art §2.1]`) cites nothing checked.
 */
function citedDoc(file: string, before: string): string | undefined {
	const word = /(\S*)\s*$/.exec(before)?.[1] ?? '';
	const name = word.replace(/^[([`*]+/, '');
	const doc = /^(?:[\w./-]*\/)?(SPEC|INSPECTOR|ARCHITECTURE)(?:\.md)?$/.exec(name)?.[1];
	if (doc) return SECTION_DOCS[doc];
	if (name.endsWith('.md') || (name !== '' && word.includes('['))) return undefined;
	return Object.values(SECTION_DOCS).includes(file) ? file : undefined;
}

const sections: Check = (repo) => {
	const numbers = new Map(
		Object.values(SECTION_DOCS).map((doc) => [doc, sectionNumbers(repo.texts.get(doc))])
	);
	const findings: Finding[] = [];
	for (const [file, text] of texts(repo, (p) => isLiveDoc(p) || isSource(p))) {
		let previous: { end: number; doc: string | undefined } | undefined;
		for (const m of text.matchAll(/§(\d+(?:\.\d+)*)/g)) {
			const start = m.index;
			// A `§N` continuing a list or range (`SPEC §9, §10`, `§9.1 and §10`, `§4–§9`) cites the
			// doc the one before it does.
			const doc =
				previous && /^(?:,\s*|\s+and\s+|\s*[–-]\s*)$/.test(text.slice(previous.end, start))
					? previous.doc
					: citedDoc(file, text.slice(Math.max(0, start - 80), start));
			previous = { end: start + m[0].length, doc };
			if (doc === undefined || numbers.get(doc)!.has(m[1]!)) continue;
			findings.push({
				file,
				line: lineAt(text, start),
				message: `§${m[1]}: ${doc} has no section ${m[1]}`
			});
		}
	}
	return findings;
};

const repoPaths: Check = (repo) => {
	const known = pathsAndDirs(repo);
	const top = new Set(repo.paths.map((p) => p.split('/')[0]));
	const findings: Finding[] = [];
	for (const [file, text] of texts(repo, (p) => isLiveDoc(p) && !p.startsWith(PLANS))) {
		text.split('\n').forEach((line, i) => {
			for (const m of line.matchAll(/`([^`\s]+\/[^`\s]*)`/g)) {
				const path = m[1]!.replace(/\/$/, '');
				if (/[<*{…]/.test(path) || path.startsWith('..')) continue;
				if (!top.has(path.split('/')[0]) || known.has(path)) continue;
				findings.push({ file, line: i + 1, message: `\`${m[1]}\`: no such file or directory` });
			}
		});
	}
	return findings;
};

const npmScripts: Check = (repo) => {
	const pkg = JSON.parse(repo.texts.get('package.json') ?? '{}') as { scripts?: object };
	const scripts = new Set(Object.keys(pkg.scripts ?? {}));
	const findings: Finding[] = [];
	for (const [file, text] of texts(repo, (p) => isLiveDoc(p) && !p.startsWith(PLANS))) {
		text.split('\n').forEach((line, i) => {
			for (const m of line.matchAll(/npm run ([\w:-]+)/g)) {
				if (scripts.has(m[1]!)) continue;
				findings.push({
					file,
					line: i + 1,
					message: `npm run ${m[1]}: no such script in package.json`
				});
			}
		});
	}
	return findings;
};

const wrap: Check = (repo) => {
	const findings: Finding[] = [];
	for (const [file, text] of texts(repo, isLiveDoc)) {
		const lines = text.split('\n');
		const code = fenced(lines);
		lines.forEach((line, i) => {
			const chars = [...line];
			if (chars.length <= WIDTH || code[i] || /^\s*[|#]/.test(line)) return;
			// A break right after the indent or a list marker would leave an empty line or item.
			const lead = [.../^\s*(?:(?:[-*+>]|\d+[.)])\s+)?/.exec(line)![0]].length;
			if (!chars.slice(lead + 1, WIDTH + 1).includes(' ')) return;
			findings.push({
				file,
				line: i + 1,
				message: `${chars.length} columns: wrap by hand at ${WIDTH} (Prettier skips Markdown)`
			});
		});
	}
	return findings;
};

const planRows: Check = (repo) => {
	const rows = (repo.texts.get(PLANS_README) ?? '')
		.split('\n')
		.filter((line) => line.trimStart().startsWith('|'));
	const linked = new Set(
		rows.flatMap((row) => [...row.matchAll(/\]\(([^)#\s]+)/g)].map((m) => posix.join(PLANS, m[1]!)))
	);
	return repo.paths
		.filter((p) => p.startsWith(PLANS) && p.endsWith('.md') && p !== PLANS_README)
		.filter((p) => !p.slice(PLANS.length).includes('/') && !linked.has(p))
		.map((file) => ({
			file,
			line: 1,
			message: `no row of ${PLANS_README} links this plan`
		}));
};

const CHECKS: readonly Check[] = [
	links,
	decisions,
	sections,
	repoPaths,
	npmScripts,
	wrap,
	planRows
];

/** Every finding of every check, less the exceptions; an exception that matches none is one. */
export function checkDocs(repo: Repo, exceptions: readonly Exception[] = EXCEPTIONS): Finding[] {
	const used = new Set<Exception>();
	const findings = CHECKS.flatMap((check) => check(repo)).filter((f) => {
		const exception = exceptions.find((e) => e.file === f.file && f.message.includes(e.text));
		if (exception) used.add(exception);
		return !exception;
	});
	for (const e of exceptions) {
		if (used.has(e)) continue;
		findings.push({
			file: e.file,
			line: 1,
			message: `the exception for "${e.text}" matches no finding: remove it from EXCEPTIONS in scripts/docs-check.ts`
		});
	}
	return findings.sort(
		(a, b) =>
			(a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
			a.line - b.line ||
			(a.message < b.message ? -1 : a.message > b.message ? 1 : 0)
	);
}

const root = fileURLToPath(new URL('..', import.meta.url));

/** The repository as git sees it: tracked and new, unignored files that are on disk. */
function readRepo(): Repo {
	const paths = execFileSync(
		'git',
		['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'],
		{ cwd: root, encoding: 'utf8' }
	)
		.split('\0')
		.filter((p) => p !== '' && existsSync(`${root}${p}`));
	const read = paths.filter((p) => p.endsWith('.md') || SOURCE.test(p) || p === 'package.json');
	return { paths, texts: new Map(read.map((p) => [p, readFileSync(`${root}${p}`, 'utf8')])) };
}

function main() {
	if (process.argv.length > 2) {
		console.error('Usage: docs-check.ts');
		process.exit(2);
	}
	const findings = checkDocs(readRepo());
	for (const f of findings) console.error(`${f.file}:${f.line}: ${f.message}`);
	if (findings.length > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
