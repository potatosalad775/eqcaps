import {
	controlPresent,
	controlTakes,
	near,
	type Control,
	type ControlValues,
	type FilterType
} from '@potatosalad775/eqcaps-core';
import { BridgeError, isBridgeError } from './errors.ts';
import type {
	AnyHandler,
	EqInfo,
	HandlerCapabilities,
	HandlerContext,
	PullRequest,
	PullResult,
	PushRequest,
	PushResult,
	Slot,
	WireGrid
} from './handler.ts';
import { HANDLERS } from './handlers/index.ts';
import { identityOf, type DeviceIdentity } from './identity.ts';
import { realSleep } from './platform.ts';
import type { Protocol } from './protocols.ts';
import type { Transport } from './transport.ts';

export interface OpenOptions {
	/**
	 * The device's eqcaps profile, or just its `bandCount`. It supplies the band count a pull needs
	 * when the protocol can't tell. Nothing else in it is used: the bridge never fits or clamps.
	 */
	profile?: { bandCount?: number | null };
	/** Replaces the waits between writes (tests pass one that returns at once). */
	sleep?: (ms: number) => Promise<void>;
	/** Receives diagnostic messages. */
	log?: (message: string) => void;
}

export interface DeviceCapabilities extends HandlerCapabilities {
	/** Filter types the protocol has wire codes for. */
	types: readonly FilterType[];
	/** What the write frames can carry. A profile domain outside it can't be written. */
	wire: WireGrid;
	/** Push writes `preamp` when given: the wire carries one (`wire.preamp`). */
	writesPreamp: boolean;
	/** `currentSlot()` asks the device rather than answering null. */
	readsCurrentSlot: boolean;
	/** `setEnabled()` sends a command. */
	canEnable: boolean;
	/**
	 * The preset slots of the EQ this device is viewed as (`eq()`). Where the device keeps a list of
	 * presets (`listsSlots`), these are the ones it has room for, under the data's names: `slots()`
	 * says which exist now.
	 */
	slots: readonly Slot[];
	/** `slots()` asks the device, which keeps a list of presets with names of its own. */
	listsSlots: boolean;
	/** `createSlot()`, `renameSlot()` and `deleteSlot()` send commands. */
	editsSlots: boolean;
	/**
	 * `push` takes the right channel as `right`, and `pull` returns it (SPEC §9), on the EQ this
	 * device is viewed as.
	 */
	perChannel: boolean;
	/**
	 * The device's other EQs (SPEC §9.2), each with its own slots: `eq(id)` gives the device viewed
	 * as one. Empty for a device with one EQ, and the same list on every view.
	 */
	eqs: readonly EqInfo[];
	/** The device drops the connection after a push that saves; reconnect afterwards. */
	disconnectOnSave: boolean;
	/** The protocol for this device is unconfirmed. */
	experimental: boolean;
	/** `firmware()` asks the device. */
	readsFirmware: boolean;
	/** `eqEnabled()` asks the device: its EQ switch is separate from the preset it plays. */
	readsEnabled: boolean;
	/** `bandCount()` asks the device. */
	readsBandCount: boolean;
	/** The profile's device controls that this bridge drives (SPEC §9.1). */
	controls: readonly Control[];
}

export interface ControlWriteResult {
	/** The control is marked `reconnect`: the device may drop the connection, so reconnect. */
	reconnect: boolean;
}

/**
 * A connected device, viewed as one of its EQs: a transport driven by a protocol. `openDevice`
 * gives it viewed as the EQ its profile describes; `eq(id)` gives it viewed as another (SPEC
 * §9.2). `pull`, `push`, the EQ's switch, its presets and its band count are that EQ's, and so
 * are `capabilities.slots` and `capabilities.perChannel`. The firmware, the controls and closing
 * are the device's, the same from every view.
 */
export interface BridgeDevice {
	readonly transport: Transport;
	readonly protocol: Protocol;
	readonly identity: DeviceIdentity;
	readonly capabilities: DeviceCapabilities;
	pull(request?: PullRequest): Promise<PullResult>;
	push(request: PushRequest): Promise<PushResult>;
	/**
	 * The active preset slot; null when the protocol can't say, or (on some bypass-preset
	 * protocols) when the EQ is off. Where the EQ switch is separate state (`readsEnabled`), this is
	 * the preset the device plays when its EQ is on, whether it is on or not.
	 */
	currentSlot(): Promise<number | null>;
	/** Whether the EQ is on (`readsEnabled`); null when the protocol or device doesn't say. */
	eqEnabled(): Promise<boolean | null>;
	setEnabled(enabled: boolean, slot?: number): Promise<void>;
	/**
	 * The preset slots as they are now. Where the device keeps a list (`listsSlots`) it is asked:
	 * the presets it holds, under the names it stores, ids counting from 0, followed by the data's
	 * `bypass` preset if there is one. Elsewhere this is `capabilities.slots`.
	 */
	slots(): Promise<readonly Slot[]>;
	/**
	 * The next three need `editsSlots`. This one adds an empty preset after the last and returns
	 * it; without a `name` the device or handler picks one. Refused when the device is full. The
	 * device may start playing the new preset: ask `currentSlot()` afterwards.
	 */
	createSlot(request?: { name?: string }): Promise<Slot>;
	/** Renames a preset. A name the device can't store is refused, never shortened. */
	renameSlot(slot: number, name: string): Promise<void>;
	/**
	 * Deletes a preset. The ones after it move down by one and the device may switch to another:
	 * ask `slots()` and `currentSlot()` afterwards.
	 */
	deleteSlot(slot: number): Promise<void>;
	/** The device's firmware version, read once; null when the protocol or device doesn't say. */
	firmware(): Promise<string | null>;
	/**
	 * The band count the device reports, asked each time; null when the protocol or device doesn't
	 * say. It can differ from the profile's `bandCount`: the bridge doesn't reconcile them.
	 */
	bandCount(): Promise<number | null>;
	/**
	 * The current value of every control in `capabilities.controls`; null for one the device
	 * doesn't have now (SPEC §9.1: its firmware range or `when` doesn't hold). Opt-in: pull and
	 * push never touch controls.
	 */
	readControls(): Promise<Record<string, number | null>>;
	/**
	 * Writes one control, then reads it back unless it is marked `reconnect`. Refuses a value the
	 * profile doesn't list and a control the device doesn't have now; never clamps. Call it only
	 * when the user changed the control (SPEC §9.1).
	 */
	writeControl(id: string, value: number): Promise<ControlWriteResult>;
	/**
	 * This device viewed as another of its EQs: an id of `capabilities.eqs`, or none for the EQ the
	 * profile describes. The same connection, one operation at a time across every view, and the
	 * same view each time it is asked for. An EQ the profile doesn't list is refused here
	 * (`invalid-request`); one the device's current mode lacks answers each operation `unsupported`.
	 */
	eq(id?: string): BridgeDevice;
	close(): Promise<void>;
}

/** The transport kinds a handler runs over. */
export const transportsOf = (h: AnyHandler): readonly Transport['kind'][] =>
	typeof h.transport === 'string'
		? [h.transport as Transport['kind']]
		: (h.transport as readonly Transport['kind'][]);

/** The transport kinds a handler runs over, by its id; empty for a handler this bridge lacks. */
export const handlerTransports = (id: string): readonly Transport['kind'][] =>
	Object.hasOwn(HANDLERS, id) ? transportsOf(HANDLERS[id as keyof typeof HANDLERS]) : [];

/**
 * Drives `transport` with `protocol`: `protocolOf(profile)` (or `protocolForMatches`) for a device
 * the database knows, `guessProtocol(vendorId)` otherwise. Operations run one at a time.
 */
export function openDevice(
	transport: Transport,
	protocol: Protocol,
	options: OpenOptions = {}
): BridgeDevice {
	const handler: AnyHandler = HANDLERS[protocol.handler];
	if (!transportsOf(handler).includes(transport.kind)) {
		throw new BridgeError(
			'invalid-request',
			`${handler.id} doesn't run over a ${transport.kind} transport`
		);
	}
	const handlerOptions = protocol.options ?? {};
	const context = (
		presets: readonly Slot[] | undefined,
		eq?: string
	): HandlerContext<Transport, object> => {
		const bypass = presets?.find((p) => p.bypass)?.id;
		return {
			transport,
			options: handlerOptions,
			...(eq !== undefined ? { eq } : {}),
			...(bypass !== undefined ? { bypass } : {}),
			sleep: options.sleep ?? realSleep,
			log: options.log ?? (() => {})
		};
	};
	/** The profile's own EQ, and everything that isn't about one EQ. */
	const ctx = context(protocol.presets);
	// The data's other EQs that this handler drives: one it doesn't know is left out (SPEC §9.2).
	const listed = (protocol.eqs ?? []).filter((e) => (handler.eqs ?? []).includes(e.id));
	const capabilitiesOf = (eq?: string): HandlerCapabilities =>
		handler.capabilities(transport, handlerOptions, eq);
	const eqs: readonly EqInfo[] = listed.map(({ presets, ...e }) => ({
		...e,
		slots: presets ?? [],
		perChannel: capabilitiesOf(e.id).perChannel === true
	}));
	const controls = (protocol.controls ?? []).filter((c) => handler.controls?.[c.id]);

	// One operation at a time, across every view: two pulls interleaving on one input stream
	// corrupt each other.
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(op: () => Promise<T>): Promise<T> => {
		const run = queue.then(op, op);
		queue = run.catch(() => {});
		return run;
	};

	const noEditing = () =>
		new BridgeError('unsupported', `${handler.id} can't create, rename or delete presets here`);

	let firmware: Promise<string | null> | undefined;
	/** Read once. A failed read counts as unknown firmware, which leaves out controls that need one. */
	const readFirmware = () =>
		(firmware ??= handler.firmware
			? handler.firmware(ctx).catch((e: unknown) => {
					ctx.log(`${handler.id}: no firmware version (${(e as Error).message})`);
					return null;
				})
			: Promise.resolve(null));
	const driver = (c: Control) => handler.controls![c.id]!;
	/** Whether `c` exists now, reading the control its `when` names when it has one. */
	const present = async (c: Control, values: ControlValues = {}) => {
		const target = c.when && controls.find((t) => t.id === c.when!.control);
		const known =
			c.when && !(c.when.control in values) && target
				? {
						...values,
						[target.id]: controlPresent(target, { firmware: await readFirmware(), values })
							? await driver(target).read(ctx)
							: null
					}
				: values;
		return controlPresent(c, { firmware: await readFirmware(), values: known });
	};

	const views = new Map<string | undefined, BridgeDevice>();
	/** The device viewed as one EQ: the profile's own for no id, else one of `listed`. */
	const view = (id: string | undefined): BridgeDevice => {
		const known = views.get(id);
		if (known) return known;
		const info = listed.find((e) => e.id === id);
		if (id !== undefined && !info) {
			throw new BridgeError('invalid-request', `${handler.id}: no EQ "${id}" here`);
		}
		/** The context of this EQ's operations. */
		const target = info ? context(info.presets, info.id) : ctx;
		const own = capabilitiesOf(id);
		const wire = handler.codec.wire(handlerOptions);
		const capabilities: DeviceCapabilities = {
			...own,
			types: handler.codec.types,
			wire,
			writesPreamp: wire.preamp !== undefined,
			// Each of these is the handler having the method, unless it says otherwise.
			readsCurrentSlot: handler.currentSlot !== undefined && own.readsCurrentSlot !== false,
			canEnable: handler.setEnabled !== undefined && own.canEnable !== false,
			slots: (info ? info.presets : protocol.presets) ?? [],
			listsSlots: handler.slots !== undefined,
			editsSlots:
				handler.createSlot !== undefined &&
				handler.renameSlot !== undefined &&
				handler.deleteSlot !== undefined &&
				own.editsSlots !== false,
			perChannel: own.perChannel === true,
			eqs,
			disconnectOnSave: protocol.disconnectOnSave ?? false,
			experimental: protocol.experimental ?? false,
			readsFirmware: handler.firmware !== undefined,
			readsEnabled: handler.eqEnabled !== undefined && own.readsEnabled !== false,
			readsBandCount: handler.bandCount !== undefined,
			controls
		};

		const device: BridgeDevice = {
			transport,
			protocol,
			identity: identityOf(transport),
			capabilities,

			pull(request = {}) {
				return serial(async () => {
					if (!capabilities.canRead) {
						throw new BridgeError('unsupported', `${handler.id} can't read from this device`);
					}
					const r: { slot?: number; bands?: number } = {};
					if (request.slot !== undefined) {
						if (!capabilities.readsSlot) {
							throw new BridgeError(
								'invalid-request',
								`${handler.id} reads only the current preset, not a chosen slot`
							);
						}
						r.slot = request.slot;
					}
					if (capabilities.needsBandCount) {
						const bands =
							request.bands ?? info?.bandCount ?? options.profile?.bandCount ?? undefined;
						if (typeof bands !== 'number' || !Number.isInteger(bands) || bands < 0) {
							throw new BridgeError(
								'invalid-request',
								`${handler.id} needs a band count: pass \`bands\`, or open the device with its profile`
							);
						}
						r.bands = bands;
					}
					return handler.pull(target, r);
				});
			},

			push(request) {
				return serial(async () => {
					if (!capabilities.canWrite) {
						throw new BridgeError('unsupported', `${handler.id} can't write to this device`);
					}
					// Sent without it, the right channel would look written (D33).
					if (request.right !== undefined && !capabilities.perChannel) {
						throw new BridgeError(
							'invalid-request',
							`${handler.id}: the write drives both channels alike; it carries no right channel`
						);
					}
					const result = await handler.push(target, request);
					return { reconnect: result.reconnect || capabilities.disconnectOnSave };
				});
			},

			currentSlot() {
				return serial(async () =>
					capabilities.readsCurrentSlot ? handler.currentSlot!(target) : null
				);
			},

			eqEnabled() {
				return serial(async () => (capabilities.readsEnabled ? handler.eqEnabled!(target) : null));
			},

			setEnabled(enabled, slot) {
				return serial(async () => {
					if (!capabilities.canEnable) {
						throw new BridgeError('unsupported', `${handler.id} has no EQ switch here`);
					}
					await handler.setEnabled!(target, enabled, slot);
				});
			},

			slots() {
				return serial(async () => {
					if (!handler.slots) return capabilities.slots;
					return [...(await handler.slots(target)), ...capabilities.slots.filter((s) => s.bypass)];
				});
			},

			createSlot({ name } = {}) {
				return serial(async () => {
					if (!capabilities.editsSlots) throw noEditing();
					return handler.createSlot!(target, name === undefined ? {} : { name });
				});
			},

			renameSlot(slot, name) {
				return serial(async () => {
					if (!capabilities.editsSlots) throw noEditing();
					await handler.renameSlot!(target, slot, name);
				});
			},

			deleteSlot(slot) {
				return serial(async () => {
					if (!capabilities.editsSlots) throw noEditing();
					await handler.deleteSlot!(target, slot);
				});
			},

			firmware() {
				return serial(readFirmware);
			},

			bandCount() {
				return serial(async () => {
					try {
						return (await handler.bandCount?.(target)) ?? null;
					} catch (e) {
						ctx.log(`${handler.id}: no band count (${(e as Error).message})`);
						return null;
					}
				});
			},

			readControls() {
				return serial(async () => {
					const values: Record<string, number | null> = {};
					// Controls without `when` first: a `when` names one of them (SPEC §9.1).
					const order = [...controls.filter((c) => !c.when), ...controls.filter((c) => c.when)];
					for (const c of order) {
						values[c.id] = (await present(c, values)) ? await driver(c).read(ctx) : null;
					}
					return values;
				});
			},

			writeControl(controlId, value) {
				return serial(async () => {
					const c = controls.find((x) => x.id === controlId);
					if (!c) {
						throw new BridgeError(
							'invalid-request',
							`${handler.id}: no control "${controlId}" here`
						);
					}
					if (!controlTakes(c, value)) {
						throw new BridgeError(
							'invalid-request',
							`${handler.id}: "${controlId}" doesn't take ${value}`
						);
					}
					if (!(await present(c))) {
						throw new BridgeError(
							'unsupported',
							`${handler.id}: the device has no "${controlId}" now`
						);
					}
					try {
						await driver(c).write(ctx, value);
					} catch (e) {
						// A device that restarts for this control can drop off the bus before the write
						// returns (the DS3 on a USB mode switch): the transport failing is it restarting.
						if (!c.reconnect || !isBridgeError(e, 'transport')) throw e;
						ctx.log(`${handler.id}: "${controlId}" lost the device as it restarted (${e.message})`);
					}
					if (c.reconnect) return { reconnect: true };
					let back = await driver(c).read(ctx);
					// Once more before calling it rejected: a device may apply a value a moment late,
					// or a late answer to an earlier read may have come first.
					if (!near(back, value)) {
						await ctx.sleep(100);
						back = await driver(c).read(ctx);
					}
					if (!near(back, value)) {
						throw new BridgeError(
							'rejected',
							`${handler.id}: "${controlId}" reads back ${back}, not ${value}`
						);
					}
					return { reconnect: false };
				});
			},

			eq: view,

			close() {
				return serial(() => transport.close());
			}
		};
		views.set(id, device);
		return device;
	};

	return view(undefined);
}

/**
 * The reading side of a connected device (D40): what `BridgeDevice` has that sends no write.
 * `pull` and the other reads do send their requests; nothing here changes what the device holds.
 */
export type DeviceReader = Pick<
	BridgeDevice,
	| 'transport'
	| 'protocol'
	| 'identity'
	| 'capabilities'
	| 'pull'
	| 'currentSlot'
	| 'eqEnabled'
	| 'slots'
	| 'bandCount'
	| 'firmware'
	| 'readControls'
	| 'close'
> & {
	/** This device viewed as another of its EQs (SPEC §9.2), for reading too. */
	eq(id?: string): DeviceReader;
};

/**
 * `openDevice` for a program that must never write (the inspector, D40): the object it gives has
 * no `push`, `setEnabled`, `writeControl` or preset editing, on any view.
 */
export function openReader(
	transport: Transport,
	protocol: Protocol,
	options: OpenOptions = {}
): DeviceReader {
	const readers = new Map<BridgeDevice, DeviceReader>();
	const reader = (d: BridgeDevice): DeviceReader => {
		const known = readers.get(d);
		if (known) return known;
		const r: DeviceReader = {
			transport: d.transport,
			protocol: d.protocol,
			identity: d.identity,
			capabilities: d.capabilities,
			pull: (request) => d.pull(request),
			currentSlot: () => d.currentSlot(),
			eqEnabled: () => d.eqEnabled(),
			slots: () => d.slots(),
			bandCount: () => d.bandCount(),
			firmware: () => d.firmware(),
			readControls: () => d.readControls(),
			eq: (id) => reader(d.eq(id)),
			close: () => d.close()
		};
		readers.set(d, r);
		return r;
	};
	return reader(openDevice(transport, protocol, options));
}
