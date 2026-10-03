// The editor (T4, INSPECTOR §2): checks an authoring file the way CI does, formats it the way
// the repository does, diffs it against the file it started from, and turns it into a GitHub
// pull request or issue. Nothing here talks to GitHub: submission is a link the user follows.

import { checkDatabase, type AuthoringProfile, type Profile } from '@potatosalad775/eqcaps-core';
import {
	checkLayout,
	validateSources,
	withLines,
	type DataFile,
	type FileIssue,
	type SchemaValidator
} from '@potatosalad775/eqcaps-build';
import { REPO_URL } from './repo.ts';

export interface EditorCheck {
	/** Issues in the edited file, with lines, in line order. */
	issues: FileIssue[];
	/** Issues in the files it extends: the edited file can't be checked past them. */
	chainIssues: FileIssue[];
	/** The flat profile, when the file is a profile (not abstract) that passed every check. */
	profile: Profile | null;
	/** The parsed file, when it is JSON. */
	data: AuthoringProfile | null;
}

export interface EditorCheckInput {
	/** Repository path of the edited file (authoringPath). */
	path: string;
	text: string;
	/** The files it extends (loadChain). */
	chain: readonly DataFile[];
	/** The rest of the database, for cross-profile rules (ids, match collisions, replacedBy). */
	others: readonly Profile[];
	/** Evidence files known to exist, paths under data/ ("evidence/<id>/<file>.json"). */
	evidence: ReadonlySet<string>;
	/**
	 * Every id in the database, deprecated ones included, when `others` lacks some (the bundle
	 * leaves deprecated profiles out): a `replacedBy` naming one of them is not missing.
	 */
	knownIds?: ReadonlySet<string>;
	schema: SchemaValidator;
}

/**
 * Validates one authoring file as CI would (layout, schemas, flatten, semantic rules, database
 * rules), against the files it extends and the rest of the database.
 */
export function checkEdited(input: EditorCheckInput): EditorCheck {
	const files: DataFile[] = [{ path: input.path, text: input.text }, ...input.chain];
	const layout = checkLayout(files, input.evidence);
	const parsed = layout.files.find((f) => f.path === input.path);
	const data = parsed ? (parsed.data as AuthoringProfile) : null;

	const report = validateSources(layout.files, { schema: input.schema });
	// Database rules run below, against the whole database rather than this chain alone.
	const own = report.issues.filter((i) => !DATABASE_CODES.has(i.code));
	const issues: FileIssue[] = [...layout.issues, ...own];

	const id = typeof data?.id === 'string' ? data.id : undefined;
	const profile = id ? (report.profiles.get(id) ?? null) : null;
	if (profile) {
		const database = [...input.others.filter((p) => p.id !== profile.id), profile];
		for (const issue of checkDatabase(database)) {
			if (issue.profileId !== profile.id) continue;
			const target = profile.meta.replacedBy;
			if (issue.code === 'replaced-by-missing' && target && input.knownIds?.has(target)) continue;
			issues.push({ ...issue, file: input.path });
		}
	}

	const lined = withLines(issues, files);
	const byLine = (a: FileIssue, b: FileIssue) => (a.line ?? 0) - (b.line ?? 0);
	return {
		issues: lined.filter((i) => i.file === input.path).sort(byLine),
		chainIssues: lined.filter((i) => i.file !== input.path),
		profile: issues.some((i) => i.file === input.path && i.severity === 'error') ? null : profile,
		data
	};
}

const DATABASE_CODES = new Set<string>(['duplicate-id', 'replaced-by-missing', 'match-collision']);

/** Top-level keys in the order the repository's files use (SPEC §2, §11). */
const KEY_ORDER = [
	'$schema',
	'extends',
	'abstract',
	'id',
	'schemaVersion',
	'kind',
	'device',
	'engine',
	'match',
	'bandCount',
	'band',
	'bands',
	'rules',
	'preamp',
	'channels',
	'protocol',
	'meta'
];
const META_ORDER = ['status', 'replacedBy', 'sources', 'contributors', 'notes'];
const SOURCE_ORDER = ['kind', 'ref', 'firmware', 'date', 'by'];

function ordered<T extends object>(value: T, order: readonly string[]): T {
	const rank = (k: string) => {
		const i = order.indexOf(k);
		return i === -1 ? order.length : i;
	};
	const keys = Object.keys(value).sort((a, b) => rank(a) - rank(b));
	return Object.fromEntries(keys.map((k) => [k, value[k as keyof T]])) as T;
}

/** The file's keys in the repository's usual order; nested values are left as they are. */
export function orderKeys(data: AuthoringProfile): AuthoringProfile {
	const out = ordered(data, KEY_ORDER);
	if (out.meta && typeof out.meta === 'object') {
		const meta = ordered(out.meta, META_ORDER);
		if (Array.isArray(meta.sources)) {
			meta.sources = meta.sources.map((s) =>
				s && typeof s === 'object' ? ordered(s, SOURCE_ORDER) : s
			);
		}
		out.meta = meta;
	}
	return out;
}

/**
 * The file as the repository formats it: Prettier over compact JSON, with the repository's
 * options (.prettierrc), so `npm run lint` passes on the submitted file. Loads Prettier lazily.
 */
export async function formatAuthoring(data: AuthoringProfile): Promise<string> {
	const [prettier, babel, estree] = await Promise.all([
		import('prettier/standalone'),
		import('prettier/plugins/babel'),
		import('prettier/plugins/estree')
	]);
	return prettier.format(JSON.stringify(orderKeys(data)), {
		parser: 'json',
		plugins: [babel, estree],
		useTabs: true,
		printWidth: 100,
		endOfLine: 'lf'
	});
}

export interface DiffLine {
	op: ' ' | '+' | '-';
	text: string;
}

/**
 * Line diff of two texts (longest common subsequence over the lines between the common prefix
 * and suffix). Past ~4M cells it gives up on alignment and shows the middle as replaced.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
	const a = before.split('\n');
	const b = after.split('\n');
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	const out: DiffLine[] = a.slice(0, start).map((text) => ({ op: ' ', text }));

	const n = midA.length;
	const m = midB.length;
	if (n * m > 4_000_000) {
		out.push(...midA.map((text) => ({ op: '-' as const, text })));
		out.push(...midB.map((text) => ({ op: '+' as const, text })));
	} else {
		// lcs[i][j]: length of the LCS of midA[i:] and midB[j:].
		const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				lcs[i]![j] =
					midA[i] === midB[j]
						? lcs[i + 1]![j + 1]! + 1
						: Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && midA[i] === midB[j]) {
				out.push({ op: ' ', text: midA[i]! });
				i++;
				j++;
			} else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
				out.push({ op: '-', text: midA[i++]! });
			} else {
				out.push({ op: '+', text: midB[j++]! });
			}
		}
	}
	out.push(...a.slice(endA).map((text) => ({ op: ' ' as const, text })));
	return out;
}

/** Only the changed lines and `context` lines around them; null entries mark skipped runs. */
export function diffHunks(diff: readonly DiffLine[], context = 3): (DiffLine | null)[] {
	const keep = diff.map(() => false);
	diff.forEach((d, i) => {
		if (d.op === ' ') return;
		for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) {
			keep[k] = true;
		}
	});
	const out: (DiffLine | null)[] = [];
	diff.forEach((d, i) => {
		if (keep[i]) out.push(d);
		else if (out.length === 0 || out.at(-1) !== null) out.push(null);
	});
	return out;
}

/** GitHub ignores longer URLs, or rejects them, in practice (INSPECTOR §2 T4). */
export const MAX_URL_LENGTH = 8000;

export interface Submission {
	/** The page to open on GitHub. */
	url: string;
	/** The file's text could not travel in the URL: the user pastes it (it is on the clipboard). */
	paste: boolean;
}

/**
 * A pull request without any backend (INSPECTOR §2 T4). A new file opens GitHub's "new file" page
 * with the text filled in; GitHub forks for people who can't write to the repository and offers
 * to propose the file. An existing file opens its edit page, where the user pastes the text.
 */
export function pullRequestUrl(path: string, text: string, exists: boolean): Submission {
	if (exists) return { url: `${REPO_URL}/edit/main/${path}`, paste: true };
	const dir = path.slice(0, path.lastIndexOf('/'));
	const url = new URL(`${REPO_URL}/new/main/${dir}`);
	url.searchParams.set('filename', path.slice(dir.length + 1));
	url.searchParams.set('value', text);
	if (url.href.length <= MAX_URL_LENGTH) return { url: url.href, paste: false };
	url.searchParams.delete('value');
	return { url: url.href, paste: true };
}

/** A "New device" issue with the profile in it, the route without a fork (or for evidence files). */
export function profileIssueUrl(fields: {
	device: string;
	identity: string;
	text: string;
	evidence: string;
}): Submission {
	const url = new URL(`${REPO_URL}/issues/new`);
	url.searchParams.set('template', 'new-device.yml');
	url.searchParams.set('title', `New device: ${fields.device}`);
	url.searchParams.set('device', fields.device);
	if (fields.identity) url.searchParams.set('identity', fields.identity);
	url.searchParams.set('evidence', fields.evidence);
	const eq = `Profile written with the eqcaps inspector:\n\n\`\`\`json\n${fields.text}\`\`\`\n`;
	url.searchParams.set('eq', eq);
	if (url.href.length <= MAX_URL_LENGTH) return { url: url.href, paste: false };
	url.searchParams.set('eq', 'The profile is on my clipboard; pasting it here.');
	return { url: url.href, paste: true };
}

/**
 * A blank hardware profile, in authoring form, for `path` (authoringPath) to be derived from. A
 * file that extends a base inherits `schemaVersion` and `kind` from it (SPEC §11).
 */
export function blankProfile(options: { extends?: string; kind?: 'hardware' | 'software' } = {}) {
	const kind = options.kind ?? 'hardware';
	const data: Record<string, unknown> = {
		$schema: '../../../schema/v1/source.schema.json',
		...(options.extends ? { extends: options.extends } : {}),
		id: '',
		...(options.extends ? {} : { schemaVersion: '1.0', kind }),
		device: { brand: '', model: '' },
		...(kind === 'hardware' ? { match: { usb: [] } } : {})
	};
	if (!options.extends) {
		Object.assign(data, {
			bandCount: kind === 'hardware' ? 10 : null,
			band: {
				types: ['PK', 'LSC', 'HSC'],
				freq: { min: 20, max: 20000, step: 1 },
				q: { min: 0.1, max: 10, step: 0.01 },
				gain: { min: -12, max: 12, step: 0.1 }
			},
			preamp: { mode: 'unknown' }
		});
	}
	data.meta = { status: 'draft', sources: [] };
	return data as unknown as AuthoringProfile;
}

/** `$schema` for a file at `path`, as the layout rule wants it. */
export function schemaRef(path: string): string {
	return `${'../'.repeat(path.split('/').length - 1)}schema/v1/source.schema.json`;
}

/** Sets `$schema` for the file's location and keeps it the first key. */
export function withSchemaRef(data: AuthoringProfile, path: string): AuthoringProfile {
	return { ...data, $schema: schemaRef(path) } as AuthoringProfile;
}
