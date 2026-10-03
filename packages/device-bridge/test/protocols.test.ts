// The profiles' protocols against the bridge (D33, D42): every hardware profile has one this bridge
// can drive, it runs over a transport the profile's identity implies, and what the profile allows
// is what the codec can write.

import {
	domainBounds,
	indexFields,
	resolveSlot,
	type Domain,
	type FilterType,
	type Profile
} from '@potatosalad775/eqcaps-core';
import { matchDevice } from '@potatosalad775/eqcaps-client';
import { describe, expect, test } from 'vitest';
import {
	chooserFilters,
	guessProtocol,
	HANDLERS,
	KNOWN_HID_VENDORS,
	protocolForMatches,
	protocolOf,
	protocolProblem,
	transportsOf,
	type AnyHandler,
	type WireField,
	type WireGrid
} from '../src/index.ts';
import { profiles, PROTOCOLS } from './data.ts';

const driven = Object.entries(PROTOCOLS);
const handlerOf = (id: string) => HANDLERS[PROTOCOLS[id]!.handler] as AnyHandler;
const profile = (id: string) => profiles.get(id) as Profile;

/**
 * Hardware the bridge doesn't drive, listed so a missing protocol is always a decision. The RME
 * ADI-2 series is controlled over MIDI SysEx, which no handler speaks.
 */
const WITHOUT_PROTOCOL = new Set(['rme-adi-2-dac-fs', 'rme-adi-2-dac-fs-bass-treble']);

test('every protocol in the data is one this bridge can drive', () => {
	const problems = [...profiles.values()]
		.filter((p) => p.protocol !== undefined)
		.flatMap((p) => {
			const problem = protocolProblem(p.protocol);
			return problem ? [`${p.id}: ${problem}`] : [];
		});
	expect(problems).toEqual([]);
});

test('every hardware profile has a protocol', () => {
	const missing = [...profiles.values()].filter(
		(p) => p.kind === 'hardware' && !(p.id in PROTOCOLS) && !WITHOUT_PROTOCOL.has(p.id)
	);
	expect(missing.map((p) => p.id)).toEqual([]);
	expect([...WITHOUT_PROTOCOL].filter((id) => id in PROTOCOLS || !profiles.has(id))).toEqual([]);
});

describe('protocolOf', () => {
	test('reads hex strings as numbers', () => {
		expect(protocolOf(profile('fiio-btr17'))?.options).toEqual({
			saveCommand: 0x21,
			disabledPresetId: 240
		});
		expect(
			protocolOf({
				protocol: {
					handler: 'ktmicro-usb-hid',
					options: { bandRegisters: [{ freq: '0x35', q: 54 }] }
				}
			})?.options
		).toEqual({ bandRegisters: [{ freq: 0x35, q: 0x36 }] });
	});

	test('index entries carry the protocol', () => {
		expect(protocolOf(indexFields(profile('crinear-protocol-micro')))).toEqual({
			handler: 'walkplay-hid',
			presets: [{ id: 101, name: 'Custom' }]
		});
	});

	test("refuses what the bridge can't drive, and says why", () => {
		const bad = {
			'no handler': { handler: 'walkplay-bt' },
			'unknown option': { handler: 'walkplay-hid', options: { reportId: 1 } },
			'not a byte': { handler: 'fiio-usb-hid', options: { reportId: 256 } },
			'bad hex': { handler: 'fiio-usb-hid', options: { saveCommand: '0x2G' } },
			'preset twice': {
				handler: 'walkplay-hid',
				presets: [
					{ id: 1, name: 'A' },
					{ id: 1, name: 'B' }
				]
			},
			'bad baud rate': { handler: 'fiio-usb-serial', baudRate: 0 }
		};
		for (const [what, protocol] of Object.entries(bad)) {
			expect(protocolOf({ protocol }), what).toBeUndefined();
			expect(protocolProblem(protocol), what).toBeTypeOf('string');
		}
		expect(protocolProblem({ handler: 'walkplay-bt' })).toMatch(/no handler "walkplay-bt"/);
		expect(protocolOf({})).toBeUndefined();
		expect(protocolOf(undefined)).toBeUndefined();
	});

	test('ignores extension keys in options', () => {
		expect(
			protocolOf({ protocol: { handler: 'walkplay-hid', options: { 'x-note': 'hi' } } })
		).toEqual({ handler: 'walkplay-hid' });
	});
});

test('protocolForMatches takes the first match with a protocol this bridge can drive', () => {
	const group = profile('walkplay-schemeno16-devices');
	expect(protocolForMatches([{ id: 'rme-adi-2-dac-fs' }, group])).toEqual({
		profileId: 'walkplay-schemeno16-devices',
		protocol: protocolOf(group)
	});
	expect(
		protocolForMatches([{ id: 'future', protocol: { handler: 'walkplay-bt' } }, group])?.profileId
	).toBe('walkplay-schemeno16-devices');
	expect(protocolForMatches([profile('fiio-ka17'), group])?.profileId).toBe('fiio-ka17');
	expect(protocolForMatches([{ id: 'rme-adi-2-dac-fs' }])).toBeUndefined();
});

test("each handler runs over a transport the profile's identity implies", () => {
	const wrong = driven.filter(([id]) => {
		const kinds = transportsOf(handlerOf(id));
		const match = profile(id).match ?? {};
		const usb = !!match.usb && (kinds.includes('hid') || kinds.includes('serial'));
		const bt = !!match.bluetooth && (kinds.includes('ble') || kinds.includes('serial'));
		return !usb && !bt;
	});
	expect(wrong.map(([id]) => id)).toEqual([]);
});

test('a profile with a manual preamp has a protocol that writes it', () => {
	const wrong = driven.filter(([id, p]) => {
		const h = handlerOf(id);
		const caps = h.capabilities(
			{ kind: transportsOf(h)[0], collections: [] } as never,
			p.options ?? {}
		);
		return profile(id).preamp.mode === 'manual' && !caps.writesPreamp;
	});
	expect(wrong.map(([id]) => id)).toEqual([]);
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
	for (const [id, p] of driven) {
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

test("protocolForMatches takes the client's matches over index entries", () => {
	const index = [...profiles.values()].map(indexFields);
	const { matches } = matchDevice(index, {
		usb: { vendorId: 0x3302, productId: 0xc20f, productName: 'Protocol Micro' }
	});
	expect(protocolForMatches(matches)).toEqual({
		profileId: 'crinear-protocol-micro',
		protocol: { handler: 'walkplay-hid', presets: [{ id: 101, name: 'Custom' }] }
	});
});

describe('devices without a profile', () => {
	test('a known vendor gets its usual protocol, marked experimental', () => {
		expect(guessProtocol(0x2972)).toMatchObject({ handler: 'fiio-usb-hid', experimental: true });
		expect(guessProtocol(0x31b2)).toMatchObject({ handler: 'ktmicro-usb-hid' });
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
