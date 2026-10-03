// SPEC §12 examples, for the inspector's unit tests.
import { readFileSync } from 'node:fs';
import type { Profile } from '@potatosalad775/eqcaps-core';

export function example(name: string): Profile {
	const url = new URL(`../../../../conformance/v1/profiles/examples/${name}.json`, import.meta.url);
	return JSON.parse(readFileSync(url, 'utf8')) as Profile;
}
