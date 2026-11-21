import { describe, expect, it } from 'vitest';
import type { DataIndex } from '@potatosalad775/eqcaps-core';
import { matchDevice, type FetchLike } from '@potatosalad775/eqcaps-client';
import { sampleConsumer } from '../../../scripts/sample-consumer.ts';
import { publish, readConformance, validateRepository, loadSchemas } from '../src/node.ts';
import { formatText } from '../src/report.ts';

// The database in data/ as CI sees it, and what consumers get from it.

const repo = validateRepository();

describe('data/', () => {
	it('has no issues', () => {
		expect(formatText(repo.issues)).toBe('');
	});

	it('publishes every non-abstract file', () => {
		const abstract = repo.files.filter((f) => f.path.startsWith('data/bases/')).length;
		expect(repo.profiles.size).toBe(repo.files.length - abstract);
	});

	// An app translates a control by its role, so one left without shows the vendor's English
	// label in every language. A new control takes a role (a new one in SPEC §9.1 if none fits),
	// or a line here when the setting is one only its vendor has.
	const VENDOR_SETTINGS: Record<string, string> = {
		'walkplay-hid:dre': "Tanchjim's name for its own processing",
		'topping-usb-hid:lineMode': "whether the DX5 II's line outputs follow the volume"
	};

	it('gives every control a role, or lists it as a vendor setting', () => {
		const seen = new Set<string>();
		const missing = new Set<string>();
		for (const profile of repo.profiles.values()) {
			for (const control of profile.protocol?.controls ?? []) {
				const key = `${profile.protocol!.handler}:${control.id}`;
				if (control.role) seen.add(key);
				else if (!(key in VENDOR_SETTINGS)) missing.add(`${profile.id} ${key}`);
			}
		}
		expect([...missing]).toEqual([]);
		// A control that took a role leaves the list.
		expect(Object.keys(VENDOR_SETTINGS).filter((key) => seen.has(key))).toEqual([]);
	});
});

describe('published data', () => {
	const artifacts = new Map(
		publish({
			profiles: repo.profiles.values(),
			schema: loadSchemas().profile,
			conformance: readConformance(),
			dataVersion: '2026.10.02-test',
			generatedAt: '2026-10-02T00:00:00.000Z'
		}).map((a) => [a.path, a.content])
	);
	const fetch: FetchLike = async (url) => {
		const body = artifacts.get(url.replace('https://data/', ''));
		return {
			status: body === undefined ? 404 : 200,
			ok: body !== undefined,
			headers: { get: () => null },
			text: async () => body ?? ''
		};
	};

	it('indexes every profile', () => {
		const index = JSON.parse(artifacts.get('index.json')!) as DataIndex;
		expect(index.profiles.map((e) => e.id)).toEqual([...repo.profiles.keys()].sort());
	});

	it('resolves a device that a group also lists to its own profile (SPEC §3)', () => {
		const index = JSON.parse(artifacts.get('index.json')!) as DataIndex;
		// The Rays is matched by 0x35d8:0x011b, a pair the SchemeNo13 group lists too.
		const identity = { usb: { vendorId: '0x35d8', productId: '0x011b' } };
		const result = matchDevice(index.profiles, identity);
		expect(result.matches.map((m) => m.id)).toContain('walkplay-schemeno13-devices');
		expect(result).toMatchObject({ best: { id: 'moondrop-rays' }, ambiguous: false });
	});

	it('serves the sample consumer: fetch, match, validate, fit', async () => {
		const errors: unknown[] = [];
		const result = await sampleConsumer({
			baseUrl: 'https://data/',
			fetch,
			onError: (e) => errors.push(e)
		});
		expect(errors).toEqual([]);
		expect(result?.id).toBe('fiio-ka17');
		// 3150.55 Hz is off the KA17's 1 Hz grid and -14 dB is outside its ±12 dB.
		expect(result?.problems.map((v) => `${v.filter}:${v.field}:${v.code}`)).toEqual([
			'1:freq:off-grid',
			'1:gain:out-of-range'
		]);
		expect(result?.written.feasible).toBe(true);
		expect(result?.slots).toHaveLength(10);
	});
});
