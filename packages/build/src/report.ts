import { jsonLines, lineOf } from './locate.ts';
import type { DataFile } from './layout.ts';
import type { FileIssue } from './validate.ts';

/** Fills in `line` for each issue from the text of the file it was found in. */
export function withLines(issues: readonly FileIssue[], files: readonly DataFile[]): FileIssue[] {
	const texts = new Map(files.map((f) => [f.path, f.text]));
	const cache = new Map<string, Map<string, number> | null>();
	const linesOf = (file: string) => {
		if (!cache.has(file)) {
			const text = texts.get(file);
			let lines: Map<string, number> | null = null;
			try {
				if (text !== undefined) {
					JSON.parse(text);
					lines = jsonLines(text);
				}
			} catch {
				// json-invalid is reported on its own; its line is in the parser's message.
			}
			cache.set(file, lines);
		}
		return cache.get(file);
	};
	return issues.map((issue) => {
		const lines = linesOf(issue.file);
		return lines ? { ...issue, line: lineOf(lines, issue.path) } : issue;
	});
}

const order = (a: FileIssue, b: FileIssue) =>
	a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.path.localeCompare(b.path);

/**
 * Human-readable report, grouped by file:
 *
 *     data/profiles/fiio/fiio-qx13.json
 *       14  error  domain-off-grid  /band/gain/min: min -12.05 is not on its grid of 0.1
 */
export function formatText(issues: readonly FileIssue[]): string {
	const out: string[] = [];
	let file: string | undefined;
	for (const issue of [...issues].sort(order)) {
		if (issue.file !== file) {
			if (file !== undefined) out.push('');
			file = issue.file;
			out.push(file || '(database)');
		}
		const at = issue.path ? `${issue.path}: ` : '';
		const via = issue.profileId && !issue.file.endsWith(`/${issue.profileId}.json`);
		out.push(
			`  ${String(issue.line ?? '').padStart(4)}  ${issue.severity}  ${issue.code}  ${at}${issue.message}${via ? ` (flattened ${issue.profileId})` : ''}`
		);
	}
	return out.join('\n');
}

/** GitHub Actions workflow commands, so each issue shows up on its line in the PR diff. */
export function formatGithub(issues: readonly FileIssue[]): string {
	const data = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
	const prop = (s: string) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
	return [...issues]
		.sort(order)
		.map((issue) => {
			const props = [
				issue.file && `file=${prop(issue.file)}`,
				issue.line !== undefined && `line=${issue.line}`,
				`title=${prop(`eqcaps ${issue.code}`)}`
			].filter(Boolean);
			const at = issue.path ? `${issue.path}: ` : '';
			return `::${issue.severity} ${props.join(',')}::${data(`${at}${issue.message}`)}`;
		})
		.join('\n');
}
