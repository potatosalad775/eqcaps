// The smallest useful eqcaps consumer: find the profile for a connected device, check the user's
// filters against it, and fit them for writing. Run against the published data:
//
//   node --conditions=eqcaps:source scripts/sample-consumer.ts [baseUrl]

import { fileURLToPath } from 'node:url';
import { createClient, type ClientOptions } from '@potatosalad775/eqcaps-client';
import { complete, fit, validateList, type Filter } from '@potatosalad775/eqcaps-core';

export async function sampleConsumer(options: ClientOptions = {}) {
	const client = createClient(options);
	// What WebHID reports for a FiiO KA17.
	const device = { usb: { vendorId: 0x2972, productId: 0x0093, productName: 'FIIO KA17' } };
	const { best } = await client.matchDevice(device);
	const profile = best && (await client.loadProfile(best.id));
	if (!profile) return null; // No match or offline: the app carries on without constraints.

	const wanted: Filter[] = [
		{ type: 'LSC', freq: 105, q: 0.7, gain: 6 },
		{ type: 'PK', freq: 3150.55, q: 2, gain: -14 }
	];
	const problems = validateList(profile, wanted); // soft path: flag while editing
	const written = fit(profile, wanted, 0); // hard path: what to send
	return { id: profile.id, problems, written, slots: complete(profile, written.slots).filters };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const baseUrl = process.argv[2];
	console.dir(await sampleConsumer(baseUrl ? { baseUrl } : {}), { depth: 4 });
}
