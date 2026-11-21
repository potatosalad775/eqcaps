import type { Filter, FilterType } from '@potatosalad775/eqcaps-core';
import type { HidTransport, StreamTransport, Transport } from './transport.ts';

/** An EQ preset slot (memory) on the device. Unrelated to the profile's filter slots. */
export interface Slot {
	id: number;
	name: string;
	/** Selecting this slot turns the EQ off (`setEnabled(false)` selects it). */
	bypass?: boolean;
	/**
	 * The user may write filters here (a user memory). Once any slot of a device is marked, the
	 * unmarked ones are built-in curves; with none marked, the data doesn't say (SPEC §9).
	 */
	writable?: boolean;
}

export interface PullRequest {
	/**
	 * Preset slot to read. Default: the current one. Refused where the protocol can't read a
	 * chosen slot (`readsSlot`), rather than answered with the current one.
	 */
	slot?: number;
	/**
	 * Bands to read, where the protocol can't tell. Default: the band count of the EQ the device is
	 * viewed as, from its profile.
	 */
	bands?: number;
}

/** What the device holds, in canonical units: written values (D39). */
export interface PullResult {
	/**
	 * One entry per band in band order; null for a band the device reports as off or unset. The
	 * left channel's when `right` is given.
	 */
	filters: (Filter | null)[];
	/** The device's preamp in dB, when the protocol reads one. The left channel's when `right` is given. */
	preamp?: number;
	/**
	 * The right channel, on every pull of an EQ whose channels the handler drives apart
	 * (`perChannel`), equal to the left or not (SPEC §9, `channels: "independent"`).
	 */
	right?: { filters: (Filter | null)[]; preamp?: number };
	/** The slot that was read, when known. */
	slot?: number;
}

export interface PushRequest {
	/**
	 * Written values, one per band, in band order: normally the `write` of core's `plan`.
	 * The bridge sends them as given. It does no clamping, type conversion or padding of its own;
	 * a value the wire can't carry is a `BridgeError` (D33).
	 */
	filters: readonly Filter[];
	/**
	 * Preamp in dB. Left out, the preamp isn't written; where the protocol sends it with the bands
	 * (Nothing), 0 dB is sent. Given to a protocol that can't write it (`writesPreamp`), the push
	 * is refused rather than sent without it.
	 */
	preamp?: number;
	/**
	 * The right channel (SPEC §9, `channels: "independent"`). Given, `filters` and `preamp` are the
	 * left channel's, and `right.preamp` left out is `preamp`. Left out, `filters` and `preamp` go
	 * to both channels. Refused, like `preamp`, where the handler doesn't drive the channels of the
	 * EQ the device is viewed as apart (`perChannel`).
	 */
	right?: { filters: readonly Filter[]; preamp?: number };
	/** Preset slot to write to. Refused, like `preamp`, where the write names none (`writesSlot`). */
	slot?: number;
}

/** Another EQ of the device, as its profile lists it (SPEC §9.2). */
export interface EqInfo {
	/** The handler's id of the EQ: what `eq()` takes. */
	id: string;
	name: string;
	/** Its band count, where the profile gives one that differs from its own. */
	bandCount?: number;
	/** Its own preset slots. */
	slots: readonly Slot[];
	/**
	 * Push takes its right channel as `right`, and pull returns it (SPEC §9.2, its `channels`):
	 * the handler drives its channels apart (`HandlerCapabilities.perChannel`, asked for this EQ).
	 */
	perChannel: boolean;
}

export interface PushResult {
	/** The device drops the connection after saving; reconnect before the next operation. */
	reconnect: boolean;
}

/** The range and resolution a wire field can carry, in canonical units. */
export interface WireField {
	min: number;
	max: number;
	/** Wire resolution; missing for floating-point fields. */
	step?: number;
}

/**
 * What a protocol's write frames can carry. It bounds every profile of the devices the protocol
 * drives: a profile domain outside it is a value no write can send.
 */
export interface WireGrid {
	freq: WireField | { values: readonly number[] };
	/** Missing when the protocol has no Q field. */
	q?: WireField;
	gain: WireField;
	/** Missing when the write carries no preamp. */
	preamp?: WireField;
}

/** A HID report: output (or feature, if marked) report `reportId` carrying `data`. */
export interface HidFrame {
	reportId: number;
	feature?: true;
	data: Uint8Array;
}

/** What a set of write frames says. */
export interface WriteState {
	filters: (Filter | null)[];
	preamp?: number;
	/**
	 * The right channel, where the frames write it apart from the left; left out, `filters` and
	 * `preamp` are both channels'.
	 */
	right?: { filters: (Filter | null)[]; preamp?: number };
	slot?: number;
}

/**
 * The pure half of a protocol: write requests to frames and back, with no I/O. The inspector
 * analyses a codec offline (what does the wire round a value to, what does it refuse?), and tests
 * check `decode(encode(x))` against the wire grid.
 */
export interface Codec<O, F> {
	/** Filter types the protocol has wire codes for. */
	readonly types: readonly FilterType[];
	wire(options: O): WireGrid;
	/**
	 * The frames that write `request`, in order. Throws `BridgeError` for what the wire can't carry.
	 * A codec may ignore `right`: `openDevice` refuses it where the handler doesn't drive the EQ's
	 * channels apart, before any codec sees it.
	 */
	encode(request: PushRequest, options: O): F[];
	/** What frames from `encode` write. */
	decode(frames: readonly F[], options: O): WriteState;
}

/** What a handler can do with one of its EQs, given its options and transport. */
export interface HandlerCapabilities {
	canRead: boolean;
	canWrite: boolean;
	/** Pull returns the preamp. */
	readsPreamp: boolean;
	/** Pull reads the preset `slot` it is given. */
	readsSlot: boolean;
	/** Push writes `preamp` when given. */
	writesPreamp: boolean;
	/** Push writes to the preset `slot` when given. */
	writesSlot: boolean;
	/** The band count, when the protocol fixes it. */
	bands?: number;
	/**
	 * Pull needs to be told how many bands to read (`bands`, or the profile's `bandCount`): the
	 * protocol reads band by band and can't report its count.
	 */
	needsBandCount: boolean;
	/** `currentSlot()` asks the device rather than returning a constant. */
	readsCurrentSlot: boolean;
	/** `setEnabled()` sends a command. */
	canEnable: boolean;
	/** `eqEnabled()` asks the device, where that depends on the options. Default: it has the method. */
	readsEnabled?: boolean;
	/**
	 * Presets are created, renamed and deleted (`createSlot`, `renameSlot`, `deleteSlot`), where
	 * that depends on the options. Default: it has the three methods.
	 */
	editsSlots?: boolean;
	/**
	 * Push takes the right channel (`right`) and pull returns it (SPEC §9, `channels:
	 * "independent"`): the handler drives this EQ's channels apart. Default false: a push with
	 * `right` is refused, and a pull returns one channel.
	 */
	perChannel?: boolean;
}

export interface HandlerContext<T extends Transport, O> {
	transport: T;
	options: O;
	/**
	 * The EQ the operation is for (SPEC §9.2), one of the handler's `eqs`; undefined for the EQ the
	 * handler drives by default.
	 */
	eq?: string;
	/** The preset that EQ's list marks `bypass`: selecting it turns the EQ off (SPEC §9). */
	bypass?: number;
	/** Waits between writes. Tests replace it to run without real delays. */
	sleep(ms: number): Promise<void>;
	/** Diagnostic messages; silent unless the caller passes a logger. */
	log(message: string): void;
}

/**
 * One device control (SPEC §9.1), as the handler drives it: the value is the device's own number,
 * which the profile's control lists. The device session checks a write against the profile first.
 */
export interface HandlerControl<T extends Transport, O> {
	read(ctx: HandlerContext<T, O>): Promise<number>;
	write(ctx: HandlerContext<T, O>, value: number): Promise<void>;
}

/** The I/O half of a protocol: a session over a transport, built on its codec. */
export interface Handler<T extends Transport, O, F> {
	/** Stable id, used by the protocol table and in evidence reports (`fiio-usb-hid`). */
	readonly id: string;
	readonly transport: T['kind'] | readonly T['kind'][];
	readonly codec: Codec<O, F>;
	/** BLE handlers: the GATT service and characteristics the protocol uses. */
	readonly gatt?: { service: string; tx: string; rx: string };
	/** Handlers that run over Bluetooth SPP: the RFCOMM service class (Web Serial needs it). */
	readonly sppServiceClass?: string;
	/** The protocol turns the EQ off by selecting a preset, which the profile marks `bypass`. */
	readonly bypassPreset?: boolean;
	/**
	 * The device's other EQs this handler drives, by id: the vocabulary of a profile's
	 * `protocol.eqs` (SPEC §9.2). An operation names one in `ctx.eq`.
	 */
	readonly eqs?: readonly string[];
	/** For `eq`, one of `eqs`; for the EQ the handler drives by default without one. */
	capabilities(transport: T, options: O, eq?: string): HandlerCapabilities;
	/** `bands` is always set when `needsBandCount` is. */
	pull(ctx: HandlerContext<T, O>, request: { slot?: number; bands?: number }): Promise<PullResult>;
	push(ctx: HandlerContext<T, O>, request: PushRequest): Promise<PushResult>;
	currentSlot?(ctx: HandlerContext<T, O>): Promise<number | null>;
	/**
	 * Whether the EQ is on, for a protocol whose EQ switch is its own state rather than a bypass
	 * preset; null when the device doesn't say.
	 */
	eqEnabled?(ctx: HandlerContext<T, O>): Promise<boolean | null>;
	setEnabled?(ctx: HandlerContext<T, O>, enabled: boolean, slot?: number): Promise<void>;
	/**
	 * The presets the device holds now, with the names it stores, for a device whose presets are a
	 * list that grows and shrinks rather than fixed memories. Ids count from 0 in the device's
	 * order.
	 */
	slots?(ctx: HandlerContext<T, O>): Promise<Slot[]>;
	/** Adds an empty preset after the last one; without a `name` the handler picks one. */
	createSlot?(ctx: HandlerContext<T, O>, request: { name?: string }): Promise<Slot>;
	renameSlot?(ctx: HandlerContext<T, O>, slot: number, name: string): Promise<void>;
	/** Deletes a preset; the ones after it move down by one. */
	deleteSlot?(ctx: HandlerContext<T, O>, slot: number): Promise<void>;
	/** The device's firmware version, dotted ("1.5.8"); null when the device doesn't say. */
	firmware?(ctx: HandlerContext<T, O>): Promise<string | null>;
	/** The band count the device itself reports; null when it reports none. */
	bandCount?(ctx: HandlerContext<T, O>): Promise<number | null>;
	/**
	 * The device controls this handler drives, by id: the vocabulary of a profile's
	 * `protocol.controls` (SPEC §9.1).
	 */
	readonly controls?: { readonly [id: string]: HandlerControl<T, O> };
}

export type HidHandler<O = object> = Handler<HidTransport, O, HidFrame>;
export type StreamHandler<O = object> = Handler<StreamTransport, O, Uint8Array>;

/** A handler of any transport and options, as the protocol table stores it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHandler = Handler<any, any, any>;

/** The standard Bluetooth Serial Port Profile service class. */
export const SPP = '00001101-0000-1000-8000-00805f9b34fb';
