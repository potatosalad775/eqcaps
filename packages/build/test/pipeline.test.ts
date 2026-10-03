import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DataIndex, Profile } from '@potatosalad775/eqcaps-core';
import { checkLayout, type DataFile } from '../src/layout.ts';
import { jsonLines, lineOf } from '../src/locate.ts';
import { loadSchemas } from '../src/node.ts';
import { publish } from '../src/publish.ts';
import { formatGithub, formatText, withLines } from '../src/report.ts';
import { createSchemaValidator } from '../src/schema.ts';
import { validateSources } from '../src/validate.ts';

const SOURCE = '../../../schema/v1/source.schema.json';

const profile = (id: string, extra: object = {}) => ({
	$schema: SOURCE,
	schemaVersion: '1.0',
	id,
	kind: 'hardware',
	device: { brand: 'Acme Audio', model: id },
	match: { usb: [{ vendorId: '0x1234', productName: id }] },
	bandCount: 2,
	band: {
		types: ['PK'],
		freq: { min: 20, max: 20000 },
		q: { min: 0.1, max: 10 },
		gain: { min: -12, max: 12 }
	},
	preamp: { mode: 'unknown' },
	meta: { status: 'draft', sources: [{ kind: 'community', ref: 'test', date: '2026-10-02' }] },
	...extra
});

const file = (path: string, data: object): DataFile => ({
	path,
	text: `${JSON.stringify(data, null, '\t')}\n`
});

describe('jsonLines', () => {
	const text =
		'{\n\t"a": 1,\n\t"b": {\n\t\t"c/d": [\n\t\t\t5,\n\t\t\t{ "e": "x\\"y" }\n\t\t]\n\t}\n}';
	const lines = jsonLines(text);

	it('maps members to their key line and items to their value line', () => {
		expect(lines.get('')).toBe(1);
		expect(lines.get('/a')).toBe(2);
		expect(lines.get('/b/c~1d')).toBe(4);
		expect(lines.get('/b/c~1d/0')).toBe(5);
		expect(lines.get('/b/c~1d/1/e')).toBe(6);
	});

	it('falls back to the longest present prefix', () => {
		expect(lineOf(lines, '/b/c~1d/1/missing')).toBe(6);
		expect(lineOf(lines, '/nothing/here')).toBe(1);
	});
});

describe('checkLayout', () => {
	const codes = (files: DataFile[], evidence = new Set<string>()) =>
		checkLayout(files, evidence).issues.map((i) => `${i.code} ${i.path}`);

	it('accepts the conventional layout', () => {
		const base = { $schema: '../../schema/v1/source.schema.json', abstract: true, id: 'b' };
		expect(
			codes([
				file('data/profiles/acme-audio/x.json', profile('x')),
				file('data/bases/b.json', base)
			])
		).toEqual([]);
	});

	it('reports misplaced and misnamed files', () => {
		expect(codes([file('data/profiles/acme/x.json', profile('y'))])).toEqual([
			'file-name /id',
			'file-location /device/brand'
		]);
		expect(
			codes([
				file('data/bases/x.json', {
					...profile('x'),
					$schema: '../../schema/v1/source.schema.json'
				})
			])
		).toEqual(['file-location ']);
		expect(codes([file('data/x.json', profile('x'))])).toEqual([
			'file-location ',
			'schema-ref /$schema'
		]);
	});

	it('requires $schema first', () => {
		const { $schema: _s, ...rest } = profile('x');
		expect(codes([file('data/profiles/acme-audio/x.json', { ...rest, $schema: SOURCE })])).toEqual([
			'schema-ref /$schema'
		]);
	});

	it('requires evidence files to exist', () => {
		const sources = [{ kind: 'measurement', ref: 'evidence/x/a.json', date: '2026-10-02' }];
		const p = profile('x', { meta: { status: 'draft', sources } });
		const f = [file('data/profiles/acme-audio/x.json', p)];
		expect(codes(f)).toEqual(['evidence-missing /meta/sources/0/ref']);
		expect(codes(f, new Set(['evidence/x/a.json']))).toEqual([]);
	});

	it('reports invalid JSON and keeps going', () => {
		const result = checkLayout(
			[
				{ path: 'data/profiles/a/x.json', text: '{' },
				file('data/profiles/acme-audio/x.json', profile('x'))
			],
			new Set()
		);
		expect(result.issues.map((i) => i.code)).toEqual(['json-invalid']);
		expect(result.files).toHaveLength(1);
	});
});

describe('reports', () => {
	const schema = createSchemaValidator(loadSchemas());
	const bad = profile('x', {
		band: {
			types: ['PK'],
			freq: { min: 20, max: 20000 },
			q: { min: 0.1, max: 10 },
			gain: { min: -12.05, max: 12, step: 0.1 }
		}
	});
	const files = [file('data/profiles/acme-audio/x.json', bad)];
	const issues = withLines(
		validateSources(checkLayout(files, new Set()).files, { schema }).issues,
		files
	);

	it('locates semantic issues on their line', () => {
		expect(issues).toMatchObject([
			{ code: 'domain-off-grid', path: '/band/gain/min', file: 'data/profiles/acme-audio/x.json' }
		]);
		const line = files[0]!.text.split('\n').findIndex((l) => l.includes('-12.05')) + 1;
		expect(issues[0]!.line).toBe(line);
	});

	it('formats text and GitHub annotations', () => {
		expect(formatText(issues)).toMatch(
			/^data\/profiles\/acme-audio\/x\.json\n\s+\d+ {2}error {2}domain-off-grid {2}\/band\/gain\/min: /
		);
		expect(formatGithub(issues)).toMatch(
			/^::error file=data\/profiles\/acme-audio\/x\.json,line=\d+,title=eqcaps domain-off-grid::\/band\/gain\/min: /
		);
	});
});

describe('publish', () => {
	const flat = (id: string, status = 'draft') => {
		const { $schema: _s, ...p } = profile(id);
		return {
			...p,
			meta: { ...p.meta, status, ...(status === 'deprecated' ? { replacedBy: 'a' } : {}) }
		} as unknown as Profile;
	};
	const artifacts = publish({
		profiles: [flat('b', 'deprecated'), flat('a')],
		schema: { title: 's' },
		conformance: [{ path: 'fit.json', content: '{}\n' }],
		dataVersion: '2026.10.02-abc1234',
		generatedAt: '2026-10-02T00:00:00.000Z'
	});
	const byPath = new Map(artifacts.map((a) => [a.path, a.content]));

	it('writes every artifact of SPEC §14', () => {
		expect([...byPath.keys()]).toEqual([
			'profiles/a.json',
			'profiles/b.json',
			'index.json',
			'bundle.json',
			'schema/profile.schema.json',
			'conformance/fit.json'
		]);
	});

	it('indexes every profile with its hash, and bundles the live ones', () => {
		const index = JSON.parse(byPath.get('index.json')!) as DataIndex;
		expect(index).toMatchObject({ schemaVersion: '1.0', dataVersion: '2026.10.02-abc1234' });
		const a = byPath.get('profiles/a.json')!;
		expect(index.profiles[0]).toEqual({
			id: 'a',
			kind: 'hardware',
			brand: 'Acme Audio',
			model: 'a',
			status: 'draft',
			match: { usb: [{ vendorId: '0x1234', productName: 'a' }] },
			path: 'profiles/a.json',
			sha256: createHash('sha256').update(a).digest('hex'),
			bytes: Buffer.byteLength(a)
		});
		expect(index.profiles[1]).toMatchObject({ id: 'b', status: 'deprecated', replacedBy: 'a' });
		const bundle = JSON.parse(byPath.get('bundle.json')!) as { profiles: Profile[] };
		expect(bundle.profiles.map((p) => p.id)).toEqual(['a']);
	});

	it('marks group profiles in the index', () => {
		const g = flat('g');
		const group = { ...g, device: { ...g.device, group: true } } as Profile;
		const [entry] = (
			JSON.parse(
				publish({
					profiles: [group],
					schema: {},
					conformance: [],
					dataVersion: 'v',
					generatedAt: 't'
				}).find((x) => x.path === 'index.json')!.content
			) as DataIndex
		).profiles;
		expect(entry).toMatchObject({ id: 'g', group: true });
		expect(JSON.parse(byPath.get('index.json')!).profiles[0]).not.toHaveProperty('group');
	});

	it('writes single-valued match entries for clients that predate lists', () => {
		const f = flat('f');
		const listed = {
			...f,
			match: { usb: [{ vendorId: ['0x0001', '0x0002'], productName: ['A', 'B'] }] }
		} as Profile;
		const out = publish({
			profiles: [listed],
			schema: {},
			conformance: [],
			dataVersion: 'v',
			generatedAt: 't',
			singleValuedMatch: true
		});
		const usb = [
			{ vendorId: '0x0001', productName: 'A' },
			{ vendorId: '0x0001', productName: 'B' },
			{ vendorId: '0x0002', productName: 'A' },
			{ vendorId: '0x0002', productName: 'B' }
		];
		const file = (path: string) => JSON.parse(out.find((x) => x.path === path)!.content);
		expect(file('profiles/f.json').match.usb).toEqual(usb);
		expect(file('index.json').profiles[0].match.usb).toEqual(usb);
		expect(file('bundle.json').profiles[0].match.usb).toEqual(usb);
	});
});
