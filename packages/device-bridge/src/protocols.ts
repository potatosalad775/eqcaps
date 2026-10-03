// How to drive each device the database describes, keyed by eqcaps profile id (D33): the handler,
// its protocol settings, the preset slots, and transport details. Identity (which profile a
// connected device is) is the database's job: match the transport's identity with the client.
// Constraints (bands, ranges, types) are in the profiles, never here (invariant 2).
//
// Taken from devicePEQ's device configs at 0617f38 (0BSD), and maintained by hand.

import type { Slot } from './handler.ts';
import type { HandlerId, HandlerOptions } from './handlers/index.ts';

interface ProtocolBase {
	/** EQ preset slots the device offers. */
	slots?: readonly Slot[];
	/** The device drops the connection after a push that saves. */
	disconnectOnSave?: boolean;
	/** The protocol for this device is unconfirmed. */
	experimental?: boolean;
	/** Serial ports: the baud rate. Default 115200 over USB, 9600 over Bluetooth. */
	baudRate?: number;
}

/** How to drive one device: a handler and its settings. */
export type Protocol = {
	[K in HandlerId]: ProtocolBase & { handler: K; options?: HandlerOptions<K> };
}[HandlerId];

// --- Preset slots ---------------------------------------------------------------------------------

const presets = (...list: [number, string][]): Slot[] => list.map(([id, name]) => ({ id, name }));
const users = (first: number, count: number) =>
	presets(
		...Array.from({ length: count }, (_, i): [number, string] => [first + i, `USER${i + 1}`])
	);

const FIIO_STYLES = presets(
	[0, 'Jazz'],
	[1, 'Pop'],
	[2, 'Rock'],
	[3, 'Dance'],
	[4, 'R&B'],
	[5, 'Classic'],
	[6, 'Hip-hop']
);
/** KA17, Q7, BT11, Air Link: R&B moved to 5 and USER1 to 4. */
const FIIO_STYLES_KA17 = presets(
	[0, 'Jazz'],
	[1, 'Pop'],
	[2, 'Rock'],
	[3, 'Dance'],
	[5, 'R&B'],
	[6, 'Classic'],
	[7, 'Hip-hop'],
	[4, 'USER1'],
	[8, 'USER2'],
	[9, 'USER3']
);
const SDAMP = presets([8, 'Retro'], [9, 'sDamp-1'], [10, 'sDamp-2']);
const BYPASS = (id: number) => presets([id, 'BYPASS']);
const CLOSE = (id: number) => presets([id, 'Close EQ']);
const CUSTOM = (id: number) => presets([id, 'Custom']);
const CUSTOM_EQ = presets([0, 'Custom EQ']);

const SNOWSKY = [...FIIO_STYLES, ...users(160, 3), ...CLOSE(240)];
const FIIO_USER10 = [...FIIO_STYLES, ...users(160, 10), ...BYPASS(240)];
const FIIO_R2R = [...BYPASS(240), ...FIIO_STYLES, ...SDAMP, ...users(160, 10)];
const FIIO_K17 = [
	...presets(
		[0, 'Jazz'],
		[1, 'Rock'],
		[2, 'R&B'],
		[3, 'Hip-hop'],
		[4, 'Pop'],
		[5, 'Dance'],
		[6, 'Classic']
	),
	...users(7, 10),
	...CLOSE(17)
];
const FIIO_USER1 = [...FIIO_STYLES, ...users(160, 1)];
const WALKPLAY = CUSTOM(101);
const KTMICRO = CUSTOM(3);

// --- Protocols by profile -------------------------------------------------------------------------

const fiio = (
	options: HandlerOptions<'fiio-usb-hid'>,
	slots: readonly Slot[],
	extra: ProtocolBase = {}
): Protocol => ({
	handler: 'fiio-usb-hid',
	...(Object.keys(options).length ? { options } : {}),
	slots,
	...extra
});

const walkplay = (
	extra: ProtocolBase & { options?: HandlerOptions<'walkplay-hid'> } = {}
): Protocol => ({
	handler: 'walkplay-hid',
	slots: WALKPLAY,
	...extra
});
/** Walkplay SchemeNo11: bands land 2.25% below the frequency sent. */
const SCHEME_NO11 = { options: { freqScale: 0.9775 } };

const moondrop: Protocol = { handler: 'moondrop-usb-hid' };

const ktmicro = (
	extra: ProtocolBase & { options?: HandlerOptions<'ktmicro-usb-hid'> } = {}
): Protocol => ({
	handler: 'ktmicro-usb-hid',
	slots: KTMICRO,
	...extra
});

export const PROTOCOLS: Readonly<Record<string, Protocol>> = {
	// FiiO USB HID (also JadeAudio and Snowsky)
	'fiio-qx13': fiio({ disabledPresetId: 240 }, [
		...FIIO_STYLES,
		...presets([8, 'Retro']),
		...users(160, 10),
		...BYPASS(240)
	]),
	'fiio-ka17': fiio({ reportId: 1, disabledPresetId: 10 }, [...FIIO_STYLES_KA17, ...BYPASS(10)]),
	'fiio-q7': fiio({ disabledPresetId: 10 }, [...FIIO_STYLES_KA17, ...BYPASS(10)]),
	'fiio-bt11': fiio({ disabledPresetId: 11 }, FIIO_STYLES_KA17),
	'fiio-air-link': fiio({ disabledPresetId: 11 }, FIIO_STYLES_KA17),
	'fiio-btr13': fiio({ disabledPresetId: 11 }, [...FIIO_STYLES, ...users(7, 3), ...CLOSE(11)]),
	'fiio-btr17': fiio({ saveCommand: 0x21, disabledPresetId: 240 }, FIIO_USER10),
	'fiio-k19': fiio({ saveCommand: 0x21, disabledPresetId: 17 }, FIIO_K17),
	'fiio-k17': fiio({ saveCommand: 0x21, disabledPresetId: 17 }, FIIO_K17),
	'fiio-k15': fiio({ disabledPresetId: 240 }, [...FIIO_STYLES, ...users(7, 10), ...BYPASS(240)]),
	'fiio-ka15': fiio({ disabledPresetId: 10 }, [...FIIO_STYLES, ...users(7, 3), ...CLOSE(10)]),
	'fiio-k13-r2r': fiio({ disabledPresetId: 240 }, FIIO_R2R),
	'fiio-br15-r2r': fiio({ disabledPresetId: 240 }, FIIO_R2R),
	'fiio-fp3': fiio({}, FIIO_USER1),
	'fiio-fx17': fiio({}, FIIO_USER1),
	'fiio-oak-nano': fiio({}, FIIO_USER1),
	'fiio-ls-tc2': fiio({}, FIIO_USER1, { experimental: true }),
	'fiio-fg3': fiio({}, [
		...FIIO_STYLES,
		...presets([12, 'Cinema'], [13, 'FPS'], [14, 'MOBA'], [15, 'ACT'], [16, 'MUG']),
		...users(160, 10)
	]),
	'fiio-retro-nano': fiio({ disabledPresetId: 11 }, [
		...FIIO_STYLES,
		...SDAMP,
		...users(160, 3),
		...CLOSE(11)
	]),
	'fiio-qx11': fiio({}, [...FIIO_STYLES, ...SDAMP, ...users(160, 10)]),
	'fiio-air-amp': fiio({ disabledPresetId: 240 }, [
		...FIIO_STYLES,
		...presets([7, 'Monitor'], [9, 'sDamp-1'], [10, 'sDamp-2']),
		...users(160, 10),
		...BYPASS(240)
	]),
	'fiio-dm15-r2r': fiio(
		{ disabledPresetId: 240 },
		[...BYPASS(240), ...FIIO_STYLES, ...users(160, 10)],
		{
			experimental: true
		}
	),
	'jadeaudio-ja11': fiio(
		{ reportId: 2, disabledPresetId: 4 },
		presets([0, 'Vocal'], [1, 'Classic'], [2, 'Bass'], [3, 'USER1']),
		{ disconnectOnSave: true }
	),
	'jadeaudio-jiezi': fiio({ reportId: 2, disabledPresetId: 240 }, SNOWSKY),
	'snowsky-melody': fiio({ disabledPresetId: 240 }, SNOWSKY),
	'snowsky-tiny-a': fiio({ disabledPresetId: 240 }, SNOWSKY),
	'snowsky-tiny-b': fiio({ disabledPresetId: 240 }, SNOWSKY),

	// Walkplay chipset: product id groups, then named devices
	'walkplay-schemeno10-devices': walkplay(),
	'walkplay-schemeno11-devices': walkplay(SCHEME_NO11),
	'walkplay-schemeno13-devices': walkplay(),
	'walkplay-schemeno15-devices': walkplay(),
	'walkplay-schemeno16-devices': walkplay(),
	'walkplay-schemeno17-devices': walkplay(),
	'walkplay-schemeno18-devices': walkplay(),
	'walkplay-schemeno19-devices': walkplay(),
	'walkplay-schemeno20-devices': walkplay(),
	'walkplay-schemeno21-devices': walkplay(),
	'walkplay-cs43131-hifi-audio-dsp': walkplay(SCHEME_NO11),
	'walkplay-cs43198-hifi-dsp-audio': walkplay(),
	'walkplay-cs431xx': walkplay({ experimental: true }),
	'walkplay-dual-cs43198': walkplay({ experimental: true }),
	'walkplay-es9039': walkplay({ experimental: true }),
	'walkplay-es9039-hifi-dsp-audio': walkplay({ experimental: true }),
	'epz-tp13': walkplay(SCHEME_NO11),
	'moondrop-quark2': walkplay(SCHEME_NO11),
	'bgvp-mx1': walkplay({ experimental: true }),
	'crinear-protocol-max': walkplay(),
	'ddhifi-dsp-cable': walkplay(),
	'ddhifi-hifi-dsp-audio-with-pd': walkplay(),
	'letshuoer-dt04': walkplay({ experimental: true }),
	// devicePEQ also registers it as "DAWN PRO2" with the Moondrop protocol; the profile follows
	// the "DAWN PRO 2" entry.
	'moondrop-dawn-pro-2': walkplay(),
	'moondrop-hifi-with-pd': walkplay({ experimental: true }),
	'moondrop-md-qt-042': walkplay({ experimental: true }),
	'nicehck-octave': walkplay(),
	'tanchjim-ola-ii-dsp': walkplay(),
	'tanchjim-space-pro': walkplay(),
	'tanchjim-stargate-ii': walkplay(),
	'truthear-keyx': walkplay(),

	// Moondrop's Walkplay-derived protocol
	'moondrop-rays': moondrop,
	'moondrop-ag-rays': moondrop,
	'moondrop-marigold': moondrop,
	'moondrop-freedsp-pro': moondrop,
	'moondrop-freedsp-mini': moondrop,
	'moondrop-moonriver-3': moondrop,
	'moondrop-echo-a': moondrop,
	'moondrop-dha15': moondrop,
	'moondrop-deco-audio-system': moondrop,
	'moondrop-inn-deco75-dh-audio': moondrop,
	'ddhifi-dsp-iem': moondrop,
	'moondrop-old-fashioned': { handler: 'moondrop-old-fashioned-hid', slots: CUSTOM(0) },
	'moondrop-freedsp': { handler: 'conexant-usb-hid' },
	'moondrop-echo-b': { handler: 'conexant-usb-hid' },

	// KT Micro
	'jcally-kt02h20': ktmicro({ options: { freqScale: 2 } }),
	'kiwi-ears-allegro-pro': ktmicro({ disconnectOnSave: true }),
	'kiwi-ears-allegro-mini': ktmicro({ disconnectOnSave: true }),
	'kiwi-ears-kt0211l-devices': ktmicro({ disconnectOnSave: true }),
	'kiwi-ears-chorus': ktmicro({
		disconnectOnSave: true,
		// Band 4's Q is at 0x3F; 0x3E is a phantom register.
		options: {
			bandRegisters: [
				{ freq: 0x35, q: 0x36 },
				{ freq: 0x37, q: 0x38 },
				{ freq: 0x39, q: 0x3a },
				{ freq: 0x3b, q: 0x3c },
				{ freq: 0x3d, q: 0x3f }
			]
		}
	}),
	'kiwi-ears-s-link': ktmicro({
		disconnectOnSave: true,
		// Bands are stored out of order.
		options: {
			bandRegisters: [
				{ freq: 0x37, q: 0x38 },
				{ freq: 0x3b, q: 0x3c },
				{ freq: 0x3d, q: 0x3f },
				{ freq: 0x39, q: 0x3a },
				{ freq: 0x35, q: 0x36 }
			]
		}
	}),
	'moondrop-cdsp': ktmicro(),
	'moondrop-chu-2-dsp': ktmicro({ disconnectOnSave: true }),
	'tanchjim-bunny-dsp': ktmicro(),
	'tanchjim-fission': ktmicro(),
	'tanchjim-one-dsp': ktmicro(),

	// Other USB HID
	'fosi-audio-ds3': {
		handler: 'fosi-audio-usb-hid',
		slots: presets(
			[0, 'Bypass'],
			[7, 'Custom 1'],
			[8, 'Custom 2'],
			[9, 'Custom 3'],
			[10, 'Custom 4'],
			[11, 'Custom 5']
		)
	},
	// Write-only over USB; devicePEQ dropped it for that, modernGraphTool keeps it.
	'qudelix-5k': { handler: 'qudelix-usb-hid', experimental: true },

	// Serial and Bluetooth
	'jds-labs-element-iv': {
		handler: 'jds-labs-usb-serial',
		slots: presets([0, 'Headphones'], [1, 'RCA'])
	},
	'fiio-audio-dsp': {
		handler: 'fiio-usb-serial',
		baudRate: 57600,
		slots: [
			...BYPASS(240),
			...presets(
				[0, 'Jazz'],
				[1, 'Pop'],
				[2, 'Rock'],
				[3, 'Dance'],
				[4, 'R&B'],
				[5, 'Classic'],
				[6, 'Hip Hop'],
				[8, 'Retro'],
				[9, 'De-essing-1'],
				[10, 'De-essing-2']
			),
			...users(160, 10)
		]
	},
	'nothing-headphone-1': {
		handler: 'nothing-usb-serial',
		slots: presets(
			[0, 'Balanced'],
			[1, 'Voice'],
			[2, 'More Treble'],
			[3, 'More Bass'],
			[5, 'Custom']
		)
	},
	'fiio-eh11': { handler: 'fiio-f110', baudRate: 115200, slots: CUSTOM_EQ },
	'fiio-eh13': { handler: 'fiio-f110', baudRate: 115200, slots: CUSTOM_EQ },
	'tanchjim-rita': { handler: 'tanchjim-rita-serial', slots: CUSTOM_EQ },
	'moondrop-edge': { handler: 'moondrop-edge-serial', baudRate: 115200, slots: CUSTOM_EQ },
	'edifier-w830nb': { handler: 'edifier-serial', baudRate: 115200, slots: CUSTOM_EQ },
	'audeze-maxwell': {
		handler: 'airoha',
		slots: presets([0, 'Preset 1'], [1, 'Preset 2'], [2, 'Preset 3'], [3, 'Preset 4'])
	}
};

/** How to drive the device a profile describes, or undefined if no handler is known. */
export function protocolFor(profileId: string): Protocol | undefined {
	return Object.hasOwn(PROTOCOLS, profileId) ? PROTOCOLS[profileId] : undefined;
}

/**
 * How to drive a device, from the profiles it matches, most specific first (the order of the
 * client's `matchDevice`): the protocol of the first one that has one, and which profile that
 * was. A device profile added under a group profile (SPEC §3) usually has no protocol of its own;
 * the device still matches the group, whose protocol drives it.
 */
export function protocolForMatches(
	matches: Iterable<{ id: string }>
): { profileId: string; protocol: Protocol } | undefined {
	for (const { id } of matches) {
		const protocol = protocolFor(id);
		if (protocol) return { profileId: id, protocol };
	}
	return undefined;
}

/**
 * Vendors whose devices mostly speak one protocol. For a device the database doesn't know, this
 * is a guess: the protocol is marked experimental, and without a profile a pull needs `bands`.
 */
const HID_VENDORS: readonly { vendorIds: readonly number[]; protocol: Protocol }[] = [
	{
		vendorIds: [0x2972, 0x0a12],
		protocol: fiio({}, [...FIIO_STYLES, ...presets([7, 'Monitor']), ...users(160, 10)])
	},
	{
		vendorIds: [
			0x0104, 0x011b, 0x011d, 0x0661, 0x0663, 0x0666, 0x0762, 0x0909, 0x0d8c, 0x2fc6, 0x3302,
			0x34be, 0x35d8, 0x36a7, 0x373b, 0x60c1, 0x60e1, 0xb445, 0xb44d
		],
		protocol: walkplay()
	},
	// Most older KT Micro firmware doubles the frequency it's given.
	{ vendorIds: [0x31b2], protocol: ktmicro({ options: { freqScale: 2 } }) },
	{ vendorIds: [0x152a], protocol: { handler: 'fosi-audio-usb-hid' } }
];

/** USB vendor ids the vendor guesses cover: a default filter for a browser's HID chooser. */
export const KNOWN_HID_VENDORS: readonly number[] = HID_VENDORS.flatMap((v) => v.vendorIds);

/** The protocol a HID device's vendor usually speaks, marked experimental; undefined if none. */
export function guessProtocol(vendorId: number): Protocol | undefined {
	const v = HID_VENDORS.find((x) => x.vendorIds.includes(vendorId));
	return v && { ...v.protocol, experimental: true };
}
