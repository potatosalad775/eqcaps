import type { AuthoringProfile } from '@potatosalad775/eqcaps-core';
import type { AuthoringFile, FileIssue } from './validate.ts';

/**
 * Repository rules for files under data/. They are about where files live, not about the
 * format, so they have their own codes (the format's are ISSUE_CODES in core).
 */
export const LAYOUT_CODES = {
	'json-invalid': 'The file is not valid JSON.',
	'file-name': 'A profile or base file is not named <id>.json.',
	'file-location':
		'Profiles live in data/profiles/<brand>/ (brand slug of device.brand), abstract bases in data/bases/.',
	'schema-ref': '`$schema` must be the first key and point at schema/v1/source.schema.json.',
	'evidence-missing': 'A probe or measurement source refers to a file missing from data/evidence/.'
} as const;

export type LayoutCode = keyof typeof LAYOUT_CODES;

export interface DataFile {
	/** Repository-relative path with forward slashes, e.g. data/profiles/fiio/fiio-qx13.json. */
	path: string;
	text: string;
}

export interface LayoutResult {
	/** Files that parsed, ready for validateSources. */
	files: AuthoringFile[];
	issues: FileIssue[];
}

/** `fiio`, `jds-labs`, `ddhifi`: the directory a brand's profiles live in. */
export function brandSlug(brand: string): string {
	return brand
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Checks the layout of data/: data/profiles/<brand>/<id>.json and data/bases/<id>.json, `$schema`
 * first, evidence files present. `evidence` holds the paths under data/ that exist, such as
 * `evidence/fiio-qx13/2026-10-12-9f3e.json`.
 */
export function checkLayout(
	files: readonly DataFile[],
	evidence: ReadonlySet<string>
): LayoutResult {
	const parsed: AuthoringFile[] = [];
	const issues: FileIssue[] = [];
	const add = (file: string, code: LayoutCode, path: string, message: string) =>
		issues.push({ code, severity: 'error', path, message, file });

	for (const { path: file, text } of files) {
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch (e) {
			add(file, 'json-invalid', '', (e as Error).message);
			continue;
		}
		parsed.push({ path: file, data });
		if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
		const profile = data as Partial<AuthoringProfile> & { $schema?: unknown };

		const parts = file.split('/');
		const inBases = parts.length === 3 && parts[1] === 'bases';
		const inProfiles = parts.length === 4 && parts[1] === 'profiles';
		const name = parts.at(-1)?.replace(/\.json$/, '');

		if (typeof profile.id === 'string' && name !== profile.id) {
			add(file, 'file-name', '/id', `file is named ${name}.json but its id is "${profile.id}"`);
		}
		if (profile.abstract === true && !inBases) {
			add(file, 'file-location', '/abstract', 'abstract bases belong in data/bases/');
		} else if (profile.abstract !== true && inBases) {
			add(file, 'file-location', '', 'files in data/bases/ must be abstract ("abstract": true)');
		} else if (!inBases && !inProfiles) {
			add(file, 'file-location', '', 'profiles belong in data/profiles/<brand>/<id>.json');
		} else if (inProfiles && typeof profile.device?.brand === 'string') {
			const slug = brandSlug(profile.device.brand);
			if (parts[2] !== slug) {
				add(
					file,
					'file-location',
					'/device/brand',
					`brand "${profile.device.brand}" belongs in data/profiles/${slug}/`
				);
			}
		}

		const schemaRef = `${'../'.repeat(parts.length - 1)}schema/v1/source.schema.json`;
		if (Object.keys(profile)[0] !== '$schema' || profile.$schema !== schemaRef) {
			add(file, 'schema-ref', '/$schema', `start the file with "$schema": "${schemaRef}"`);
		}

		const sources = [
			...(profile.meta?.sources ?? []).map((s, i) => [s, `/meta/sources/${i}/ref`] as const),
			...(profile.realization?.sources ?? []).map(
				(s, i) => [s, `/realization/sources/${i}/ref`] as const
			)
		];
		for (const [source, pointer] of sources) {
			if (source.kind !== 'probe' && source.kind !== 'measurement') continue;
			if (source.ref?.startsWith('evidence/') && !evidence.has(source.ref)) {
				add(file, 'evidence-missing', pointer, `data/${source.ref} does not exist`);
			}
		}
	}
	return { files: parsed, issues };
}
