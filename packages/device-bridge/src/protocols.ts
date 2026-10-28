// How to drive a device (D33, D42). A profile's `protocol` names the handler and the settings that
// differ between the devices it drives: options, preset slots, transport details. The database
// holds them, so a device on a known protocol needs a profile and no bridge release; this module
// checks what the data says against the handlers this bridge has. The wire formats themselves are
// in the handlers (invariant 2).

import type { Control } from '@potatosalad775/eqcaps-core';
import type { AnyHandler, Slot } from './handler.ts';
import { HANDLERS, type HandlerId, type HandlerOptions } from './handlers/index.ts';

interface ProtocolBase {
	/**
	 * EQ preset slots the device offers; the one marked `bypass` turns the EQ off, and those marked
	 * `writable` are the ones a user may write to.
	 */
	presets?: readonly Slot[];
	/** The device drops the connection after a push that saves. */
	disconnectOnSave?: boolean;
	/** The protocol for this device is unconfirmed. */
	experimental?: boolean;
	/** Serial ports: the baud rate. Default 115200 over USB, 9600 over Bluetooth. */
	baudRate?: number;
	/** The device's controls besides the EQ that this bridge's handler drives (SPEC §9.1). */
	controls?: readonly Control[];
}

/** How to drive one device: a handler and its settings. */
export type Protocol = {
	[K in HandlerId]: ProtocolBase & { handler: K; options?: HandlerOptions<K> };
}[HandlerId];

// --- Reading a profile's protocol -----------------------------------------------------------------

/** Reads one option value from the data, or says why it can't. */
type Read = (v: unknown) => unknown;

const fail = (why: string): never => {
	throw new Error(why);
};

/** A byte, written as a number or a hex string (`"0x3f"`, like the profiles' USB ids). */
const byte: Read = (v) => {
	const n = typeof v === 'string' && /^0x[0-9a-f]{1,2}$/.test(v) ? parseInt(v, 16) : v;
	return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xff
		? n
		: fail(`${JSON.stringify(v)} is not a byte`);
};

/** Any finite number. */
const number: Read = (v) =>
	typeof v === 'number' && Number.isFinite(v) ? v : fail(`${JSON.stringify(v)} is not a number`);

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** KT Micro's per-band register pairs. */
const registers: Read = (v) =>
	Array.isArray(v) && v.length > 0
		? v.map((r: unknown) => {
				if (!isObject(r) || Object.keys(r).some((k) => k !== 'freq' && k !== 'q')) {
					fail(`${JSON.stringify(r)} is not a register pair`);
				}
				const { freq, q } = r as Record<string, unknown>;
				return { freq: byte(freq), q: byte(q) };
			})
		: fail('not a list of register pairs');

/**
 * The options a profile may set, per handler. Options a handler derives itself (Qudelix's report
 * from the descriptor, Airoha's layout from the transport) aren't data and are left out.
 */
const OPTIONS: { readonly [K in HandlerId]: { readonly [O in keyof HandlerOptions<K>]?: Read } } = {
	'fiio-usb-hid': { reportId: byte, saveCommand: byte },
	'walkplay-hid': { defaultSlot: byte },
	'moondrop-usb-hid': {},
	'moondrop-old-fashioned-hid': {},
	'conexant-usb-hid': {},
	'ktmicro-usb-hid': {
		baseRegister: byte,
		bandRegisters: registers,
		customSlot: byte
	},
	'fosi-audio-usb-hid': { reportId: byte, bandwidth: number, defaultSlot: byte },
	'qudelix-usb-hid': {},
	'jds-labs-usb-serial': {},
	'nothing-usb-serial': { customSlot: byte },
	'fiio-usb-serial': { saveCommand: byte },
	'fiio-f110': {},
	'tanchjim-rita-serial': {},
	'moondrop-edge-serial': {},
	'edifier-serial': {},
	airoha: {}
};

const KINDS: ReadonlySet<string> = new Set(['toggle', 'choice', 'range']);
const ROLES: ReadonlySet<string> = new Set([
	'volume',
	'output-gain',
	'dac-filter',
	'upsampling',
	'usb-mode',
	'sound-mode',
	'light',
	'tone-bass',
	'tone-treble'
]);

const numbers = (v: unknown, what: string): number[] =>
	Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
		? v
		: fail(`${what}: not a list of numbers`);

/**
 * A profile's controls. Strict (CI): every control must be one this bridge's handler drives,
 * with a kind and role it knows. Lenient (apps, SPEC §9.1): such controls are left out, and an
 * unknown role alone is dropped, so newer data never stops a device from being driven.
 */
function readControls(raw: unknown, id: HandlerId, strict: boolean): Control[] {
	const driven: object = (HANDLERS[id] as AnyHandler).controls ?? {};
	const out: Control[] = [];
	for (const c of Array.isArray(raw) ? raw : fail('controls: not a list')) {
		if (!isObject(c)) fail('controls: not an object');
		const {
			id: key,
			name,
			kind,
			role,
			values,
			range,
			unit,
			when,
			firmware,
			disablesEq,
			reconnect
		} = c as Record<string, unknown>;
		if (typeof key !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(key)) {
			fail(`controls: id ${JSON.stringify(key)}`);
		}
		const at = `controls.${key as string}`;
		const skip = (why: string) => (strict ? fail(`${at}: ${why}`) : undefined);
		if (!Object.hasOwn(driven, key as string)) {
			skip(`${id} has no control "${key as string}"`);
			continue;
		}
		if (typeof kind !== 'string' || !KINDS.has(kind)) {
			skip(`unknown kind ${JSON.stringify(kind)}`);
			continue;
		}
		if (typeof name !== 'string' || !name) fail(`${at}: name`);
		const control: Control = {
			id: key as string,
			name: name as string,
			kind: kind as Control['kind']
		};
		if (role !== undefined) {
			if (typeof role === 'string' && ROLES.has(role))
				control.role = role as NonNullable<Control['role']>;
			else skip(`unknown role ${JSON.stringify(role)}`);
		}
		if (kind === 'choice') {
			if (!Array.isArray(values) || values.length < 2) fail(`${at}: values`);
			control.values = (values as unknown[]).map((v) => {
				const { value, name: label } = isObject(v) ? v : fail(`${at}: values`);
				if (typeof value !== 'number' || !Number.isFinite(value))
					fail(`${at}: value ${String(value)}`);
				if (typeof label !== 'string' || !label) fail(`${at}: name of value ${String(value)}`);
				return { value: value as number, name: label as string };
			});
		} else if (values !== undefined) fail(`${at}: values on a ${kind}`);
		if (kind === 'range') {
			const { min, max, step } = isObject(range) ? range : fail(`${at}: range`);
			const [lo, hi] = numbers([min, max], `${at}: range`);
			if (step !== undefined && !(typeof step === 'number' && step > 0)) fail(`${at}: step`);
			control.range =
				step === undefined ? { min: lo!, max: hi! } : { min: lo!, max: hi!, step: step as number };
			if (unit !== undefined) control.unit = unit === 'dB' ? 'dB' : fail(`${at}: unit`);
		} else if (range !== undefined || unit !== undefined) fail(`${at}: range on a ${kind}`);
		if (when !== undefined) {
			const { control: other, values: held } = isObject(when) ? when : fail(`${at}: when`);
			if (typeof other !== 'string') fail(`${at}: when.control`);
			control.when = { control: other as string, values: numbers(held, `${at}: when.values`) };
		}
		if (firmware !== undefined) {
			const { min, max } = isObject(firmware) ? firmware : fail(`${at}: firmware`);
			if ([min, max].some((v) => v !== undefined && typeof v !== 'string') || (!min && !max)) {
				fail(`${at}: firmware`);
			}
			control.firmware = {
				...(min !== undefined ? { min: min as string } : {}),
				...(max !== undefined ? { max: max as string } : {})
			};
		}
		if (disablesEq !== undefined) control.disablesEq = numbers(disablesEq, `${at}: disablesEq`);
		if (reconnect !== undefined) {
			control.reconnect = typeof reconnect === 'boolean' ? reconnect : fail(`${at}: reconnect`);
		}
		out.push(control);
	}
	return out;
}

function read(raw: unknown, strict = false): Protocol {
	if (!isObject(raw)) fail('not an object');
	const { handler, options, presets, disconnectOnSave, experimental, baudRate, controls } =
		raw as Record<string, unknown>;
	if (typeof handler !== 'string' || !Object.hasOwn(HANDLERS, handler)) {
		fail(`this bridge has no handler "${String(handler)}"`);
	}
	const id = handler as HandlerId;
	const out: Record<string, unknown> = { handler: id };
	if (options !== undefined) {
		if (!isObject(options)) fail('options: not an object');
		const known: Record<string, Read | undefined> = OPTIONS[id];
		const parsed: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(options as Record<string, unknown>)) {
			if (k.startsWith('x-')) continue;
			const option = Object.hasOwn(known, k) ? known[k] : undefined;
			if (!option) fail(`options: ${id} has no option "${k}"`);
			try {
				parsed[k] = option!(v);
			} catch (e) {
				fail(`options.${k}: ${(e as Error).message}`);
			}
		}
		if (Object.keys(parsed).length) out.options = parsed;
	}
	if (presets !== undefined) {
		const ids = new Set<number>();
		let bypassed = false;
		out.presets = (Array.isArray(presets) ? presets : fail('presets: not a list')).map((p) => {
			const { id: slot, name, bypass, writable } = isObject(p) ? p : fail('presets: not an object');
			if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0) {
				fail(`presets: id ${JSON.stringify(slot)}`);
			}
			if (typeof name !== 'string' || !name) fail(`presets: name of ${String(slot)}`);
			if (ids.has(slot as number)) fail(`presets: id ${String(slot)} twice`);
			ids.add(slot as number);
			if (writable !== undefined && typeof writable !== 'boolean') {
				fail(`presets: writable of ${String(slot)} is not a boolean`);
			}
			if (bypass === undefined || bypass === false) {
				return writable ? { id: slot, name, writable: true } : { id: slot, name };
			}
			if (bypass !== true) fail(`presets: bypass of ${String(slot)} is not a boolean`);
			if (writable) fail(`presets: bypass preset ${String(slot)} is writable`);
			if (bypassed) fail('presets: more than one bypass preset');
			if (!HANDLERS[id].bypassPreset) fail(`presets: ${id} turns the EQ off without a preset`);
			bypassed = true;
			return { id: slot, name, bypass: true };
		});
	}
	for (const [k, v] of [
		['disconnectOnSave', disconnectOnSave],
		['experimental', experimental]
	] as const) {
		if (v !== undefined) out[k] = typeof v === 'boolean' ? v : fail(`${k}: not a boolean`);
	}
	if (baudRate !== undefined) {
		out.baudRate =
			typeof baudRate === 'number' && Number.isInteger(baudRate) && baudRate > 0
				? baudRate
				: fail('baudRate: not a positive integer');
	}
	if (controls !== undefined) {
		const list = readControls(controls, id, strict);
		if (list.length) out.controls = list;
	}
	return out as unknown as Protocol;
}

/**
 * Why this bridge can't drive a profile's `protocol`, or undefined when it can: a handler it
 * doesn't have (data newer than the bridge), or settings that handler doesn't take. Strict about
 * controls, which `protocolOf` leaves out when it doesn't know them.
 */
export function protocolProblem(raw: unknown): string | undefined {
	try {
		read(raw, true);
		return undefined;
	} catch (e) {
		return (e as Error).message;
	}
}

/**
 * How to drive the device a profile (or its index entry) describes: its `protocol`, checked
 * against this bridge's handlers. Undefined when it has none, or one this bridge can't drive.
 */
export function protocolOf(
	profile: { protocol?: unknown } | null | undefined
): Protocol | undefined {
	if (profile?.protocol === undefined) return undefined;
	try {
		return read(profile.protocol);
	} catch {
		return undefined;
	}
}

/**
 * How to drive a device, from the profiles it matches, most specific first: the client's
 * `matchDevice` matches (or the profiles or index entries themselves, in that order). Gives the
 * protocol of the first one that has one this bridge can drive, and which profile that was.
 */
export function protocolForMatches(
	matches: Iterable<{ id: string; protocol?: unknown; entry?: { protocol?: unknown } }>
): { profileId: string; protocol: Protocol } | undefined {
	for (const match of matches) {
		const protocol = protocolOf(match.entry ?? match);
		if (protocol) return { profileId: match.id, protocol };
	}
	return undefined;
}

// --- Devices without a profile --------------------------------------------------------------------

const presets = (...list: [number, string][]): Slot[] => list.map(([id, name]) => ({ id, name }));
const users = (first: number, count: number) =>
	presets(
		...Array.from({ length: count }, (_, i): [number, string] => [first + i, `USER${i + 1}`])
	);

/**
 * Vendors whose devices mostly speak one protocol. For a device the database doesn't know, this
 * is a guess: the protocol is marked experimental, and without a profile a pull needs `bands`.
 */
const HID_VENDORS: readonly { vendorIds: readonly number[]; protocol: Protocol }[] = [
	{
		vendorIds: [0x2972, 0x0a12],
		protocol: {
			handler: 'fiio-usb-hid',
			presets: [
				...presets(
					[0, 'Jazz'],
					[1, 'Pop'],
					[2, 'Rock'],
					[3, 'Dance'],
					[4, 'R&B'],
					[5, 'Classic'],
					[6, 'Hip-hop'],
					[7, 'Monitor']
				),
				...users(160, 10)
			]
		}
	},
	{
		vendorIds: [
			0x0104, 0x011b, 0x011d, 0x0661, 0x0663, 0x0666, 0x0762, 0x0909, 0x0d8c, 0x2fc6, 0x3302,
			0x34be, 0x35d8, 0x36a7, 0x373b, 0x60c1, 0x60e1, 0xb445, 0xb44d
		],
		protocol: { handler: 'walkplay-hid', presets: presets([101, 'Custom']) }
	},
	{
		vendorIds: [0x31b2],
		protocol: { handler: 'ktmicro-usb-hid', presets: presets([3, 'Custom']) }
	},
	{ vendorIds: [0x152a], protocol: { handler: 'fosi-audio-usb-hid' } }
];

/** USB vendor ids the vendor guesses cover: a default filter for a browser's HID chooser. */
export const KNOWN_HID_VENDORS: readonly number[] = HID_VENDORS.flatMap((v) => v.vendorIds);

/** The protocol a HID device's vendor usually speaks, marked experimental; undefined if none. */
export function guessProtocol(vendorId: number): Protocol | undefined {
	const v = HID_VENDORS.find((x) => x.vendorIds.includes(vendorId));
	return v && { ...v.protocol, experimental: true };
}
