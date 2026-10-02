import { describe, expect, it } from 'vitest';
import type { DataIndex } from '@potatosalad775/eqcaps-core';
import type { FetchLike } from '@potatosalad775/eqcaps-client';
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

	it('serves the sample consumer: fetch, match, validate, fit', async () => {
		const errors: unknown[] = [];
		const result = await sampleConsumer({
			baseUrl: 'https://data/',
			fetch,
			onError: (e) => errors.push(e)
		});
		expect(errors).toEqual([]);
		expect(result?.id).toBe('fiio-ka17');
		// 3150.55 Hz is off the KA17's 1 Hz grid and -14 dB is outside its ±12 dB. Its gainScaledQ
		// law turns the wanted Q 2 into a written Q of 2·10^(14/40) ≈ 4.477, off the 0.01 grid.
		expect(result?.problems.map((v) => `${v.filter}:${v.field}:${v.code}`)).toEqual([
			'1:freq:off-grid',
			'1:q:off-grid',
			'1:gain:out-of-range'
		]);
		expect(result?.written.feasible).toBe(true);
		expect(result?.slots).toHaveLength(10);
	});
});
