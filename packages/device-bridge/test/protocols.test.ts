// The profiles' protocols against the bridge (D33, D42): every hardware profile has one this bridge
// can drive, it runs over a transport the profile's identity implies, and what the profile allows
// is what the codec can write.

import {
	domainBounds,
	eqProfile,
	indexFields,
	resolveSlot,
	type Domain,
	type FilterType,
	type Profile
} from '@potatosalad775/eqcaps-core';
import { matchDevice } from '@potatosalad775/eqcaps-client';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
	chooserFilters,
	guessProtocol,
	handlerTransports,
	HANDLERS,
	KNOWN_HID_VENDORS,
	openDevice,
	openReader,
	protocolFor,
	protocolForMatches,
	protocolOf,
	protocolProblem,
	transportsOf,
	type AnyHandler,
	type WireField,
	type WireGrid
} from '../src/index.ts';
import { optionNames } from '../src/protocols.ts';
import { profiles, PROTOCOLS } from './data.ts';

const driven = Object.entries(PROTOCOLS);
const handlerOf = (id: string) => HANDLERS[PROTOCOLS[id]!.handler] as AnyHandler;
const profile = (id: string) => profiles.get(id) as Profile;

test('every protocol in the data is one this bridge can drive', () => {
	const problems = [...profiles.values()]
		.filter((p) => p.protocol !== undefined)
		.flatMap((p) => {
			const problem = protocolProblem(p.protocol);
			return problem ? [`${p.id}: ${problem}`] : [];
		});
	expect(problems).toEqual([]);
});

// A hardware profile without a protocol is one no handler drives (SPEC §9), such as the RME ADI-2
// series (MIDI SysEx). It's a mistake only when the bridge knows the vendor's protocol, which is
// what a forgotten `extends` of the vendor's base looks like.
test('every hardware profile from a vendor the bridge knows has a protocol', () => {
	const missing = [...profiles.values()].filter(
		(p) =>
			p.kind === 'hardware' &&
			!(p.id in PROTOCOLS) &&
			(p.match?.usb ?? []).some((u) => guessProtocol(Number(u.vendorId)) !== undefined)
	);
	expect(missing.map((p) => p.id)).toEqual([]);
});

describe('controls (SPEC §9.1)', () => {
	const volume = {
		id: 'volume',
		name: 'Volume',
		kind: 'range',
		range: { min: 0, max: 60, step: 1 }
	};

	test("keep the profile's controls, in order", () => {
		const controls = protocolOf(profile('fosi-audio-ds3'))?.controls;
		expect(controls?.map((c) => c.id)).toEqual([
			'uacMode',
			'filterMode',
			'upsample',
			'gameMode',
			'gainMode',
			'volume',
			'led'
		]);
		expect(controls?.find((c) => c.id === 'upsample')).toEqual(
			profile('fosi-audio-ds3').protocol?.controls?.find((c) => c.id === 'upsample')
		);
	});

	test('a control the handler lacks: CI refuses it, an app leaves it out', () => {
		for (const c of [
			{ id: 'bass', name: 'Bass', kind: 'range', range: { min: -10, max: 10 } },
			{ ...volume, kind: 'dial' }
		]) {
			const raw = { handler: 'fosi-audio-usb-hid', controls: [volume, c] };
			expect(protocolProblem(raw), c.kind).toBeTypeOf('string');
			expect(protocolOf({ protocol: raw })?.controls?.map((x) => x.id)).toEqual(['volume']);
		}
		const unknownRole = {
			handler: 'fosi-audio-usb-hid',
			controls: [{ ...volume, role: 'loudness' }]
		};
		expect(protocolProblem(unknownRole)).toMatch(/unknown role/);
		expect(protocolOf({ protocol: unknownRole })?.controls).toEqual([
			{ id: 'volume', name: 'Volume', kind: 'range', range: { min: 0, max: 60, step: 1 } }
		]);
		const none = { handler: 'moondrop-usb-hid', controls: [volume] };
		expect(protocolOf({ protocol: none })).toEqual({ handler: 'moondrop-usb-hid' });
	});

	test("a control's eq is true or an EQ the handler drives (format 1.6)", () => {
		const headroom = { id: 'headroom', name: 'Headroom', kind: 'toggle', role: 'headroom' };
		const read = (c: object) => ({ handler: 'qudelix-v2-usb-hid', controls: [c] });
		expect((HANDLERS['qudelix-v2-usb-hid'] as AnyHandler).eqs).toContain('spk');
		for (const eq of [true, 'spk']) {
			const raw = read({ ...headroom, eq });
			expect(protocolProblem(raw)).toBeUndefined();
			expect(protocolOf({ protocol: raw })?.controls).toEqual([
				{ ...headroom, role: 'headroom', eq }
			]);
		}
		expect(protocolOf({ protocol: read(headroom) })?.controls?.[0]).not.toHaveProperty('eq');
		// An EQ the handler doesn't drive: CI refuses the control, an app leaves it out.
		const mic = read({ ...headroom, eq: 'mic' });
		expect(protocolProblem(mic)).toMatch(/no EQ "mic"/);
		expect(protocolOf({ protocol: mic })?.controls).toBeUndefined();
		for (const eq of [false, 3, 'Bad id']) {
			expect(protocolOf({ protocol: read({ ...headroom, eq }) })).toBeUndefined();
		}
	});

	test('a malformed control makes the protocol unreadable', () => {
		const bad = [
			{ ...volume, range: { min: 0 } },
			{ id: 'gainMode', name: 'Gain', kind: 'choice', values: [{ value: 0, name: 'L' }] },
			{ ...volume, kind: 'toggle' },
			{ ...volume, when: { control: 'uacMode' } },
			{ ...volume, reconnect: 'yes' }
		];
		for (const c of bad) {
			expect(
				protocolOf({ protocol: { handler: 'fosi-audio-usb-hid', controls: [c] } })
			).toBeUndefined();
		}
	});
});

describe('other EQs (SPEC §9.2)', () => {
	const spk = { id: 'spk', name: 'SPK EQ', bandCount: 20, presets: [{ id: 0, name: 'Flat' }] };
	const raw = (eqs: unknown) => ({ handler: 'qudelix-v2-usb-hid', eqs });

	test('keeps the EQs the handler drives, with their band count and presets', () => {
		expect(protocolOf({ protocol: raw([spk]) })?.eqs).toEqual([spk]);
		expect(protocolOf({ protocol: raw([{ id: 'spk', name: 'SPK EQ' }]) })?.eqs).toEqual([
			{ id: 'spk', name: 'SPK EQ' }
		]);
		expect(protocolProblem(raw([spk]))).toBeUndefined();
	});

	test("an EQ's channels are the app's: the EQ is kept and the bridge doesn't read them", () => {
		const apart = { ...spk, channels: 'independent' };
		expect(protocolProblem(raw([apart]))).toBeUndefined();
		expect(protocolOf({ protocol: raw([apart]) })?.eqs).toEqual([spk]);
	});

	test('an EQ the handler lacks: CI refuses it, an app leaves it out', () => {
		const mic = { id: 'mic', name: 'Microphone EQ' };
		expect(protocolProblem(raw([spk, mic]))).toBe('eqs.mic: qudelix-v2-usb-hid has no EQ "mic"');
		expect(protocolOf({ protocol: raw([spk, mic]) })?.eqs).toEqual([spk]);
		expect(protocolOf({ protocol: raw([mic]) })).toEqual({ handler: 'qudelix-v2-usb-hid' });
		expect(protocolProblem({ handler: 'walkplay-hid', eqs: [spk] })).toBe(
			'eqs.spk: walkplay-hid has no EQ "spk"'
		);
	});

	test('a malformed EQ makes the protocol unreadable', () => {
		for (const bad of [
			'spk',
			[{ id: 'SPK', name: 'SPK EQ' }],
			[{ id: 'spk' }],
			[spk, spk],
			[{ ...spk, bandCount: 0 }],
			[
				{
					...spk,
					presets: [
						{ id: 0, name: 'Flat' },
						{ id: 0, name: 'Again' }
					]
				}
			],
			// These handlers have an EQ switch, so no preset of any of their EQs is a bypass.
			[{ ...spk, presets: [{ id: 0, name: 'Off', bypass: true }] }]
		]) {
			expect(protocolOf({ protocol: raw(bad) }), JSON.stringify(bad)).toBeUndefined();
		}
	});

	test('every EQ the data lists has the slots its profile gives it', () => {
		const plus = protocolOf(profile('qudelix-5k-plus'))!;
		expect(plus.eqs?.map((e) => [e.id, e.bandCount, e.presets?.length])).toEqual([['spk', 20, 21]]);
	});
});

describe('Moondrop USB HID options', () => {
	const options = {
		bandFrame: 'compact',
		commit: 'none',
		customSlot: '0x03',
		selectSlot: false,
		duckPreamp: true,
		saveOffsets: true,
		linkCheck: true
	};

	test('accepts each option', () => {
		const raw = { handler: 'moondrop-usb-hid', options };
		expect(protocolProblem(raw)).toBeUndefined();
		expect(protocolOf({ protocol: raw })?.options).toEqual({ ...options, customSlot: 3 });
		for (const bandFrame of ['biquad', 'compact', 'wide']) {
			expect(
				protocolProblem({ handler: 'moondrop-usb-hid', options: { bandFrame } })
			).toBeUndefined();
		}
		for (const commit of ['apply', 'commit', 'none']) {
			expect(protocolProblem({ handler: 'moondrop-usb-hid', options: { commit } })).toBeUndefined();
		}
	});

	test('refuses what is not a choice, a byte or a flag', () => {
		const bad: Record<string, unknown> = {
			bandFrame: 'long',
			commit: 'save',
			customSlot: 256,
			selectSlot: 'yes',
			duckPreamp: 1,
			saveOffsets: null,
			linkCheck: 'true'
		};
		for (const [k, v] of Object.entries(bad)) {
			const raw = { handler: 'moondrop-usb-hid', options: { [k]: v } };
			expect(protocolOf({ protocol: raw }), k).toBeUndefined();
			expect(protocolProblem(raw), k).toContain(`options.${k}`);
		}
		expect(protocolProblem({ handler: 'moondrop-usb-hid', options: { slot: 7 } })).toMatch(
			/no option "slot"/
		);
	});

	test('drives the global gain control', () => {
		const gain = {
			id: 'globalGain',
			name: 'Global gain',
			kind: 'range',
			range: { min: -18, max: 0, step: 0.1 },
			unit: 'dB'
		};
		const raw = { handler: 'moondrop-usb-hid', controls: [gain] };
		expect(protocolProblem(raw)).toBeUndefined();
		expect(protocolOf({ protocol: raw })?.controls?.map((c) => c.id)).toEqual(['globalGain']);
	});
});

describe('protocolOf', () => {
	test('reads hex strings as numbers', () => {
		expect(
			protocolOf({ protocol: { handler: 'fiio-usb-hid', options: { saveCommand: '0x19' } } })
				?.options
		).toEqual({ saveCommand: 0x19 });
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
			presets: [{ id: 101, name: 'Custom' }],
			controls: [
				{
					id: 'micGain',
					name: 'MIC Offset',
					kind: 'range',
					role: 'mic-gain',
					range: { min: -15, max: 15, step: 1.5 },
					unit: 'dB'
				}
			]
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
			'bad baud rate': { handler: 'fiio-usb-serial', baudRate: 0 },
			'option the presets say': { handler: 'fiio-usb-hid', options: { disabledPresetId: 240 } },
			'two bypass presets': {
				handler: 'fiio-usb-hid',
				presets: [
					{ id: 11, name: 'Off', bypass: true },
					{ id: 240, name: 'BYPASS', bypass: true }
				]
			},
			'bypass the handler has no use for': {
				handler: 'walkplay-hid',
				presets: [{ id: 0, name: 'Off', bypass: true }]
			},
			'writable bypass preset': {
				handler: 'fiio-usb-hid',
				presets: [{ id: 240, name: 'Off', bypass: true, writable: true }]
			},
			'writable not a boolean': {
				handler: 'walkplay-hid',
				presets: [{ id: 1, name: 'Custom', writable: 'yes' }]
			}
		};
		for (const [what, protocol] of Object.entries(bad)) {
			expect(protocolOf({ protocol }), what).toBeUndefined();
			expect(protocolProblem(protocol), what).toBeTypeOf('string');
		}
		expect(protocolProblem({ handler: 'walkplay-bt' })).toMatch(/no handler "walkplay-bt"/);
		expect(protocolOf({})).toBeUndefined();
		expect(protocolOf(undefined)).toBeUndefined();
	});

	test('keeps the writable marks: user memories apart from built-in curves', () => {
		const presets = [
			{ id: 0, name: 'Jazz' },
			{ id: 4, name: 'USER1', writable: true },
			{ id: 10, name: 'BYPASS', bypass: true }
		];
		expect(protocolOf({ protocol: { handler: 'fiio-usb-hid', presets } })?.presets).toEqual(
			presets
		);
		const marked = protocolOf(profile('fiio-ka17'))?.presets?.filter((p) => p.writable);
		expect(marked?.map((p) => p.id)).toEqual([4, 8, 9]);
		const unmarked = [{ id: 1, name: 'A', writable: false }];
		expect(
			protocolOf({ protocol: { handler: 'walkplay-hid', presets: unmarked } })?.presets
		).toEqual([{ id: 1, name: 'A' }]);
	});

	test('keeps the bypass preset, for handlers that turn the EQ off with one', () => {
		const presets = [
			{ id: 0, name: 'Jazz' },
			{ id: 240, name: 'BYPASS', bypass: true }
		];
		expect(protocolOf({ protocol: { handler: 'fiio-usb-hid', presets } })).toEqual({
			handler: 'fiio-usb-hid',
			presets
		});
		expect(protocolOf(profile('fiio-btr17'))?.presets).toContainEqual({
			id: 240,
			name: 'BYPASS',
			bypass: true
		});
		const off = [{ id: 1, name: 'A', bypass: false }];
		expect(protocolOf({ protocol: { handler: 'fiio-usb-hid', presets: off } })?.presets).toEqual([
			{ id: 1, name: 'A' }
		]);
	});

	test('ignores extension keys in options', () => {
		expect(
			protocolOf({ protocol: { handler: 'walkplay-hid', options: { 'x-note': 'hi' } } })
		).toEqual({ handler: 'walkplay-hid' });
	});

	test("still accepts Walkplay's enableCommand, which no longer does anything", () => {
		const raw = { handler: 'walkplay-hid', options: { enableCommand: false } };
		expect(protocolOf({ protocol: raw })?.options).toEqual({ enableCommand: false });
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

// The README is where a contributor looks up what a handler takes: every option a profile may
// set and every control a handler drives is named in its row there.
describe("the README's tables", () => {
	const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
	const [handlers = '', controls = ''] = readme.split('\n## Device controls\n');
	const row = (table: string, id: string) =>
		table.split('\n').find((line) => line.startsWith(`| \`${id}\` |`));
	const ids = Object.keys(HANDLERS) as (keyof typeof HANDLERS)[];

	test('have a row for every handler, naming each of its options', () => {
		const missing = ids.flatMap((id) => {
			const line = row(handlers, id);
			if (!line) return [`${id}: no row`];
			return optionNames(id)
				.filter((name) => !line.includes(`\`${name}\``))
				.map((name) => `${id}: ${name}`);
		});
		expect(missing).toEqual([]);
	});

	test('name every control a handler drives', () => {
		const missing = ids.flatMap((id) => {
			const driven = Object.keys((HANDLERS[id] as AnyHandler).controls ?? {});
			if (driven.length === 0) return [];
			const line = row(controls, id);
			if (!line) return [`${id}: no row`];
			return driven.filter((c) => !line.includes(`\`${c}\``)).map((c) => `${id}: ${c}`);
		});
		expect(missing).toEqual([]);
	});
});

describe('protocolFor: the order every app takes', () => {
	const group = profile('walkplay-schemeno16-devices');
	const ka17 = profile('fiio-ka17');
	const undriven = { id: 'rme-adi-2-dac-fs' };

	test("the chosen profile's own protocol comes first", () => {
		expect(protocolFor({ chosen: ka17, matches: [group], usbVendorId: 0x2972 })).toEqual({
			protocol: protocolOf(ka17),
			source: 'profile',
			profileId: 'fiio-ka17'
		});
	});

	test('else that of the most specific match that has one, which is named', () => {
		expect(protocolFor({ chosen: undriven, matches: [undriven, group] })).toEqual({
			protocol: protocolOf(group),
			source: 'match',
			profileId: 'walkplay-schemeno16-devices'
		});
		expect(protocolFor({ matches: [ka17, group] })?.profileId).toBe('fiio-ka17');
	});

	test('else a guess from the USB vendor, as a number or as the data writes it', () => {
		const guess = { protocol: guessProtocol(0x2972), source: 'guess' };
		expect(protocolFor({ chosen: undriven, matches: [undriven], usbVendorId: 0x2972 })).toEqual(
			guess
		);
		expect(protocolFor({ usbVendorId: '0x2972' })).toEqual(guess);
		expect(guess.protocol?.experimental).toBe(true);
	});

	test('else nothing: no vendor id (serial, Bluetooth), or a vendor no guess covers', () => {
		expect(protocolFor({ chosen: undriven, matches: [undriven] })).toBeUndefined();
		expect(protocolFor({ usbVendorId: null })).toBeUndefined();
		expect(protocolFor({ usbVendorId: 0xffff })).toBeUndefined();
		expect(protocolFor({})).toBeUndefined();
	});
});

test('openReader gives a device with no way to write, on any view (D40)', () => {
	const transport = {
		kind: 'hid',
		vendorId: 0x0a12,
		productId: 0x4025,
		productName: 'Qudelix-5K',
		collections: []
	} as never;
	const protocol = protocolOf(profile('qudelix-5k'))!;
	const reads = [
		'bandCount',
		'capabilities',
		'close',
		'currentSlot',
		'eq',
		'eqEnabled',
		'firmware',
		'identity',
		'protocol',
		'pull',
		'readControls',
		'slots',
		'transport'
	];
	const reader = openReader(transport, protocol);
	const spk = reader.eq('spk');
	expect(Object.keys(reader).sort()).toEqual(reads);
	expect(Object.keys(spk).sort()).toEqual(reads);
	// Every other member of a device is a write: a new one lands here until it is placed.
	const writes = Object.keys(openDevice(transport, protocol)).filter((k) => !reads.includes(k));
	expect(writes.sort()).toEqual([
		'createSlot',
		'deleteSlot',
		'push',
		'renameSlot',
		'setEnabled',
		'writeControl'
	]);
	// The views are the device's own: its EQ's slots, the same view each time.
	expect(spk.capabilities.slots).toEqual(reader.capabilities.eqs[0]!.slots);
	expect(reader.eq('spk')).toBe(spk);
	expect(spk.eq()).toBe(reader);
});

// What a device's capabilities say it can't do, the session answers for the handler: null for a
// read, a refusal for a write, and nothing is sent. A handler states a capability only where it
// depends on its options; everywhere else it is whether the handler has the method.
describe('capabilities are the session`s word', () => {
	/** A device that fails any I/O: an answer that came from the handler would be this failure. */
	const dead = (kind: string) => {
		const io = async () => Promise.reject(new Error('the device was asked'));
		return {
			kind,
			vendorId: 0,
			productId: 0,
			productName: '',
			collections: [],
			sendReport: io,
			sendFeatureReport: io,
			receiveFeatureReport: io,
			onInputReport: () => () => {},
			write: io,
			read: io,
			close: async () => {}
		} as never;
	};
	const flat = (type: FilterType) => ({ type, freq: 1000, q: 1, gain: 0 });

	test.each(driven)('%s', async (id, protocol) => {
		const h = handlerOf(id);
		const device = openDevice(dead(transportsOf(h)[0]!), protocol);
		const caps = device.capabilities;
		// Where the handler says nothing, it is having the method.
		const own = h.capabilities(dead(transportsOf(h)[0]!), protocol.options ?? {});
		if (own.readsCurrentSlot === undefined) {
			expect(caps.readsCurrentSlot).toBe(h.currentSlot !== undefined);
		}
		if (own.canEnable === undefined) expect(caps.canEnable).toBe(h.setEnabled !== undefined);
		if (own.readsEnabled === undefined) expect(caps.readsEnabled).toBe(h.eqEnabled !== undefined);
		expect(caps.writesPreamp).toBe(caps.wire.preamp !== undefined);

		const unsupported = { code: 'unsupported' };
		if (!caps.readsCurrentSlot) expect(await device.currentSlot()).toBeNull();
		if (!caps.readsEnabled) expect(await device.eqEnabled()).toBeNull();
		if (!caps.canEnable) await expect(device.setEnabled(true)).rejects.toMatchObject(unsupported);
		if (!caps.editsSlots) {
			await expect(device.createSlot()).rejects.toMatchObject(unsupported);
			await expect(device.renameSlot(0, 'x')).rejects.toMatchObject(unsupported);
			await expect(device.deleteSlot(0)).rejects.toMatchObject(unsupported);
		}
		const filters = Array.from({ length: profile(id).bandCount ?? 1 }, () =>
			flat(h.codec.types[0]!)
		);
		if (!caps.writesPreamp) {
			await expect(device.push({ filters, preamp: 0 })).rejects.toMatchObject({
				code: 'invalid-request',
				message: expect.stringContaining('carries no preamp')
			});
		}
	});

	test('some device says no to each of them, so none of the above is idle', () => {
		const all = driven.map(([id, protocol]) => {
			const kind = transportsOf(handlerOf(id))[0]!;
			return openDevice(dead(kind), protocol).capabilities;
		});
		for (const flag of [
			'readsCurrentSlot',
			'readsEnabled',
			'canEnable',
			'editsSlots',
			'writesPreamp'
		] as const) {
			expect(
				all.some((c) => c[flag]),
				flag
			).toBe(true);
			expect(
				all.some((c) => !c[flag]),
				flag
			).toBe(true);
		}
	});
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
		const carries = handlerOf(id).codec.wire(p.options ?? {}).preamp !== undefined;
		return profile(id).preamp.mode === 'manual' && !carries;
	});
	expect(wrong.map(([id]) => id)).toEqual([]);
});

// SPEC §9 and §9.2: an app sends the right channel apart only where the profile says an EQ's
// channels are independent, and the bridge refuses it where the handler can't drive them apart.
test('an EQ has independent channels exactly where its protocol drives them apart', () => {
	const wrong = driven.flatMap(([id, p]) => {
		const h = handlerOf(id);
		const apart = (eq?: string) =>
			h.capabilities({ kind: transportsOf(h)[0], collections: [] } as never, p.options ?? {}, eq)
				.perChannel === true;
		return [undefined, ...(p.eqs ?? []).map((e) => e.id)]
			.map((eq) => ({ eq, apart: apart(eq) }))
			.filter(({ eq, apart }) => (eqProfile(profile(id), eq)!.channels === 'independent') !== apart)
			.map(({ eq }) => (eq === undefined ? id : `${id} ${eq}`));
	});
	expect(wrong).toEqual([]);
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
		protocol: {
			handler: 'walkplay-hid',
			presets: [{ id: 101, name: 'Custom' }],
			controls: [
				{
					id: 'micGain',
					name: 'MIC Offset',
					kind: 'range',
					role: 'mic-gain',
					range: { min: -15, max: 15, step: 1.5 },
					unit: 'dB'
				}
			]
		}
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

test('handlerTransports names a handler’s transports by id', () => {
	expect(handlerTransports('walkplay-hid')).toEqual(['hid']);
	expect(handlerTransports('airoha')).toEqual(['serial', 'ble']);
	expect(handlerTransports('no-such-handler')).toEqual([]);
	expect(handlerTransports('toString')).toEqual([]);
});

test('the Moondrop USB HID led command is a byte', () => {
	const at = (ledCommand: unknown) => ({ handler: 'moondrop-usb-hid', options: { ledCommand } });
	expect(protocolOf({ protocol: at('0x18') })?.options).toEqual({ ledCommand: 0x18 });
	expect(protocolProblem(at(256))).toMatch(/options.ledCommand/);
	const control = (id: string) => ({
		id,
		name: id,
		kind: 'range',
		range: { min: 0, max: 100, step: 1 }
	});
	const ids = ['dacFilter', 'dacMode', 'led', 'gainLevel', 'ancMode', 'dualMicEnc', 'promptTone'];
	const raw = { handler: 'moondrop-usb-hid', controls: [...ids, 'promptToneVolume'].map(control) };
	expect(protocolProblem(raw)).toBeUndefined();
});
