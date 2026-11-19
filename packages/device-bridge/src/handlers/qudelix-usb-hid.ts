// Qudelix 5K (firmware 3.0.0 and later) and T71 over USB HID, as Qudelix's app for Chrome
// (version 4.0.3.1) drives them: the first protocol, a 16-bit command and its bytes, big-endian.
// The framing, the session and the stored-preset layouts are in `qudelix.ts`.
//
// EQ commands name a group first (0 the user EQ, 1 the speaker EQ, 2 the 5K's all-band EQ in its
// single-EQ mode) and a channel mask where they take one: 1 << channel, or 3 for left and right
// together.
//   0x0700 [group, on]                 0x0701 [group, 1] (parametric; 0 is graphic)
//   0x0703 [group, mask, 0, pre-gain s16 ×10]
//   0x070F [group, mask, band, type, freq u16, gain s16 ×10, q u16 ×1024]
//   0x070A [group, custom n, length, UTF-8 name]   0x0708 [group, preset index] saves
//   0x0709 [group, preset index] loads
// A push is the switch on, the type (not on the speaker EQ, which is parametric only), the
// pre-gain, one band frame per band and channel, then, for a slot, the name (empty: the default
// "Custom #n") and the save. Reads: 0x0120 [mask] (0x80 on the 5K, 0x40 on the T71) is answered by
// 0x0121 [mask, EQ block]: [0, user configuration (4), its preset configuration (4), 1, speaker
// configuration (4), its preset configuration (4)], or on a 5K in single-EQ mode [2, all-band
// configuration (4), its preset configuration (4)]. 0x0123 [1 << group] is answered by 0x0128
// fragments of the stored preset [group, last << 4 | index, size u16, offset u16, bytes…].
// Firmware 2.x speaks another dialect, which this handler doesn't.

import { field, I16, readI16be, readU16be, U16, U8, be16 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type { Codec, HandlerContext, HidFrame, HidHandler, WriteState } from '../handler.ts';
import { decimals, sendFrame } from '../io.ts';
import type { HidTransport } from '../transport.ts';
import {
	channelMasks,
	customOf,
	EDITED,
	filterOf,
	FIVE_K,
	groupOf,
	hidOut,
	modelFor,
	OFFLINE_LINK,
	packet,
	PARAMETRIC,
	pullResult,
	QUDELIX_MODELS,
	QUDELIX_TYPES,
	QUDELIX_WIRE,
	qudelixSession,
	readPreset,
	sentPacket,
	T71,
	type QudelixGroup,
	type QudelixGroupName,
	type QudelixLink,
	type QudelixModel,
	type QudelixSession
} from './qudelix.ts';

/** What the handler learns from the device before it writes. */
export interface QudelixDeviceState {
	link: QudelixLink;
	model: QudelixModel;
	/** The 5K is in single-EQ mode: the user EQ is its all-band EQ. */
	single: boolean;
	/** The group's channel count (the T71's user EQ has 1 or 5). */
	channels: number;
}

export interface QudelixUsbHidOptions {
	/** The EQ to drive: `usr`, the user EQ (default), or `spk`, the speaker (headphone) EQ. */
	group?: QudelixGroupName;
	/** Set by the handler. Without it the codec writes to a 5K in its layered mode, on report 8. */
	device?: QudelixDeviceState;
}

const ENABLE = 0x0700;
const TYPE = 0x0701;
const PRE_GAIN = 0x0703;
const SAVE = 0x0708;
const LOAD = 0x0709;
const NAME = 0x070a;
const BAND = 0x070f;
const ASK_CONFIG = 0x0120;
const CONFIG = 0x0121;
const ASK_PRESET = 0x0123;
const PRESET = 0x0128;
const TIMEOUT = 2000;

/** The device-configuration bit of the EQ block, by device id. */
const EQ_CONFIG_MASK: Readonly<Record<number, number>> = { [FIVE_K]: 0x80, [T71]: 0x40 };

function target(o: QudelixUsbHidOptions) {
	const d = o.device ?? {
		link: OFFLINE_LINK,
		model: QUDELIX_MODELS[FIVE_K]!,
		single: false,
		channels: undefined
	};
	const group = groupOf(d.model, o.group ?? 'usr', d.single);
	return { link: d.link, group, masks: channelMasks(group, d.channels ?? group.channels[0]!) };
}

const s16 = (value: number, what: string) => be16(field(value, 10, I16, what) & 0xffff);

export const qudelixUsbHidCodec: Codec<QudelixUsbHidOptions, HidFrame> = {
	types: QUDELIX_TYPES.types,
	wire: () => QUDELIX_WIRE,
	encode({ filters, preamp, slot }, o) {
		const { link, group, masks } = target(o);
		const g = group.id;
		if (filters.length > group.bands) {
			throw new BridgeError(
				'invalid-request',
				`Qudelix: the ${group.name} has ${group.bands} bands, not ${filters.length}`
			);
		}
		const packets = [packet(ENABLE, [g, 1])];
		if (group.graphic) packets.push(packet(TYPE, [g, PARAMETRIC]));
		if (preamp !== undefined) {
			const value = s16(preamp, 'preamp');
			for (const mask of masks) packets.push(packet(PRE_GAIN, [g, mask, 0, ...value]));
		}
		// Bands past the request keep what the device holds (D33).
		filters.forEach((f, band) => {
			const values = [
				QUDELIX_TYPES.encode(f.type),
				...be16(field(f.freq, 1, U16, 'freq')),
				...s16(f.gain, 'gain'),
				...be16(field(f.q, 1024, U16, 'q'))
			];
			for (const mask of masks) packets.push(packet(BAND, [g, mask, band, ...values]));
		});
		if (slot !== undefined) {
			packets.push(packet(NAME, [g, customOf(group, slot), 0]), packet(SAVE, [g, slot]));
		}
		return packets.map((p) => hidOut(link, p));
	},
	decode(frames, o) {
		const { link } = target(o);
		const state: WriteState = { filters: [] };
		for (const frame of frames) {
			const p = sentPacket(link, frame);
			const command = readU16be(p, 0);
			if (command === BAND) {
				state.filters[p[4]!] = filterOf({
					filter: p[5]!,
					freq: readU16be(p, 6),
					gain: readI16be(p, 8),
					q: readU16be(p, 10)
				});
			} else if (command === PRE_GAIN) state.preamp = decimals(readI16be(p, 5) / 10, 1);
			else if (command === SAVE) state.slot = p[3]!;
		}
		return state;
	}
};

type Ctx = HandlerContext<HidTransport, QudelixUsbHidOptions>;

/** The session of a 5K or T71; refuses another model, and 5K firmware older than 3.0.0. */
async function open(ctx: Ctx) {
	const s = await qudelixSession(ctx);
	const model = modelFor(s, 1);
	const [major = 0] = s.device.firmware ?? [];
	if (s.device.id === FIVE_K && major < 3) {
		throw new BridgeError(
			'unsupported',
			major < 2
				? `Qudelix 5K: firmware ${s.device.firmware?.join('.')} is older than 2.0.0, which the app refuses too; update the firmware`
				: `Qudelix 5K: firmware ${s.device.firmware?.join('.')} speaks the 2.x EQ commands, which this bridge doesn't; update to 3.0.0 or later`
		);
	}
	return { s, model };
}

/** The EQ block: the mode, and each group's configuration, by group id. */
async function readConfig(s: QudelixSession, model: QudelixModel) {
	const mask = EQ_CONFIG_MASK[s.device.id]!;
	const { payload } = await s.ask(
		packet(ASK_CONFIG, [mask]),
		(m) => m.command === CONFIG && m.payload[0] === mask,
		TIMEOUT,
		'the EQ configuration request'
	);
	const block = payload.subarray(1);
	// The groups' configurations, each 4 bytes and followed by 4 of preset configuration.
	const single = model.all !== undefined && block[0] !== 0;
	const placed: [QudelixGroup, number][] = single
		? [[model.all!, 1]]
		: [
				[model.usr, 1],
				[model.spk, 10]
			];
	if (block.length < placed.at(-1)![1] + 8) {
		throw new BridgeError('bad-response', `Qudelix ${model.name}: a short EQ configuration`);
	}
	const groups = new Map(placed.map(([g, at]) => [g.id, model.groupConfig.read(block, at * 8)]));
	return { single, groups };
}

/** The EQ the options name, in the device's mode, and its configuration. */
async function drive(ctx: Ctx) {
	const { s, model } = await open(ctx);
	const config = await readConfig(s, model);
	const group = groupOf(model, ctx.options.group ?? 'usr', config.single);
	return { s, model, group, single: config.single, config: config.groups.get(group.id)! };
}

/** The group's stored preset, reassembled from its fragments. */
async function readStored(s: QudelixSession, model: QudelixModel, group: QudelixGroup) {
	const bytes: number[] = [];
	let next = 0;
	let last = -1;
	const take = (d: Uint8Array) => {
		if (d.length < 6 || d[0] !== group.id) return false;
		const index = d[1]! & 15;
		const lastIndex = d[1]! >> 4;
		const size = readU16be(d, 2);
		const offset = readU16be(d, 4);
		if (index === 0) {
			bytes.length = 0;
			next = 0;
			last = offset === 0 ? lastIndex : -1;
		}
		if (index !== next || lastIndex !== last || offset !== bytes.length || 6 + size > d.length) {
			last = -1;
			return false;
		}
		bytes.push(...d.subarray(6, 6 + size));
		next++;
		return index === last;
	};
	await s.ask(
		packet(ASK_PRESET, [1 << group.id]),
		(m) => m.command === PRESET && take(m.payload),
		TIMEOUT,
		`the ${group.name} preset request`
	);
	return readPreset(model, group, Uint8Array.from(bytes));
}

export const qudelixUsbHid: HidHandler<QudelixUsbHidOptions> = {
	id: 'qudelix-usb-hid',
	transport: 'hid',
	codec: qudelixUsbHidCodec,

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
		const { s, model, group, config } = await drive(ctx);
		const preset = await readStored(s, model, group);
		return pullResult(ctx.log, model, group, preset, config.preset);
	},

	async push(ctx, request) {
		const { s, model, group, single } = await drive(ctx);
		// The T71 says how many channels a group has only in its stored preset.
		const channels = model.preset.head.has('channels')
			? (await readStored(s, model, group)).length
			: group.channels[0]!;
		const frames = qudelixUsbHidCodec.encode(request, {
			...ctx.options,
			device: { link: s.link, model, single, channels }
		});
		for (const frame of frames) await sendFrame(ctx.transport, frame);
		return { reconnect: false };
	},

	async setEnabled(ctx, enabled, slot) {
		const { s, group } = await drive(ctx);
		const index = enabled && slot !== undefined ? field(slot, 1, U8, 'slot') : undefined;
		await s.send(packet(ENABLE, [group.id, enabled ? 1 : 0]));
		if (index !== undefined) await s.send(packet(LOAD, [group.id, index]));
	},

	async eqEnabled(ctx) {
		return (await drive(ctx)).config.enable === 1;
	},

	async currentSlot(ctx) {
		const { preset } = (await drive(ctx)).config;
		return preset === EDITED ? null : preset;
	},

	async firmware(ctx) {
		const s = await qudelixSession(ctx);
		modelFor(s, 1);
		return s.device.firmware?.join('.') ?? null;
	},

	async bandCount(ctx) {
		return (await drive(ctx)).group.bands;
	}
};
