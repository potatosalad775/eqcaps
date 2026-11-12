// Keeps the Walkplay group profiles' `match.usb` in step with the product catalog Walkplay's own
// Android app downloads: a list of real vendor/product id pairs, each with the SchemeNo the app
// drives it with.
//
// The snapshot, data/catalogs/walkplay.json, is refreshed by the maintainer with a script kept
// outside this repository (D52), which writes that file. This script only applies it: it reads the
// snapshot and rewrites every data/profiles/walkplay/walkplay-schemeno<N>-devices.json.
// `match.usb` is generated from the snapshot's rows of scheme N plus the `extra` entries of N
// (hand-kept match entries the catalog doesn't list), and the catalog is put first in
// `meta.sources`. Everything else in those files is left alone.
//
// Usage: node --conditions=eqcaps:source scripts/walkplay-catalog.ts [--check]
// With --check nothing is written; the script fails if a group profile differs from what it would
// write, or if the snapshot is missing.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthoringProfile, AuthoringSource, UsbMatch } from '@potatosalad775/eqcaps-core';
import { formatAuthoring } from '../apps/inspector/src/lib/editor.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const CATALOG_PATH = join(root, 'data/catalogs/walkplay.json');
const GROUP_DIR = join(root, 'data/profiles/walkplay');
const GROUP_FILE = /^walkplay-schemeno(\d+)-devices\.json$/;

/** The id pattern of a usable catalog row (SPEC §3: lowercase 4-digit hex). */
const USB_ID = /^0x[0-9a-f]{4}$/;
/** A product id the catalog carries as a test placeholder. */
const TEST_PRODUCT_ID = '0xeeee';

/** The `ref` of the source `apply` puts first in a group's `meta.sources`. */
export const CATALOG_REF =
	'Walkplay Android app 2.3.1 (com.ttgk.musicbox): its product catalog, kept in data/catalogs/walkplay.json';

export interface CatalogProduct {
	vendorId: string;
	productId: string;
	scheme: string;
	brand: string;
	model: string;
	title: string;
	updated: string;
}

/** A hand-kept match entry the catalog doesn't list. */
export interface CatalogExtra {
	scheme: string;
	vendorId: string[];
	productId: string[];
	note?: string;
}

export interface Catalog {
	source: string;
	fetched: string;
	extra: CatalogExtra[];
	products: CatalogProduct[];
}

export interface ProductDiff {
	added: CatalogProduct[];
	removed: CatalogProduct[];
	schemeChanged: { before: CatalogProduct; after: CatalogProduct }[];
	renamed: { before: CatalogProduct; after: CatalogProduct }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Compact JSON on one line, with a space after `:` and `,` and inside braces. */
function compact(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(compact).join(', ')}]`;
	if (isRecord(value)) {
		const entries = Object.entries(value).filter(([, v]) => v !== undefined);
		if (entries.length === 0) return '{}';
		return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${compact(v)}`).join(', ')} }`;
	}
	return JSON.stringify(value);
}

function rowList(rows: unknown[]): string {
	if (rows.length === 0) return '[]';
	return `[\n${rows.map((r) => `\t\t${compact(r)}`).join(',\n')}\n\t]`;
}

/** The snapshot file's text: one row of `extra` and `products` per line, so a refresh diffs by row. */
export function serializeCatalog(catalog: Catalog): string {
	return (
		[
			'{',
			`\t"source": ${JSON.stringify(catalog.source)},`,
			`\t"fetched": ${JSON.stringify(catalog.fetched)},`,
			`\t"extra": ${rowList(catalog.extra)},`,
			`\t"products": ${rowList(catalog.products)}`,
			'}'
		].join('\n') + '\n'
	);
}

function stringList(value: unknown, what: string): string[] {
	if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string')) {
		throw new Error(`${what} must be a non-empty list of strings`);
	}
	return value as string[];
}

/** Reads and checks a snapshot's text. */
export function parseCatalog(content: string): Catalog {
	const data: unknown = JSON.parse(content);
	if (!isRecord(data)) throw new Error('the catalog is not a JSON object');
	if (typeof data.source !== 'string' || typeof data.fetched !== 'string') {
		throw new Error('the catalog needs a "source" and a "fetched" string');
	}
	if (!Array.isArray(data.extra) || !Array.isArray(data.products)) {
		throw new Error('the catalog needs "extra" and "products" lists');
	}
	const extra = data.extra.map((e, i): CatalogExtra => {
		if (!isRecord(e) || typeof e.scheme !== 'string') {
			throw new Error(`extra[${i}] needs a "scheme" string`);
		}
		const out: CatalogExtra = {
			scheme: e.scheme,
			vendorId: stringList(e.vendorId, `extra[${i}].vendorId`),
			productId: stringList(e.productId, `extra[${i}].productId`)
		};
		if (typeof e.note === 'string') out.note = e.note;
		return out;
	});
	const products = data.products.map((p, i): CatalogProduct => {
		const keys = ['vendorId', 'productId', 'scheme', 'brand', 'model', 'title', 'updated'] as const;
		if (!isRecord(p) || !keys.every((k) => typeof p[k] === 'string')) {
			throw new Error(`products[${i}] needs ${keys.join(', ')} as strings`);
		}
		return Object.fromEntries(keys.map((k) => [k, p[k]])) as unknown as CatalogProduct;
	});
	return { source: data.source, fetched: data.fetched, extra, products };
}

/** Whether a row has a usable id pair: well-formed ids, and not the test placeholder. */
export function isUsable(product: CatalogProduct): boolean {
	return (
		USB_ID.test(product.vendorId) &&
		USB_ID.test(product.productId) &&
		product.productId !== TEST_PRODUCT_ID
	);
}

function collapse(ids: string[]): string | string[] {
	return ids.length === 1 ? (ids[0] ?? '') : ids;
}

/** The `match.usb` of scheme `scheme`'s group: catalog pairs by vendor, then the extra entries. */
export function groupMatch(catalog: Catalog, scheme: string): UsbMatch[] {
	const byVendor = new Map<string, Set<string>>();
	for (const p of catalog.products) {
		if (p.scheme !== scheme || !isUsable(p)) continue;
		let ids = byVendor.get(p.vendorId);
		if (!ids) byVendor.set(p.vendorId, (ids = new Set()));
		ids.add(p.productId);
	}
	const entries: UsbMatch[] = [...byVendor.keys()].sort(compareStrings).map((vendorId) => ({
		vendorId,
		productId: collapse([...(byVendor.get(vendorId) ?? [])].sort(compareStrings))
	}));
	for (const e of catalog.extra) {
		if (e.scheme !== scheme) continue;
		entries.push({
			vendorId: collapse([...e.vendorId].sort(compareStrings)),
			productId: collapse([...e.productId].sort(compareStrings))
		});
	}
	return entries;
}

function key(p: CatalogProduct): string {
	return `${p.vendorId}:${p.productId}`;
}

/** What changed between two snapshots' products, keyed by vendor and product id. */
export function diffProducts(before: CatalogProduct[], after: CatalogProduct[]): ProductDiff {
	const was = new Map(before.map((p) => [key(p), p]));
	const now = new Map(after.map((p) => [key(p), p]));
	const diff: ProductDiff = { added: [], removed: [], schemeChanged: [], renamed: [] };
	for (const [k, p] of now) {
		const old = was.get(k);
		if (!old) {
			diff.added.push(p);
			continue;
		}
		if (old.scheme !== p.scheme) diff.schemeChanged.push({ before: old, after: p });
		if (old.brand !== p.brand || old.model !== p.model || old.title !== p.title) {
			diff.renamed.push({ before: old, after: p });
		}
	}
	for (const [k, p] of was) if (!now.has(k)) diff.removed.push(p);
	return diff;
}

/** The group profile as `apply` writes it: `match.usb` generated, the catalog source first. */
export function applyToProfile(
	profile: AuthoringProfile,
	catalog: Catalog,
	scheme: string
): AuthoringProfile {
	if (!profile.meta) throw new Error(`${profile.id} has no meta`);
	const source: AuthoringSource = {
		kind: 'vendor-app',
		ref: CATALOG_REF,
		date: catalog.fetched
	};
	return {
		...profile,
		match: { ...profile.match, usb: groupMatch(catalog, scheme) },
		meta: {
			...profile.meta,
			sources: [source, ...profile.meta.sources.filter((s) => s.ref !== CATALOG_REF)]
		}
	};
}

function describe(p: CatalogProduct): string {
	return `${key(p)} scheme ${p.scheme}: ${p.brand} ${p.model} (${p.title})`;
}

/** The lines that report a diff between two snapshots, for the script that refreshes the file. */
export function formatDiff(diff: ProductDiff): string[] {
	const lines: string[] = [];
	for (const p of diff.added) lines.push(`  added    ${describe(p)}`);
	for (const p of diff.removed) lines.push(`  removed  ${describe(p)}`);
	for (const { before, after } of diff.schemeChanged) {
		lines.push(`  scheme   ${key(after)}: ${before.scheme} -> ${after.scheme}`);
	}
	for (const { before, after } of diff.renamed) {
		lines.push(
			`  renamed  ${key(after)}: ${before.brand} ${before.model} (${before.title})` +
				` -> ${after.brand} ${after.model} (${after.title})`
		);
	}
	const total = diff.added.length + diff.removed.length + diff.schemeChanged.length;
	if (total + diff.renamed.length === 0) {
		lines.push('no changes');
		return lines;
	}
	lines.push(
		`${diff.added.length} added, ${diff.removed.length} removed, ` +
			`${diff.schemeChanged.length} scheme changes, ${diff.renamed.length} renamed`
	);
	return lines;
}

interface GroupFile {
	path: string;
	rel: string;
	scheme: string;
	current: string;
	content: string;
}

async function planApply(catalog: Catalog): Promise<GroupFile[]> {
	const files = readdirSync(GROUP_DIR)
		.map((name) => ({ name, scheme: GROUP_FILE.exec(name)?.[1] }))
		.filter((f): f is { name: string; scheme: string } => f.scheme !== undefined)
		.sort((a, b) => Number(a.scheme) - Number(b.scheme));
	const groups = files.map((f) => f.scheme);
	const problems: string[] = [];
	for (const e of catalog.extra) {
		if (!groups.includes(e.scheme)) {
			problems.push(`an extra entry names scheme ${e.scheme}, which has no group profile`);
		}
	}
	const out: GroupFile[] = [];
	for (const { name, scheme } of files) {
		const path = join(GROUP_DIR, name);
		const rel = relative(root, path).replaceAll('\\', '/');
		const current = readFileSync(path, 'utf8');
		const profile = applyToProfile(JSON.parse(current) as AuthoringProfile, catalog, scheme);
		if (!profile.match?.usb?.length) {
			problems.push(`${rel} would have no match entries`);
		}
		out.push({
			path,
			rel,
			scheme,
			current,
			content: await formatAuthoring(profile)
		});
	}
	if (problems.length) throw new Error(problems.join('\n'));
	return out;
}

function printSummary(catalog: Catalog, files: GroupFile[]) {
	const groups = new Set(files.map((f) => f.scheme));
	for (const f of files) {
		const pairs = catalog.products.filter((p) => p.scheme === f.scheme && isUsable(p)).length;
		const extra = catalog.extra.filter((e) => e.scheme === f.scheme).length;
		console.log(`scheme ${f.scheme}: ${pairs} catalog pairs, ${extra} extra entries`);
	}
	const ungrouped = new Map<string, number>();
	const junk: CatalogProduct[] = [];
	for (const p of catalog.products) {
		if (!isUsable(p)) junk.push(p);
		else if (!groups.has(p.scheme)) ungrouped.set(p.scheme, (ungrouped.get(p.scheme) ?? 0) + 1);
	}
	const schemes = [...ungrouped].sort((a, b) => Number(a[0]) - Number(b[0]));
	if (schemes.length) {
		console.log(
			`schemes without a group profile: ${schemes.map(([s, n]) => `${s} (${n} rows)`).join(', ')}`
		);
	}
	if (junk.length) {
		console.log(`${junk.length} rows skipped as junk:`);
		for (const p of junk) console.log(`  ${describe(p)}`);
	}
}

async function apply(check: boolean) {
	if (!existsSync(CATALOG_PATH)) {
		throw new Error(`${relative(root, CATALOG_PATH).replaceAll('\\', '/')} is missing.`);
	}
	const catalog = parseCatalog(readFileSync(CATALOG_PATH, 'utf8'));
	const files = await planApply(catalog);
	let stale = false;
	for (const f of files) {
		if (f.current === f.content) continue;
		if (check) {
			console.error(`data:walkplay: ${f.rel} is out of date. Run \`npm run data:walkplay\`.`);
			stale = true;
		} else {
			writeFileSync(f.path, f.content);
			console.log(`data:walkplay: wrote ${f.rel}`);
		}
	}
	if (stale) process.exit(1);
	if (!check) printSummary(catalog, files);
}

async function main() {
	const args = process.argv.slice(2);
	if (args.some((a) => a !== '--check')) {
		console.error('Usage: walkplay-catalog.ts [--check]');
		process.exit(2);
	}
	try {
		await apply(args.includes('--check'));
	} catch (e) {
		console.error(`data:walkplay: ${(e as Error).message}`);
		process.exit(1);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
