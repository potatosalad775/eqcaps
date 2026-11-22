// Qudelix 5K (firmware 3.0.0 and later) and T71 over USB HID, as Qudelix's app for Chrome
// (version 4.0.3.1) drives them: the first protocol, a 16-bit command and its bytes, big-endian.
// The framing, the session and the stored-preset layouts are in `qudelix.ts`.
//
// EQ commands name a group first (0 the user EQ, 1 the speaker EQ, 2 the 5K's all-band EQ in its
// single-EQ mode) and a channel mask where they take one: 1 << channel, or 3 for left and right
// together. The app's Both, Left and Right selector on the speaker EQ is its own state, never sent
// or read: it picks mask 3, 1 or 2 for the pre-gain and each band edit.
//   0x0700 [group, on]                 0x0701 [group, 1] (parametric; 0 is graphic)
//   0x0703 [group, mask, 0, pre-gain s16 ×10]
//   0x070F [group, mask, band, type, freq u16, gain s16 ×10, q u16 ×1024]
//   0x070A [group, custom n, length, UTF-8 name]   0x0708 [group, preset index] saves
//   0x0709 [group, preset index] loads
// A push is the switch on, the type (not on the speaker EQ, which is parametric only), the
// pre-gain, one band frame per band and channel mask (on the speaker EQ 3, or with the right
// channel apart 1 and 2), each waiting for the device's echo of it (a 0x2000 notification [0x89,
// group, mask, band, …]), then, for a slot, the name (empty: the default "Custom #n") and the save.
// Reads: 0x0120 [mask] (0x80 on the 5K, 0x40 on the T71) is answered by 0x0121 [mask, EQ block]:
// [0, user configuration (4), its preset configuration (4), 1, speaker configuration (4), its
// preset configuration (4)], or on a 5K in single-EQ mode [2, all-band configuration (4), its
// preset configuration (4)]. 0x0123 [1 << group] is answered by 0x0128 fragments of the stored
// preset [group, last << 4 | index, size u16, offset u16, bytes…], each channel's apart.
// Firmware 2.x speaks another dialect, which this handler doesn't.
//
// Settings besides the EQ's bands (the bridge's controls), each one command, which the device
// answers with a notification and holds at once (a 5K with firmware 3.2.9, 2026-11-22):
//   0x0702 [group, headroom s8 ×10]         read from the group's configuration
//   0x070D [group, mask, 0, crossfeed u16]  read from the stored preset's first fields
//   0x0501 [DAC filter]   0x0505 [gain]     read from the 5K's DAC block, 0x0120 [0x08]
// The app's headroom selector and crossfeed slider work only while that EQ is on, so a write to
// either is refused while it is off. Neither moves the EQ off its stored preset on the device.

import { field, I16, I8, readI16be, readU16be, U16, U8, be16 } from '../bytes.ts';
import { BridgeError } from '../errors.ts';
import type {
	Codec,
	HandlerContext,
	HandlerControl,
	HidFrame,
	HidHandler,
	WriteState
} from '../handler.ts';
import { decimals, sendFrame } from '../io.ts';
import type { HidTransport } from '../transport.ts';
import {
	bandWrites,
	channelWrites,
	customOf,
	EDITED,
	filterOf,
	FIVE_K,
	groupIn,
	groupOf,
	hidOut,
	maskedChannels,
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
	struct,
	T71,
	writtenState,
	type Held,
	type QudelixGroup,
	type QudelixGroupName,
	type QudelixLink,
	type QudelixModel,
	type QudelixSession,
	type Struct
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

/**
 * What the handler tells its codec. None of it is a profile's option: the handler takes none, and
 * works these out from the operation and the device.
 */
export interface QudelixUsbHidCodecOptions {
	/**
	 * The EQ the frames are for: `usr`, the user EQ (default), or `spk`, the speaker (headphone)
	 * EQ. Set by the handler, from the operation's EQ (SPEC §9.2).
	 */
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
const HEADROOM = 0x0702;
const CROSSFEED = 0x070d;
const DAC_FILTER = 0x0501;
const DAC_GAIN = 0x0505;
const ASK_CONFIG = 0x0120;
const CONFIG = 0x0121;
const ASK_PRESET = 0x0123;
const PRESET = 0x0128;
const TIMEOUT = 2000;
/** The device's notification of a change it made, and the kind that echoes a band write. */
const NOTIFICATION = 0x2000;
const BAND_ECHO = 0x89;
const ECHO_TIMEOUT = 250;

/** The device-configuration bit of the EQ block, by device id. */
const EQ_CONFIG_MASK: Readonly<Record<number, number>> = { [FIVE_K]: 0x80, [T71]: 0x40 };
/** The 5K's DAC block: its configuration bit, and the two settings of its 4 bytes driven here. */
const DAC_CONFIG_MASK = 0x08;
const DAC_CONFIG = struct(['', 5], ['gain', 1], ['', 12], ['filter', 4], ['', 10]);

function target(o: QudelixUsbHidCodecOptions) {
	const d = o.device ?? {
		link: OFFLINE_LINK,
		model: QUDELIX_MODELS[FIVE_K]!,
		single: false,
		channels: undefined
	};
	const group = groupOf(d.model, o.group ?? 'usr', d.single);
	return { link: d.link, group, channels: d.channels ?? group.channels[0]! };
}

const s16 = (value: number, what: string) => be16(field(value, 10, I16, what) & 0xffff);

export const qudelixUsbHidCodec: Codec<QudelixUsbHidCodecOptions, HidFrame> = {
	types: QUDELIX_TYPES.types,
	wire: () => QUDELIX_WIRE,
	encode(request, o) {
		const { link, group, channels } = target(o);
		const g = group.id;
		const writes = channelWrites(group, channels, request);
		const packets = [packet(ENABLE, [g, 1])];
		if (group.graphic) packets.push(packet(TYPE, [g, PARAMETRIC]));
		for (const { mask, preamp } of writes) {
			if (preamp === undefined) continue;
			packets.push(packet(PRE_GAIN, [g, mask, 0, ...s16(preamp, 'preamp')]));
		}
		// Bands past the request keep what the device holds (D33).
		for (const { mask, band, filter: f } of bandWrites(writes)) {
			packets.push(
				packet(BAND, [
					g,
					mask,
					band,
					QUDELIX_TYPES.encode(f.type),
					...be16(field(f.freq, 1, U16, 'freq')),
					...s16(f.gain, 'gain'),
					...be16(field(f.q, 1024, U16, 'q'))
				])
			);
		}
		const { slot } = request;
		if (slot !== undefined) {
			packets.push(packet(NAME, [g, customOf(group, slot), 0]), packet(SAVE, [g, slot]));
		}
		return packets.map((p) => hidOut(link, p));
	},
	decode(frames, o) {
		const { link, group } = target(o);
		const held: Held = [];
		let slot: number | undefined;
		for (const frame of frames) {
			const p = sentPacket(link, frame);
			const command = readU16be(p, 0);
			// Every EQ write names its group first: another EQ's frames are not this one's state.
			if (p[2] !== group.id) continue;
			if (command === BAND) {
				const filter = filterOf({
					filter: p[5]!,
					freq: readU16be(p, 6),
					gain: readI16be(p, 8),
					q: readU16be(p, 10)
				});
				for (const ch of maskedChannels(held, p[3]!)) ch.filters[p[4]!] = filter;
			} else if (command === PRE_GAIN) {
				const preamp = decimals(readI16be(p, 5) / 10, 1);
				for (const ch of maskedChannels(held, p[3]!)) ch.preamp = preamp;
			} else if (command === SAVE) slot = p[3]!;
		}
		const state: WriteState = writtenState(group, held);
		return slot === undefined ? state : { ...state, slot };
	}
};

type Ctx = HandlerContext<HidTransport, object>;

/** The EQ an operation names (`spk`), or the user EQ. */
const groupName = (ctx: Ctx): QudelixGroupName => (ctx.eq === 'spk' ? 'spk' : 'usr');

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

/** One block of the device's configuration, asked for by its bit alone. */
async function configBlock(s: QudelixSession, mask: number, what: string) {
	const { payload } = await s.ask(
		packet(ASK_CONFIG, [mask]),
		(m) => m.command === CONFIG && m.payload[0] === mask,
		TIMEOUT,
		`the ${what} configuration request`
	);
	return payload.subarray(1);
}

/** The EQ block: the mode, and each group's configuration, by group id. */
async function readConfig(s: QudelixSession, model: QudelixModel) {
	const block = await configBlock(s, EQ_CONFIG_MASK[s.device.id]!, 'EQ');
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

/** The session, the device's EQ mode and each group's configuration, asked for now. */
async function mode(ctx: Ctx) {
	const { s, model } = await open(ctx);
	return { s, model, ...(await readConfig(s, model)) };
}

/** The EQ `name` (default: the one the operation names), in the device's mode, and its configuration. */
async function drive(ctx: Ctx, name = groupName(ctx)) {
	const { s, model, single, groups } = await mode(ctx);
	const group = groupOf(model, name, single);
	return { s, model, group, single, config: groups.get(group.id)! };
}

/** `drive`, or nothing where the device's mode has no such EQ. */
async function driveIfThere(ctx: Ctx, name: QudelixGroupName) {
	const { s, model, single, groups } = await mode(ctx);
	const group = groupIn(model, name, single);
	return group && { s, model, group, config: groups.get(group.id)! };
}

/** The group's stored preset, reassembled from its fragments. */
async function readStored(s: QudelixSession, model: QudelixModel, group: QudelixGroup) {
	return readPreset(model, group, await storedBytes(s, group));
}

/** The bytes of the group's stored preset, reassembled from their fragments. */
async function storedBytes(s: QudelixSession, group: QudelixGroup) {
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
	return Uint8Array.from(bytes);
}

type Control = HandlerControl<HidTransport, object>;

/** Refuses a write to a setting of an EQ that is off: the app's editor holds it still then. */
function whileOn(model: QudelixModel, group: QudelixGroup, enable: number, what: string) {
	if (enable === 1) return;
	throw new BridgeError(
		'rejected',
		`Qudelix ${model.name}: the ${group.name} is off, and the app sets its ${what} only while it is on`
	);
}

/** An EQ's headroom, in dB: 0x0702 [group, dB ×10], held in the group's configuration. */
const headroom = (name: QudelixGroupName): Control => ({
	async read(ctx) {
		const there = await driveIfThere(ctx, name);
		return there ? there.config.headroom / 10 : null;
	},
	async write(ctx, value) {
		const { s, model, group, config } = await drive(ctx, name);
		whileOn(model, group, config.enable, 'headroom');
		await s.send(packet(HEADROOM, [group.id, field(value, 10, I8, 'headroom') & 0xff]));
	}
});

/**
 * The crossfeed of the EQ the profile describes (the user EQ, or the all-band EQ of single-EQ
 * mode): 0x070D [group, 1, 0, level u16], held in the stored preset's first fields. The T71 holds
 * a front and a back level, which this doesn't drive.
 */
const crossfeed: Control = {
	async read(ctx) {
		const { s, model, group } = await drive(ctx, 'usr');
		return crossfeedField(model).read(await storedBytes(s, group)).xfeed;
	},
	async write(ctx, value) {
		const { s, model, group, config } = await drive(ctx, 'usr');
		crossfeedField(model);
		whileOn(model, group, config.enable, 'crossfeed');
		await s.send(packet(CROSSFEED, [group.id, 1, 0, ...be16(field(value, 1, U16, 'crossfeed'))]));
	}
};

function crossfeedField(model: QudelixModel) {
	if (model.preset.head.has('xfeed')) return model.preset.head as Struct<'xfeed'>;
	throw new BridgeError(
		'unsupported',
		`Qudelix ${model.name}: its crossfeed has a front and a back level, which this bridge doesn't drive`
	);
}

/** A setting of the 5K's DAC block: one command with the value, read from the block's field. */
const dacSetting = (command: number, name: 'gain' | 'filter'): Control => {
	const session = async (ctx: Ctx) => {
		const { s, model } = await open(ctx);
		if (s.device.id === FIVE_K) return s;
		throw new BridgeError(
			'unsupported',
			`Qudelix ${model.name}: its DAC settings are laid out differently, which this bridge doesn't drive`
		);
	};
	return {
		async read(ctx) {
			return DAC_CONFIG.read(await configBlock(await session(ctx), DAC_CONFIG_MASK, 'DAC'))[name];
		},
		async write(ctx, value) {
			await (await session(ctx)).send(packet(command, [field(value, 1, U8, name)]));
		}
	};
};

export const qudelixUsbHid: HidHandler = {
	id: 'qudelix-usb-hid',
	transport: 'hid',
	eqs: ['spk'],
	codec: qudelixUsbHidCodec,

	capabilities: (_transport, _options, eq) => ({
		canRead: true,
		canWrite: true,
		readsPreamp: true,
		readsSlot: false,
		writesSlot: true,
		needsBandCount: false,
		// The speaker EQ's left and right, as the app's channel selector writes them.
		perChannel: eq === 'spk'
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
			group: groupName(ctx),
			device: { link: s.link, model, single, channels }
		});
		// A 5K echoes each band write in a notification, about 6 ms later. The app sends one band
		// per edit; a whole EQ's bands back to back (20 in single-EQ mode) can leave a 5K deaf to
		// what follows, so each band waits for its echo. A device that doesn't echo the first one
		// gets the rest back to back.
		let echoes = true;
		for (const frame of frames) {
			const p = sentPacket(s.link, frame);
			if (!echoes || readU16be(p, 0) !== BAND) {
				await sendFrame(ctx.transport, frame);
				continue;
			}
			const echo = s.expect(
				({ command, payload: e }) =>
					command === NOTIFICATION &&
					e[0] === BAND_ECHO &&
					e[1] === p[2] &&
					e[2] === p[3] &&
					e[3] === p[4],
				ECHO_TIMEOUT,
				'a band write'
			);
			const heard = echo.then(
				() => true,
				() => false
			);
			await sendFrame(ctx.transport, frame);
			echoes = await heard;
			if (!echoes)
				ctx.log(`Qudelix ${model.name}: no echo of a band write; sending the rest at once`);
		}
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
	},

	controls: {
		headroom: headroom('usr'),
		headroomSpk: headroom('spk'),
		crossfeed,
		dacFilter: dacSetting(DAC_FILTER, 'filter'),
		gain: dacSetting(DAC_GAIN, 'gain')
	}
};
