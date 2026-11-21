import type { AuthoringProfile } from '@potatosalad775/eqcaps-core';
import { describe, expect, it } from 'vitest';
import { blankProfile } from './editor.ts';
import { evidenceName, evidenceRef, presentEvidence, startingProfile } from './editor-start.ts';
import { citeEvidence, profileForDevice, type Handoff } from './handoff.ts';

const existing = (): AuthoringProfile => ({
	extends: 'acme-base',
	id: 'acme-one',
	kind: 'hardware',
	device: { brand: 'Acme', model: 'One' },
	match: { usb: [{ vendorId: '0x1234', productId: '0x0001' }] },
	bandCount: 10,
	meta: {
		status: 'maintainer-verified',
		sources: [
			{ kind: 'vendor-docs', ref: 'https://example.com/manual', date: '2026-10-01' },
			{ kind: 'community', ref: 'evidence/acme-one/2026-10-02-aa11.json', date: '2026-10-02' }
		],
		notes: 'Checked on firmware 1.2.'
	}
});

const handoff = (action: Handoff['action'], extra: Partial<Handoff> = {}): Handoff => ({
	action,
	evidence: {
		path: `evidence/${action === 'new' ? 'new-device' : 'acme-one'}/2026-11-22-ab12.json`,
		text: '{}'
	},
	date: '2026-11-22',
	identity: { usb: { vendorId: '0x1234', productId: '0x0002', productName: 'Acme Two' } },
	readBack: { filters: [] },
	needsBandCount: false,
	...extra
});

describe('the file an edit starts from', () => {
	it('is the existing file exactly as it is when nothing was handed over', () => {
		expect(startingProfile({ existing: existing() })).toBeNull();
		// Also one that isn't a JSON object: the user sees their text and fixes it.
		expect(startingProfile({ existing: null })).toBeNull();
	});

	it('is the existing file citing the evidence handed over', () => {
		const h = handoff('fix');
		const start = startingProfile({ existing: existing(), handoff: h })!;
		expect(start).toEqual(citeEvidence(existing(), h));
		expect(start.meta.sources.at(-1)).toMatchObject({ ref: h.evidence.path, date: h.date });
		expect(start.meta.sources).toHaveLength(3);
	});

	it('is a blank file citing the evidence when the existing text is no JSON object', () => {
		const start = startingProfile({ existing: null, handoff: handoff('fix') })!;
		expect(start.id).toBe('');
		expect(start.meta.sources.map((s) => s.ref)).toEqual([handoff('fix').evidence.path]);
	});

	it('is a copy as the draft of a new profile: no id, no sources, a match to fill in', () => {
		const start = startingProfile({ copy: existing() })!;
		expect(start).toMatchObject({
			extends: 'acme-base',
			id: '',
			device: { brand: 'Acme', model: 'One' },
			bandCount: 10,
			match: { usb: [] },
			meta: { status: 'draft', sources: [] }
		});
		expect(start.meta).not.toHaveProperty('notes');
	});

	it('gives a copied software profile, or one with no kind of its own, no match', () => {
		const { kind: _kind, ...inherits } = existing();
		expect(startingProfile({ copy: inherits as AuthoringProfile })).not.toHaveProperty('match');
		expect(
			startingProfile({ copy: { ...existing(), kind: 'software' } as AuthoringProfile })
		).not.toHaveProperty('match');
	});

	it('is a profile for the device that was read, when only a handoff is given', () => {
		const h = handoff('new', { extends: 'acme-base' });
		expect(startingProfile({ handoff: h })).toEqual(profileForDevice(h));
	});

	it('is a blank file otherwise, extending or of the kind the address names', () => {
		expect(startingProfile({})).toEqual(blankProfile({ kind: 'hardware' }));
		expect(startingProfile({ kind: 'software' })).toEqual(blankProfile({ kind: 'software' }));
		expect(startingProfile({ extends: 'acme-base' })).toEqual(
			blankProfile({ extends: 'acme-base', kind: 'hardware' })
		);
	});

	it('takes the id in the address over a copy or a handoff alone', () => {
		expect(startingProfile({ existing: existing(), copy: existing() })).toBeNull();
	});
});

describe('the evidence an edit cites', () => {
	const h = handoff('new');

	it('has the name of the file handed over, and none without a handoff', () => {
		expect(evidenceName(h)).toBe('2026-11-22-ab12.json');
		expect(evidenceName(null)).toBe('');
		expect(evidenceRef(existing(), null)).toBe('');
	});

	it('is found by its name once it moved under the profile`s id', () => {
		const cited = citeEvidence(existing(), h);
		expect(evidenceRef(cited, h)).toBe(h.evidence.path);
		cited.meta.sources.at(-1)!.ref = 'evidence/acme-two/2026-11-22-ab12.json';
		expect(evidenceRef(cited, h)).toBe('evidence/acme-two/2026-11-22-ab12.json');
	});

	it('is the path handed over where the file does not cite it, or does not parse', () => {
		expect(evidenceRef(existing(), h)).toBe(h.evidence.path);
		expect(evidenceRef(null, h)).toBe(h.evidence.path);
	});

	it('counts as present what the file cited before the edit and what was handed over', () => {
		expect([...presentEvidence(existing(), h.evidence.path)]).toEqual([
			'evidence/acme-one/2026-10-02-aa11.json',
			h.evidence.path
		]);
		// A new file, nothing handed over: nothing is present, so a made-up ref is flagged.
		expect(presentEvidence(null, '').size).toBe(0);
	});
});
