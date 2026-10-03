import type { Filter, FilterType } from '@potatosalad775/eqcaps-core';
import type { HidTransport, StreamTransport, Transport } from './transport.ts';

/** An EQ preset slot (memory) on the device. Unrelated to the profile's filter slots. */
export interface Slot {
	id: number;
	name: string;
}

export interface PullRequest {
	/**
	 * Preset slot to read. Default: the current one. Refused where the protocol can't read a
	 * chosen slot (`readsSlot`), rather than answered with the current one.
	 */
	slot?: number;
	/** Bands to read, where the protocol can't tell. Default: the profile's `bandCount`. */
	bands?: number;
}

/** What the device holds, in canonical units: written values (D29, D39). */
export interface PullResult {
	/** One entry per band in band order; null for a band the device reports as off or unset. */
	filters: (Filter | null)[];
	/** The device's preamp in dB, when the protocol reads one. */
	preamp?: number;
	/** The slot that was read, when known. */
	slot?: number;
}

export interface PushRequest {
	/**
	 * Written values, one per band, in band order: normally core's `fit` followed by `complete`.
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
	/** Preset slot to write to. Refused, like `preamp`, where the write names none (`writesSlot`). */
	slot?: number;
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
	/** The frames that write `request`, in order. Throws `BridgeError` for what the wire can't carry. */
	encode(request: PushRequest, options: O): F[];
	/** What frames from `encode` write. */
	decode(frames: readonly F[], options: O): WriteState;
}

/** What a handler can do, given its options and transport. */
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
}

export interface HandlerContext<T extends Transport, O> {
	transport: T;
	options: O;
	/** Waits between writes. Tests replace it to run without real delays. */
	sleep(ms: number): Promise<void>;
	/** Diagnostic messages; silent unless the caller passes a logger. */
	log(message: string): void;
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
	capabilities(transport: T, options: O): HandlerCapabilities;
	/** `bands` is always set when `needsBandCount` is. */
	pull(ctx: HandlerContext<T, O>, request: { slot?: number; bands?: number }): Promise<PullResult>;
	push(ctx: HandlerContext<T, O>, request: PushRequest): Promise<PushResult>;
	currentSlot?(ctx: HandlerContext<T, O>): Promise<number | null>;
	setEnabled?(ctx: HandlerContext<T, O>, enabled: boolean, slot?: number): Promise<void>;
}

export type HidHandler<O = object> = Handler<HidTransport, O, HidFrame>;
export type StreamHandler<O = object> = Handler<StreamTransport, O, Uint8Array>;

/** A handler of any transport and options, as the protocol table stores it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHandler = Handler<any, any, any>;

/** The standard Bluetooth Serial Port Profile service class. */
export const SPP = '00001101-0000-1000-8000-00805f9b34fb';
