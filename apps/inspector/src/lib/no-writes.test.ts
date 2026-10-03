// Invariant 9 (D40): no code path in the inspector writes to a device. Devices are opened only
// through lib/device.ts, which hands out no `push` or `setEnabled`, and nothing else imports
// a way to write: the bridge's openDevice, its handlers (codecs encode writes) or raw transports.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openReadOnly } from './device.ts';

const SRC = new URL('..', import.meta.url).pathname;

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? files(join(dir, e.name))
			: /\.(ts|svelte)$/.test(e.name) && !e.name.endsWith('.test.ts')
				? [join(dir, e.name)]
				: []
	);
}

/** Names imported from the device bridge, by import statements (not sample code in strings). */
function bridgeImports(text: string): string[] {
	const re =
		/^\s*import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'@potatosalad775\/eqcaps-device-bridge(?:\/browser)?'/gm;
	return [...text.matchAll(re)].flatMap((m) =>
		m[1]!
			.split(',')
			.map(
				(s) =>
					s
						.trim()
						.replace(/^type\s+/, '')
						.split(/\s+as\s+/)[0]!
			)
			.filter(Boolean)
	);
}

const WRITERS = ['openDevice', 'HANDLERS', 'hidTransport', 'serialTransport', 'bleTransport'];
/** Calls that write, outside comments: the device's own and the transports'. */
const WRITE_CALLS = /\.(setEnabled|sendReport|sendFeatureReport|write)\(/;

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the inspector never writes to a device', () => {
	const sources = files(SRC).map((path) => ({
		path: relative(SRC, path),
		text: readFileSync(path, 'utf8')
	}));

	it('finds the sources', () => {
		expect(sources.map((s) => s.path)).toContain('routes/connect/+page.svelte');
		expect(sources.map((s) => s.path)).toContain('lib/components/GuidedRead.svelte');
	});

	it('imports nothing that writes, except lib/device.ts, which wraps openDevice', () => {
		for (const { path, text } of sources) {
			const allowed = path === 'lib/device.ts' ? ['openDevice'] : [];
			const writers = bridgeImports(text).filter(
				(n) => WRITERS.includes(n) && !allowed.includes(n)
			);
			expect(writers, path).toEqual([]);
		}
	});

	it('calls no write method of a device or transport', () => {
		for (const { path, text } of sources) {
			if (path === 'routes/docs/+page.svelte') continue; // sample code for apps, in strings
			expect(WRITE_CALLS.exec(strip(text))?.[0], path).toBeUndefined();
		}
	});

	it('opens devices without push or setEnabled', () => {
		const transport = {
			kind: 'hid' as const,
			vendorId: 0x3302,
			productId: 0xc20f,
			productName: 'Protocol Micro',
			collections: [],
			sendReport: async () => {},
			sendFeatureReport: async () => {},
			receiveFeatureReport: async () => new Uint8Array(),
			onInputReport: () => () => {},
			close: async () => {}
		};
		const device = openReadOnly(transport, { handler: 'walkplay-hid' } as never);
		expect(Object.keys(device).sort()).toEqual([
			'capabilities',
			'identity',
			'protocol',
			'pull',
			'transport'
		]);
	});
});
