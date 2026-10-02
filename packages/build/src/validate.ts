import {
	checkDatabase,
	flattenProfile,
	MAX_EXTENDS_DEPTH,
	validateProfile,
	type AuthoringProfile,
	type Issue,
	type Profile
} from '@potatosalad775/eqcaps-core';
import type { LayoutCode } from './layout.ts';
import type { SchemaValidator } from './schema.ts';

export interface AuthoringFile {
	/** Repository-relative path, used in reports. */
	path: string;
	data: unknown;
}

/** A format issue (ISSUE_CODES in core) found through an authoring file. */
export interface SourceIssue extends Issue {
	/** The authoring file the issue was found through. */
	file: string;
}

/** Any issue about a file under data/: a format rule or a repository layout rule (LAYOUT_CODES). */
export interface FileIssue extends Omit<Issue, 'code'> {
	code: Issue['code'] | LayoutCode;
	file: string;
	/** 1-based line in that file, when known. */
	line?: number;
}

export interface SourcesReport {
	issues: SourceIssue[];
	/** Flattened profiles that passed every check, keyed by id. */
	profiles: Map<string, Profile>;
}

export interface ValidateSourcesOptions {
	schema: SchemaValidator;
}

/**
 * Validates a set of authoring files the way CI does:
 * authoring schema → flatten `extends` → published schema → semantic rules → database rules.
 * A file that fails its schema is reported once and its descendants are not checked further,
 * so one broken base doesn't bury the report in follow-on errors.
 */
export function validateSources(
	files: readonly AuthoringFile[],
	options: ValidateSourcesOptions
): SourcesReport {
	const issues: SourceIssue[] = [];
	const add = (file: string, list: Issue[], profileId?: string) => {
		for (const issue of list) {
			issues.push({ ...issue, file, ...(profileId && !issue.profileId ? { profileId } : {}) });
		}
	};

	const byId = new Map<string, { file: AuthoringFile; data: AuthoringProfile }>();
	const broken = new Set<string>();
	for (const file of files) {
		const schemaIssues = options.schema.authoring(file.data);
		add(file.path, schemaIssues);
		const id = (file.data as { id?: unknown } | null)?.id;
		if (typeof id !== 'string') continue;
		if (schemaIssues.length > 0) broken.add(id);
		const prior = byId.get(id);
		if (prior) {
			add(file.path, [
				{
					code: 'duplicate-id',
					severity: 'error',
					path: '/id',
					message: `id "${id}" is also used by ${prior.file.path}`,
					profileId: id
				}
			]);
			continue;
		}
		byId.set(id, { file, data: file.data as AuthoringProfile });
	}

	const lookup = (id: string) => byId.get(id)?.data;
	const chainIsBroken = (start: AuthoringProfile) => {
		let cur: AuthoringProfile | undefined = start;
		for (let hops = 0; cur && hops <= MAX_EXTENDS_DEPTH + 1; hops++) {
			if (broken.has(cur.id)) return true;
			cur = cur.extends === undefined ? undefined : lookup(cur.extends);
		}
		return false;
	};

	const profiles = new Map<string, Profile>();
	const fileOf = new Map<string, string>();
	for (const [id, { file, data }] of byId) {
		if (data.abstract || chainIsBroken(data)) continue;
		const flat = flattenProfile(data, lookup);
		add(file.path, flat.issues);
		if (!flat.profile) continue;
		const schemaIssues = options.schema.published(flat.profile);
		add(file.path, schemaIssues, id);
		if (schemaIssues.length > 0) continue;
		const semantic = validateProfile(flat.profile);
		add(file.path, semantic, id);
		if (semantic.length > 0) continue;
		profiles.set(id, flat.profile);
		fileOf.set(id, file.path);
	}

	for (const issue of checkDatabase([...profiles.values()])) {
		add(fileOf.get(issue.profileId ?? '') ?? '', [issue]);
	}
	return { issues, profiles };
}
