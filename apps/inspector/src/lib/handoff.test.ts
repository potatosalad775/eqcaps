import { describe, expect, it } from 'vitest';
import type { Profile } from '@potatosalad775/eqcaps-core';
import { checkEdited, formatAuthoring } from './editor.ts';
import { authoringPath } from './authoring.ts';
import { citeEvidence, memberBase, profileForDevice, type Handoff } from './handoff.ts';
import { schemaValidator } from './schemas.ts';
import { readFileSync } from 'node:fs';

const handoff = (over: Partial<Handoff> = {}): Handoff => ({
	action: 'new',
	evidence: { path: 'evidence/new-device/2026-10-03-abcdef.json', text: '{}\n' },
	date: '2026-10-03',
	identity: {
		usb: { vendorId: '0x3302', productId: '0x4322', productName: 'NICEHCK PureAural' }
	},
	readBack: { filters: [null, null, null] },
	needsBandCount: false,
	...over
});

const group = (sources: Profile['meta']['sources']) =>
	({ id: 'walkplay-schemeno16-devices', meta: { status: 'draft', sources } }) as Profile;

describe('memberBase', () => {
	it("is the group's base, or the group when it extends nothing", () => {
		const own = { kind: 'handler-code' as const, ref: 'r', date: '2026-10-02' };
		expect(memberBase(group([own, { ...own, via: 'walkplay-base' }]))).toBe('walkplay-base');
		expect(memberBase(group([own]))).toBe('walkplay-schemeno16-devices');
	});
});

describe('profileForDevice', () => {
	it('adds a group member: identity and provenance only, the rest inherited', async () => {
		const data = profileForDevice(
			handoff({ extends: 'walkplay-peq-10-band-10db-full-shelves', profileId: 'x' })
		);
		expect(data).toMatchObject({
			extends: 'walkplay-peq-10-band-10db-full-shelves',
			kind: 'hardware',
			device: { brand: '', model: 'NICEHCK PureAural' },
			match: {
				usb: [{ vendorId: '0x3302', productId: '0x4322', productName: 'NICEHCK PureAural' }]
			},
			meta: {
				status: 'draft',
				sources: [
					{
						kind: 'community',
						ref: 'evidence/new-device/2026-10-03-abcdef.json',
						date: '2026-10-03'
					}
				]
			}
		});
		expect(data).not.toHaveProperty('band');
		expect(data).not.toHaveProperty('bandCount');

		// Filled in, it passes CI's checks against the base it extends.
		data.id = 'nicehck-pureaural';
		data.device = { brand: 'NiceHCK', model: 'PureAural' };
		data.meta.sources[0]!.ref = 'evidence/nicehck-pureaural/2026-10-03-abcdef.json';
		const path = authoringPath(data);
		const base = 'data/bases/walkplay-peq-10-band-10db-full-shelves.json';
		const result = checkEdited({
			path,
			text: await formatAuthoring(data),
			chain: [
				{ path: base, text: readFileSync(new URL(`../../../../${base}`, import.meta.url), 'utf8') }
			],
			others: [],
			evidence: new Set(['evidence/nicehck-pureaural/2026-10-03-abcdef.json']),
			schema: schemaValidator()
		});
		expect(result.issues).toEqual([]);
		expect(result.profile?.bandCount).toBe(10);
	});

	it('starts a whole profile for an unknown device, as many bands as it returned', () => {
		const data = profileForDevice(handoff());
		expect(data.bandCount).toBe(3);
		expect(data.band?.types).toBeDefined();
		expect(citeEvidence(data, handoff()).meta.sources).toHaveLength(1);
	});

	it('starts from the protocol’s wire limits, cited as handler code', () => {
		const data = profileForDevice(
			handoff({ protocol: { handler: 'walkplay-hid', commit: 'abc1234' } })
		);
		expect(data.bandCount).toBe(3);
		expect(data.band).toMatchObject({
			types: ['PK', 'LSC', 'HSC', 'LPQ', 'HPQ'],
			freq: { min: 1, max: 65534, step: 1 }
		});
		expect(data.meta.sources.map((s) => s.kind)).toEqual(['handler-code', 'community']);
		expect(data.meta.sources[0]!.ref).toContain(
			'/blob/abc1234/packages/device-bridge/src/handlers/walkplay-hid.ts'
		);
		expect(data.meta.notes).toMatch(/wire limits/);
		expect(data.protocol).toEqual({ handler: 'walkplay-hid' });
	});

	it('adds a group member from a guided read: its constraints, cited as vendor-app', async () => {
		const guided: NonNullable<Handoff['guided']> = {
			constraints: {
				bandCount: 8,
				band: {
					types: ['PK', 'LSC', 'HSC'],
					freq: { min: 20, max: 20000, step: 1 },
					q: { min: 0.1, max: 10, step: 0.01 },
					gain: { min: -10, max: 10, step: 0.1 }
				},
				preamp: { mode: 'manual', gain: { min: -12, max: 0, step: 1 } }
			},
			notes: ['Bands 2–7 not checked: assumed to match band 1.'],
			vendorApp: 'Walkplay EQ web app'
		};
		const data = profileForDevice(
			handoff({ extends: 'walkplay-peq-10-band-10db-full-shelves', profileId: 'x', guided })
		);
		expect(data).toMatchObject({ bandCount: 8, band: guided.constraints.band });
		expect(data.meta.sources.map((s) => s.kind)).toEqual(['vendor-app']);
		expect(data.meta.notes).toMatch(/^Guided read .* Walkplay EQ web app .* Bands 2–7 not checked/);

		// The vendor-app source counts, so the profile may be community-verified.
		data.id = 'crinear-protocol-micro';
		data.device = { brand: 'CrinEar', model: 'Protocol Micro' };
		data.meta.status = 'community-verified';
		data.meta.sources[0]!.ref = 'evidence/crinear-protocol-micro/2026-10-03-abcdef.json';
		const base = 'data/bases/walkplay-peq-10-band-10db-full-shelves.json';
		const result = checkEdited({
			path: authoringPath(data),
			text: await formatAuthoring(data),
			chain: [
				{ path: base, text: readFileSync(new URL(`../../../../${base}`, import.meta.url), 'utf8') }
			],
			others: [],
			evidence: new Set(['evidence/crinear-protocol-micro/2026-10-03-abcdef.json']),
			schema: schemaValidator()
		});
		expect(result.issues).toEqual([]);
		expect(result.profile?.bandCount).toBe(8);
	});
});
