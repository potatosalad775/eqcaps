// The protocol table against the database: every key is a profile, every hardware profile has a
// protocol, and what the profile allows is what the codec can write.

import {
	domainBounds,
	resolveSlot,
	type Domain,
	type FilterType,
	type Profile
} from '@potatosalad775/eqcaps-core';
import { describe, expect, test } from 'vitest';
import { validateRepository } from '../../build/src/node.ts';
import {
	chooserFilters,
	guessProtocol,
	HANDLERS,
	KNOWN_HID_VENDORS,
	PROTOCOLS,
	protocolFor,
	transportsOf,
	type AnyHandler,
	type WireField,
	type WireGrid
} from '../src/index.ts';

const profiles = validateRepository().profiles;
const table = Object.entries(PROTOCOLS);
const handlerOf = (id: string) => HANDLERS[PROTOCOLS[id]!.handler] as AnyHandler;
const profile = (id: string) => profiles.get(id) as Profile;

test('every key is a profile id', () => {
	expect(table.filter(([id]) => !profiles.has(id)).map(([id]) => id)).toEqual([]);
});

/**
 * Hardware the bridge doesn't drive, listed so a missing protocol is always a decision. The RME
 * ADI-2 series is controlled over MIDI SysEx, which no handler speaks.
 */
const WITHOUT_PROTOCOL = new Set(['rme-adi-2-dac-fs', 'rme-adi-2-dac-fs-bass-treble']);

test('every hardware profile has a protocol, or is listed as having none', () => {
	const missing = [...profiles.values()].filter(
		(p) => p.kind === 'hardware' && !(p.id in PROTOCOLS) && !WITHOUT_PROTOCOL.has(p.id)
	);
	expect(missing.map((p) => p.id)).toEqual([]);
	expect([...WITHOUT_PROTOCOL].filter((id) => id in PROTOCOLS || !profiles.has(id))).toEqual([]);
});

test('protocolFor only answers for table keys', () => {
	expect(protocolFor('fiio-ka17')?.handler).toBe('fiio-usb-hid');
	expect(protocolFor('toString')).toBeUndefined();
	expect(protocolFor('no-such-device')).toBeUndefined();
});

test("each handler runs over a transport the profile's identity implies", () => {
	const wrong = table.filter(([id]) => {
		const kinds = transportsOf(handlerOf(id));
		const match = profile(id).match ?? {};
		const usb = !!match.usb && (kinds.includes('hid') || kinds.includes('serial'));
		const bt = !!match.bluetooth && (kinds.includes('ble') || kinds.includes('serial'));
		return !usb && !bt;
	});
	expect(wrong.map(([id]) => id)).toEqual([]);
});

test('a profile with a manual preamp has a protocol that writes it', () => {
	const wrong = table.filter(([id, p]) => {
		const h = handlerOf(id);
		const caps = h.capabilities(
			{ kind: transportsOf(h)[0], collections: [] } as never,
			p.options ?? {}
		);
		return profile(id).preamp.mode === 'manual' && !caps.writesPreamp;
	});
	expect(wrong.map(([id]) => id)).toEqual([]);
});

const freqStep = (id: string) => (resolveSlot(profile(id), 0).freq as { step?: number }).step ?? 1;

test("a constant frequency factor is the profile's frequency step (D29)", () => {
	for (const [id, p] of table) {
		if (p.handler !== 'walkplay-hid' && p.handler !== 'ktmicro-usb-hid') continue;
		const scale = (p.options as { freqScale?: number } | undefined)?.freqScale ?? 1;
		expect(scale, id).toBe(freqStep(id));
	}
});

/** Where a profile domain isn't inside the codec's wire field. */
function outside(d: Domain, w: WireField | { values: readonly number[] } | undefined): string[] {
	if (!w) return [];
	const { min, max } = domainBounds(d);
	if ('values' in w) {
		const values = 'value' in d ? [d.value] : 'values' in d ? d.values : [min, max];
		const extra = values.filter((v) => !w.values.includes(v));
		return extra.length ? [`not on the wire: ${extra.join(' ')}`] : [];
	}
	const out: string[] = [];
	if (min < w.min - 1e-9 || max > w.max + 1e-9) out.push(`${min}..${max} past ${w.min}..${w.max}`);
	if (w.step === undefined) return out;
	const ws = w.step;
	const on = (x: number) => Math.abs(x / ws - Math.round(x / ws)) <= 1e-6;
	if ('value' in d || 'values' in d) {
		const off = ('value' in d ? [d.value] : d.values).filter((v) => !on(v));
		if (off.length) out.push(`${off.join(' ')} off the wire's ${ws}`);
	} else if (!('step' in d)) out.push(`continuous, the wire's step is ${ws}`);
	else if (!on(d.step) || !on(d.min) || !on(d.max))
		out.push(`${d.min}..${d.max} step ${d.step} off the wire's ${ws}`);
	return out;
}

/**
 * What the profiles allow that the codecs can't write. These are gaps between the seeded data and
 * the protocols: devicePEQ lists types its handlers don't encode. Fix the data or the codec once
 * the device tells which is right; a new entry here is a regression.
 */
test('profile domains the wire cannot carry', () => {
	const findings: Record<string, string[]> = {};
	for (const [id, p] of table) {
		const prof = profile(id);
		const wire: WireGrid = handlerOf(id).codec.wire(p.options ?? {});
		const codecTypes = handlerOf(id).codec.types;
		const found = new Set<string>();
		for (let i = 0; i < (prof.bandCount ?? 1); i++) {
			const slot = resolveSlot(prof, i);
			const types = slot.types.filter((t: FilterType) => !codecTypes.includes(t));
			if (types.length) found.add(`types ${types.join(' ')}`);
			for (const t of slot.types) {
				const s = resolveSlot(prof, i, { type: t, freq: 1000, q: 1, gain: 0 });
				for (const m of outside(s.freq, wire.freq)) found.add(`freq ${m}`);
				for (const m of outside(s.q, wire.q)) found.add(`q ${m}`);
				for (const m of outside(s.gain, wire.gain)) found.add(`gain ${m}`);
			}
		}
		if (prof.preamp.mode === 'manual') {
			for (const m of outside(prof.preamp.gain, wire.preamp)) found.add(`preamp ${m}`);
		}
		if (found.size) findings[`${id} (${p.handler})`] = [...found];
	}
	expect(findings).toMatchSnapshot();
});

describe('devices without a profile', () => {
	test('a known vendor gets its usual protocol, marked experimental', () => {
		expect(guessProtocol(0x2972)).toMatchObject({ handler: 'fiio-usb-hid', experimental: true });
		expect(guessProtocol(0x31b2)).toMatchObject({
			handler: 'ktmicro-usb-hid',
			options: { freqScale: 2 }
		});
		expect(guessProtocol(0x1234)).toBeUndefined();
	});

	test('the guesses never mark the table itself experimental', () => {
		guessProtocol(0x2972);
		expect(PROTOCOLS['fiio-ka17']!.experimental).toBeUndefined();
	});
});

describe('chooser filters', () => {
	test('without entries: the guessable HID vendors and every SPP class and GATT service', () => {
		const f = chooserFilters();
		expect(f.hidVendorIds).toEqual([...new Set(KNOWN_HID_VENDORS)]);
		expect(f.serialVendorIds).toEqual([]);
		expect(f.bleNames).toEqual([]);
		expect(f.sppServiceClasses).toContain('00001101-0000-1000-8000-00805f9b34fb');
		expect(f.gattServices).toHaveLength(2);
	});

	test('with the database: its devices, by the transport their protocol runs over', () => {
		const f = chooserFilters(profiles.values());
		expect(f.hidVendorIds).toContain(0x3302);
		expect(f.serialVendorIds).toContain(0x152a); // JDS Labs
		expect(f.bleNames).toContainEqual({ name: 'FIIO EH13' });
		expect(f.bleNames).not.toContainEqual({ namePrefix: 'Nothing Headphone' }); // SPP only
	});
});
