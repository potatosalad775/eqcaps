// Qudelix 5K Plus over USB HID, as Qudelix's app for Chrome (version 4.0.3.1) drives it: the
// second protocol, messages of elements sent in acknowledged fragments. The framing, the session
// and the stored-preset layout are in `qudelix.ts`. Fields are packed least significant bit first,
// so the multi-byte ones are little-endian.
//
// EQ elements of a group, at 0x90 (the user EQ), 0xA0 (the speaker EQ) or 0xB0 (the all-band EQ of
// single-EQ mode), plus:
//   +0 configuration [version:4, on:1, 11 spare bits, headroom s8, preset index u8]
//   +2 preset attributes: the first 12 bytes of the stored preset, the type bit (1 parametric) first
//   +3 the stored preset
//   +4 preset name [group, custom n, length, 0, UTF-8…]
//   +5 one band [mask:4, type:4, band u8, freq u16, gain s16 ×10, q u16 ×1024]
// 0x80 is the EQ mode [version:4, mode:4 (0 layered, 1 single-EQ)]; 3 the firmware version
// [major, minor, revision, …]. A change is a set (0x9004) of one element; the action (0x9006)
// element 0x30 [group, custom n, 0, 0] saves the working EQ to a custom preset. A request (0x9002)
// [id, 0]… is answered (0x9003) by those elements. The opening answer and the notifications
// (0x9005) carry the configurations; a request asks for one only where the session has none.
//
// The app turns an EQ on by setting its whole configuration, makes it parametric by setting the
// attributes, and changes its pre-gain by setting the whole stored preset. So a push takes the
// configuration, requests the preset, and sends: the configuration with the switch on; the
// attributes with the type parametric (not on the speaker EQ, which is parametric only); for a
// pre-gain, the preset with it on every channel; one band element per band; for a slot, the name
// (empty: the default "Custom #n") and the save. The codec takes the configuration and the preset
// as options, so the frames it gives are the frames a push sends.

import { field, I16, readU16be, U16, U8 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type { Codec, HandlerContext, HidFrame, HidHandler, WriteState } from '../handler.ts';
import { decimals, sendFrame } from '../io.ts';
import type { HidTransport } from '../transport.ts';
import {
	ACK,
	ACTION,
	channelMasks,
	CUSTOM,
	customOf,
	EDITED,
	elementBytes,
	elementsOf,
	filterOf,
	FIVE_K_PLUS,
	groupOf,
	hidOut,
	modelFor,
	OFFLINE_LINK,
	packet,
	PARAMETRIC,
	presetSize,
	pullResult,
	QUDELIX_MODELS,
	QUDELIX_TYPES,
	QUDELIX_WIRE,
	qudelixSession,
	readPreset,
	Reassembly,
	REQ,
	sentPacket,
	SET,
	struct,
	withFields,
	writeBits,
	dropSession,
	type QudelixGroup,
	type QudelixGroupName,
	type QudelixLink,
	type QudelixSession
} from './qudelix.ts';

/** What the handler reads from the device before it writes. */
export interface QudelixV2DeviceState {
	link: QudelixLink;
	/** The device's packet size, 40 to 120 bytes. */
	packetSize: number;
	/** The device is in single-EQ mode: the user EQ is its all-band EQ. */
	single: boolean;
	/** The group's configuration element. */
	config: Uint8Array;
	/** The group's stored preset element. */
	preset: Uint8Array;
}

export interface QudelixV2UsbHidOptions {
	/** The EQ to drive: `usr`, the user EQ (default), or `spk`, the speaker (headphone) EQ. */
	group?: QudelixGroupName;
	/**
	 * Set by the handler. Without it the codec writes to a 5K Plus in its layered mode, from a
	 * zeroed configuration and preset, in 40-byte packets on report 8.
	 */
	device?: QudelixV2DeviceState;
}

const MODEL = QUDELIX_MODELS[FIVE_K_PLUS]!;
/** Each group's first element, by group id. */
const BASE = [0x90, 0xa0, 0xb0] as const;
const CONFIG = 0;
const ATTRIBUTES = 2;
const PRESET = 3;
const NAME = 4;
const BAND = 5;
const EQ_MODE = 0x80;
const FIRMWARE = 3;
const SAVE = 0x30;
const SINGLE = 1;
const MODE = struct(['version', 4], ['mode', 4], ['', 24]);
const BAND_ELEMENT = struct(
	['mask', 4],
	['filter', 4],
	['band', 8],
	['freq', 16],
	['gain', 16, 'signed'],
	['q', 16]
);
const SMALLEST_PACKET = 40;
const TIMEOUT = 2000;
const ACK_TIMEOUT = 1000;
const ACK_OK = 0;

/** A message as packets [command, header, slice]: `packetSize - 1` bytes of it in each. */
export function fragmentsOf(command: number, message: readonly number[], packetSize: number) {
	const out: number[][] = [];
	let at = 0;
	for (let id = 0; id === 0 || at < message.length; id++) {
		const slice = message.slice(at, at + packetSize - 1);
		at += slice.length;
		out.push(packet(command, [(id & 0x1f) | (at >= message.length ? 0x80 : 0), ...slice]));
	}
	return out;
}

function target(o: QudelixV2UsbHidOptions) {
	const single = o.device?.single ?? false;
	const group = groupOf(MODEL, o.group ?? 'usr', single);
	const device = o.device ?? {
		link: OFFLINE_LINK,
		packetSize: SMALLEST_PACKET,
		single,
		config: new Uint8Array(4),
		preset: new Uint8Array(presetSize(MODEL, group, group.channels[0]!))
	};
	return { device, group, base: BASE[group.id] };
}

export const qudelixV2UsbHidCodec: Codec<QudelixV2UsbHidOptions, HidFrame> = {
	types: QUDELIX_TYPES.types,
	wire: () => QUDELIX_WIRE,
	encode({ filters, preamp, slot }, o) {
		const { device, group, base } = target(o);
		if (filters.length > group.bands) {
			throw new BridgeError(
				'invalid-request',
				`Qudelix: the ${group.name} has ${group.bands} bands, not ${filters.length}`
			);
		}
		const channels = group.channels[0]!;
		const messages: [number, number[]][] = [];
		const set = (id: number, data: ArrayLike<number>) =>
			messages.push([SET, elementBytes(id, data)]);
		set(base + CONFIG, withFields(device.config, MODEL.groupConfig, { enable: 1 }));
		// The app's copy of the preset has the parametric type once it sets it.
		const preset = withFields(device.preset, MODEL.preset.head, { type: PARAMETRIC });
		if (group.graphic) set(base + ATTRIBUTES, preset.subarray(0, MODEL.preset.head.bits / 8));
		if (preamp !== undefined) {
			const value = field(preamp, 10, I16, 'preamp');
			for (let ch = 0; ch < channels; ch++) {
				writeBits(preset, MODEL.preset.head.bits + 16 * ch, 16, value);
			}
			set(base + PRESET, preset);
		}
		// Bands past the request keep what the device holds (D33).
		filters.forEach((f, band) => {
			const values = {
				filter: QUDELIX_TYPES.encode(f.type),
				band,
				freq: field(f.freq, 1, U16, 'freq'),
				gain: field(f.gain, 10, I16, 'gain'),
				q: field(f.q, 1024, U16, 'q')
			};
			for (const mask of channelMasks(group, channels)) {
				const bytes = new Uint8Array(BAND_ELEMENT.bits / 8);
				BAND_ELEMENT.write(bytes, { ...values, mask });
				set(base + BAND, bytes);
			}
		});
		if (slot !== undefined) {
			const n = customOf(group, slot);
			set(base + NAME, [group.id, n, 0, 0]);
			messages.push([ACTION, elementBytes(SAVE, [group.id, n, 0, 0])]);
		}
		return messages.flatMap(([command, message]) =>
			fragmentsOf(command, message, device.packetSize).map((p) => hidOut(device.link, p))
		);
	},
	decode(frames, o) {
		const { device, group, base } = target(o);
		const state: WriteState = { filters: [] };
		const reassembly = new Reassembly();
		for (const frame of frames) {
			const p = sentPacket(device.link, frame);
			const command = readU16be(p, 0);
			const message = reassembly.push(command, p.subarray(2));
			for (const e of (message && elementsOf(message)) ?? []) {
				if (command === ACTION && e.id === SAVE) state.slot = CUSTOM + e.data[1]!;
				if (command !== SET) continue;
				if (e.id === base + BAND) {
					const b = BAND_ELEMENT.read(e.data);
					state.filters[b.band] = filterOf(b);
				} else if (e.id === base + PRESET) {
					state.preamp = decimals(readPreset(MODEL, group, e.data)[0]!.preGain / 10, 1);
				}
			}
		}
		return state;
	}
};

type Ctx = HandlerContext<HidTransport, QudelixV2UsbHidOptions>;

/**
 * Sends fragments, each but the last of a message answered by its ack within 1 s. A missing or
 * bad ack, or a failed send, ends the session, as the app reconnects then.
 */
async function sendFragments(s: QudelixSession, frames: HidFrame[]) {
	try {
		for (const frame of frames) {
			const header = sentPacket(s.link, frame)[2]!;
			const id = header & 0x1f;
			if (header & 0x80) {
				await sendFrame(s.transport, frame);
				continue;
			}
			const ack = s.expect(
				(m) => m.command === ACK && m.payload.length === 2,
				ACK_TIMEOUT,
				`fragment ${id}`
			);
			ack.catch(() => {});
			await sendFrame(s.transport, frame);
			const [acked, result] = (await ack).payload;
			if (acked !== id || result !== ACK_OK) {
				throw new BridgeError(
					'rejected',
					`Qudelix 5K Plus: fragment ${id} got an ack of fragment ${acked} with result ${result}`
				);
			}
		}
	} catch (error) {
		dropSession(s);
		throw error;
	}
}

const send = (s: QudelixSession, command: number, message: readonly number[]) =>
	sendFragments(
		s,
		fragmentsOf(command, message, s.device.packetSize).map((p) => hidOut(s.link, p))
	);

/** Requests elements afresh: [id, 0] each, answered by the elements. */
async function request(s: QudelixSession, ids: number[]) {
	for (const id of ids) s.elements.delete(id);
	const answered = s.expect(
		() => ids.every((id) => s.elements.has(id)),
		TIMEOUT,
		`the request for elements ${ids.map((id) => `0x${id.toString(16)}`).join(', ')}`
	);
	answered.catch(() => {});
	await send(
		s,
		REQ,
		ids.flatMap((id) => [id, 0])
	);
	await answered;
}

/** Elements as the session holds them, requested where it has none. */
async function elements(s: QudelixSession, ids: number[]) {
	const missing = ids.filter((id) => !s.elements.has(id));
	if (missing.length) await request(s, missing);
	return ids.map((id) => s.elements.get(id)!);
}

/** The 5K Plus's session, the EQ the options name in its mode, and that EQ's configuration. */
async function drive(ctx: Ctx) {
	const s = await qudelixSession(ctx);
	modelFor(s, 2);
	const [mode] = await elements(s, [EQ_MODE]);
	const single = MODE.read(mode!).mode === SINGLE;
	const group: QudelixGroup = groupOf(MODEL, ctx.options.group ?? 'usr', single);
	const base = BASE[group.id];
	const [config] = await elements(s, [base + CONFIG]);
	return { s, group, single, base, config: config! };
}

/** The group's stored preset, requested afresh. */
async function storedPreset(s: QudelixSession, group: QudelixGroup, base: number) {
	await request(s, [base + PRESET]);
	const bytes = s.elements.get(base + PRESET)!;
	return { bytes, preset: readPreset(MODEL, group, bytes) };
}

export const qudelixV2UsbHid: HidHandler<QudelixV2UsbHidOptions> = {
	id: 'qudelix-v2-usb-hid',
	transport: 'hid',
	codec: qudelixV2UsbHidCodec,

	capabilities: () => ({
		canRead: true,
		canWrite: true,
		readsPreamp: true,
		readsSlot: false,
		writesPreamp: true,
		writesSlot: true,
		needsBandCount: false,
		readsCurrentSlot: true,
		canEnable: true
	}),

	async pull(ctx) {
		const { s, group, base, config } = await drive(ctx);
		const { preset } = await storedPreset(s, group, base);
		return pullResult(ctx.log, MODEL, group, preset, MODEL.groupConfig.read(config).preset);
	},

	async push(ctx, request) {
		const { s, group, single, base, config } = await drive(ctx);
		const { bytes } = await storedPreset(s, group, base);
		const frames = qudelixV2UsbHidCodec.encode(request, {
			...ctx.options,
			device: { link: s.link, packetSize: s.device.packetSize, single, config, preset: bytes }
		});
		await sendFragments(s, frames);
		// The app's copy after a push: on, and on the saved preset or an edited EQ.
		s.elements.set(
			base + CONFIG,
			withFields(config, MODEL.groupConfig, { enable: 1, preset: request.slot ?? EDITED })
		);
		return { reconnect: false };
	},

	async setEnabled(ctx, enabled, slot) {
		const { s, base, config } = await drive(ctx);
		const next = withFields(config, MODEL.groupConfig, {
			enable: enabled ? 1 : 0,
			...(enabled && slot !== undefined ? { preset: field(slot, 1, U8, 'slot') } : {})
		});
		await send(s, SET, elementBytes(base + CONFIG, next));
		s.elements.set(base + CONFIG, next);
	},

	async eqEnabled(ctx) {
		const { config } = await drive(ctx);
		return MODEL.groupConfig.read(config).enable === 1;
	},

	async currentSlot(ctx) {
		const { preset } = MODEL.groupConfig.read((await drive(ctx)).config);
		return preset === EDITED ? null : preset;
	},

	async firmware(ctx) {
		const s = await qudelixSession(ctx);
		modelFor(s, 2);
		const [version] = await elements(s, [FIRMWARE]);
		return Array.from(version!.subarray(0, 3)).join('.');
	},

	async bandCount(ctx) {
		return (await drive(ctx)).group.bands;
	}
};
