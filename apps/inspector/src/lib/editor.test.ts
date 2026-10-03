import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AuthoringProfile, IndexEntry, Profile } from '@potatosalad775/eqcaps-core';
import { authoringPath, baseIds, extendsPath, loadChain } from './authoring.ts';
import {
	blankProfile,
	checkEdited,
	diffHunks,
	formatAuthoring,
	lineDiff,
	MAX_URL_LENGTH,
	orderKeys,
	profileIssueUrl,
	pullRequestUrl,
	schemaRef,
	withSchemaRef
} from './editor.ts';
import { schemaValidator } from './schemas.ts';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

function dataFiles(dir: string): string[] {
	return readdirSync(new URL(dir, root), { withFileTypes: true, recursive: true })
		.filter((d) => d.isFile() && d.name.endsWith('.json'))
		.map((d) => `${d.parentPath.slice(new URL(root).pathname.length)}/${d.name}`)
		.sort();
}

const files = [...dataFiles('data/bases'), ...dataFiles('data/profiles')];
const reader = async (path: string) => {
	try {
		return read(path);
	} catch {
		return null;
	}
};

const KA17 = 'data/profiles/fiio/fiio-ka17.json';
const ELEMENT = 'data/profiles/jds-labs/jds-labs-element-iv.json';
const entries: IndexEntry[] = [];
const check = (path: string, text: string, others: Profile[] = []) =>
	checkEdited({
		path,
		text,
		chain: [],
		others,
		evidence: new Set(),
		schema: schemaValidator()
	});

describe('formatAuthoring', () => {
	it('reproduces every file in data/ byte for byte', async () => {
		expect(files.length).toBeGreaterThan(100);
		for (const path of files) {
			const text = read(path);
			expect(await formatAuthoring(JSON.parse(text) as AuthoringProfile), path).toBe(text);
		}
	});

	it('puts keys in the repository order', () => {
		const data = { meta: { sources: [], status: 'draft' }, id: 'x', $schema: 's' };
		const out = orderKeys(data as unknown as AuthoringProfile);
		expect(Object.keys(out)).toEqual(['$schema', 'id', 'meta']);
		expect(Object.keys(out.meta)).toEqual(['status', 'sources']);
	});
});

describe('checkEdited', () => {
	it('passes a file from the repository, with the files it extends', async () => {
		const text = read(KA17);
		const chain = await loadChain(JSON.parse(text), entries, reader);
		expect(chain.map((f) => f.path)).toEqual([
			'data/bases/fiio-peq-10-band-12db-all-filters-7.json'
		]);
		const result = checkEdited({
			path: KA17,
			text,
			chain,
			others: [],
			evidence: new Set(),
			schema: schemaValidator()
		});
		expect(result.issues).toEqual([]);
		expect(result.profile?.id).toBe('fiio-ka17');
		expect(result.profile?.bandCount).toBe(10);
	});

	it('reports a missing base where the file names it', () => {
		const result = check(KA17, read(KA17));
		expect(result.profile).toBeNull();
		expect(result.issues.map((i) => i.code)).toContain('extends-missing');
		expect(result.issues[0]?.line).toBe(3);
	});

	it('reports issues with their lines, layout rules included', () => {
		const text = read(ELEMENT).replace('"max": 10 }', '"max": 10, "step": 0.3 }');
		const result = check('data/profiles/jds/jds-labs-element-iv.json', text);
		const codes = result.issues.map((i) => `${i.code}@${i.line}`);
		expect(codes).toContain('file-location@6');
		expect(result.issues.some((i) => i.code.startsWith('domain-') && i.line === 12)).toBe(true);
		expect(result.profile).toBeNull();
	});

	it('checks match collisions against the rest of the database', () => {
		const text = read(ELEMENT);
		const own = check(ELEMENT, text).profile!;
		const twin: Profile = { ...own, id: 'jds-labs-element-iv-copy' };
		const result = check(ELEMENT, text, [twin, own]);
		expect(result.issues.map((i) => i.code)).toEqual(['match-collision']);
		expect(result.issues[0]?.line).toBe(7);
	});

	it('reports invalid JSON', () => {
		const result = check(ELEMENT, '{ "id": ');
		expect(result.data).toBeNull();
		expect(result.issues.map((i) => i.code)).toEqual(['json-invalid']);
	});

	it('accepts a blank profile once it is filled in', async () => {
		const blank = blankProfile();
		blank.id = 'acme-dsp-1';
		blank.device = { brand: 'Acme', model: 'DSP 1' };
		blank.match = { usb: [{ vendorId: '0x1234', productId: '0x5678' }] };
		blank.meta.sources = [{ kind: 'community', ref: 'my own testing', date: '2026-10-03' }];
		const path = authoringPath(blank);
		expect(path).toBe('data/profiles/acme/acme-dsp-1.json');
		const text = await formatAuthoring(blank);
		expect(check(path, text).issues).toEqual([]);
	});
});

describe('authoring paths', () => {
	it('places bases, profiles and their extends targets', () => {
		expect(authoringPath({ id: 'x', abstract: true })).toBe('data/bases/x.json');
		expect(authoringPath({ id: 'jds-labs-element-iv', device: { brand: 'JDS Labs' } })).toBe(
			'data/profiles/jds-labs/jds-labs-element-iv.json'
		);
		const entry = { id: 'fiio-k13', brand: 'FiiO' } as IndexEntry;
		expect(extendsPath('fiio-k13', [entry])).toBe('data/profiles/fiio/fiio-k13.json');
		expect(extendsPath('fiio-peq', [entry])).toBe('data/bases/fiio-peq.json');
		expect(schemaRef('data/bases/x.json')).toBe('../../schema/v1/source.schema.json');
		const moved = withSchemaRef(
			{ id: 'x', abstract: true } as AuthoringProfile,
			'data/bases/x.json'
		);
		expect(moved.$schema).toBe('../../schema/v1/source.schema.json');
	});

	it('finds base ids through inherited sources', () => {
		const p = (id: string, via?: string) =>
			({
				id,
				meta: { sources: [{ kind: 'community', ref: 'r', date: '2026-01-01', via }] }
			}) as unknown as Profile;
		expect(baseIds([p('a', 'base-1'), p('b', 'a'), p('c')])).toEqual(['base-1']);
	});
});

describe('lineDiff', () => {
	it('aligns unchanged lines and marks changes', () => {
		const diff = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
		expect(diff.map((d) => `${d.op}${d.text}`)).toEqual([' a', '-b', '+B', ' c', ' d', '+e']);
		expect(lineDiff('x', 'x')).toEqual([{ op: ' ', text: 'x' }]);
	});

	it('keeps context around changes only', () => {
		const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
		const after = before.replace('l10', 'L10');
		const hunks = diffHunks(lineDiff(before, after), 1);
		expect(hunks.map((d) => (d ? `${d.op}${d.text}` : '…'))).toEqual([
			'…',
			' l9',
			'-l10',
			'+L10',
			' l11',
			'…'
		]);
	});
});

describe('submission', () => {
	it('puts a new file in the URL', () => {
		const s = pullRequestUrl('data/profiles/acme/acme-x.json', '{"id":"acme-x"}\n', false);
		const url = new URL(s.url);
		expect(url.pathname).toBe('/potatosalad775/eqcaps/new/main/data/profiles/acme');
		expect(url.searchParams.get('filename')).toBe('acme-x.json');
		expect(url.searchParams.get('value')).toBe('{"id":"acme-x"}\n');
		expect(s.paste).toBe(false);
	});

	it('falls back to pasting when the file is too long or already exists', () => {
		const long = pullRequestUrl('data/profiles/a/a.json', 'x'.repeat(MAX_URL_LENGTH), false);
		expect(long.paste).toBe(true);
		expect(new URL(long.url).searchParams.has('value')).toBe(false);
		const edit = pullRequestUrl('data/profiles/a/a.json', '{}', true);
		expect(edit).toEqual({
			url: 'https://github.com/potatosalad775/eqcaps/edit/main/data/profiles/a/a.json',
			paste: true
		});
		const issue = profileIssueUrl({
			device: 'Acme X',
			identity: '',
			text: 'y'.repeat(MAX_URL_LENGTH),
			evidence: 'e'
		});
		expect(issue.paste).toBe(true);
	});
});
