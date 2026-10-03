import { describe, expect, it } from 'vitest';
import {
	applyEdits,
	evidencePath,
	evidenceText,
	readEvidence,
	readSource,
	stringFields,
	today
} from './evidence.ts';

const report = () =>
	readEvidence({
		transport: 'hid',
		identity: { usb: { vendorId: '0x2972', productId: '0x0093', productName: 'FIIO KA17' } },
		handler: 'fiio-usb-hid',
		experimental: false,
		profile: 'fiio-ka17',
		pull: {
			filters: [{ type: 'PK', freq: 1000, q: 1.41, gain: -3 }, null],
			preamp: -2,
			slot: 3
		},
		findings: ['Slot 1: q 1.41 is off the grid'],
		commit: 'abc1234',
		userAgent: 'Mozilla/5.0',
		date: '2026-10-03'
	});

describe('readEvidence', () => {
	it('records the device, the handler and what was read', () => {
		const r = report();
		expect(r.device).toEqual({
			transport: 'hid',
			vendorId: '0x2972',
			productId: '0x0093',
			productName: 'FIIO KA17'
		});
		expect(r.experiments).toEqual([
			{
				id: 'read',
				readBack: {
					filters: [{ type: 'PK', freq: 1000, q: 1.41, gain: -3 }, null],
					preamp: -2,
					slot: 3
				},
				findings: ['Slot 1: q 1.41 is off the grid']
			}
		]);
		expect(r).not.toHaveProperty('experimental');
		expect(r.caveats.length).toBeGreaterThan(0);
	});

	it('lists every string, personal ones marked, for review', () => {
		const fields = stringFields(report());
		const personal = fields.filter((f) => f.personal).map((f) => f.pointer);
		expect(personal).toEqual(['/tool/userAgent', '/device/productName']);
		expect(fields.map((f) => f.pointer)).toContain('/experiments/0/findings/0');
	});

	it('applies redactions and edits', () => {
		const edited = applyEdits(
			report(),
			new Map([
				['/tool/userAgent', ''],
				['/device/productName', 'FIIO KA17 (edited)'],
				['/caveats/0', '']
			])
		);
		expect(edited.tool).toEqual({ name: 'eqcaps inspector', commit: 'abc1234' });
		expect(edited.device.productName).toBe('FIIO KA17 (edited)');
		expect(edited.caveats[0]).toBe('redacted');
		expect(report().tool.userAgent).toBe('Mozilla/5.0');
	});
});

describe('evidence files', () => {
	it('are named by date and content hash', async () => {
		const text = evidenceText(report());
		expect(text.endsWith('}\n')).toBe(true);
		const path = await evidencePath('fiio-ka17', '2026-10-03', text);
		expect(path).toMatch(/^evidence\/fiio-ka17\/2026-10-03-[0-9a-f]{6}\.json$/);
		expect(await evidencePath('fiio-ka17', '2026-10-03', text)).toBe(path);
		expect(await evidencePath('fiio-ka17', '2026-10-03', `${text} `)).not.toBe(path);
	});

	it('are cited as community sources', () => {
		expect(readSource('evidence/x/y.json', '2026-10-03', 'octocat', '1.4')).toEqual({
			kind: 'community',
			ref: 'evidence/x/y.json',
			firmware: '1.4',
			date: '2026-10-03',
			by: 'octocat'
		});
		expect(readSource('evidence/x/y.json', '2026-10-03')).toEqual({
			kind: 'community',
			ref: 'evidence/x/y.json',
			date: '2026-10-03'
		});
		expect(today(new Date(2026, 0, 5))).toBe('2026-01-05');
	});
});
