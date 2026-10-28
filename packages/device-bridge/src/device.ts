import {
	controlPresent,
	controlTakes,
	near,
	type Control,
	type ControlValues,
	type FilterType
} from '@potatosalad775/eqcaps-core';
import { BridgeError } from './errors.ts';
import type {
	AnyHandler,
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
	/** The protocol's preset slots. */
	slots: readonly Slot[];
	/** The device drops the connection after a push that saves; reconnect afterwards. */
	disconnectOnSave: boolean;
	/** The protocol for this device is unconfirmed. */
	experimental: boolean;
	/** `firmware()` asks the device. */
	readsFirmware: boolean;
	/** The profile's device controls that this bridge drives (SPEC §9.1). */
	controls: readonly Control[];
}

export interface ControlWriteResult {
	/** The control is marked `reconnect`: the device may drop the connection, so reconnect. */
	reconnect: boolean;
}

/** A connected device: a transport driven by a protocol. */
export interface BridgeDevice {
	readonly transport: Transport;
	readonly protocol: Protocol;
	readonly identity: DeviceIdentity;
	readonly capabilities: DeviceCapabilities;
	pull(request?: PullRequest): Promise<PullResult>;
	push(request: PushRequest): Promise<PushResult>;
	/** The active preset slot; null when EQ is off or the protocol can't say. */
	currentSlot(): Promise<number | null>;
	setEnabled(enabled: boolean, slot?: number): Promise<void>;
	/** The device's firmware version, read once; null when the protocol or device doesn't say. */
	firmware(): Promise<string | null>;
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
	const bypass = protocol.presets?.find((p) => p.bypass)?.id;
	const ctx: HandlerContext<Transport, object> = {
		transport,
		options: handlerOptions,
		...(bypass !== undefined ? { bypass } : {}),
		sleep: options.sleep ?? realSleep,
		log: options.log ?? (() => {})
	};
	const capabilities: DeviceCapabilities = {
		...handler.capabilities(transport, handlerOptions),
		types: handler.codec.types,
		wire: handler.codec.wire(handlerOptions),
		slots: protocol.presets ?? [],
		disconnectOnSave: protocol.disconnectOnSave ?? false,
		experimental: protocol.experimental ?? false,
		readsFirmware: handler.firmware !== undefined,
		controls: (protocol.controls ?? []).filter((c) => handler.controls?.[c.id])
	};

	// One operation at a time: two pulls interleaving on one input stream corrupt each other.
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(op: () => Promise<T>): Promise<T> => {
		const run = queue.then(op, op);
		queue = run.catch(() => {});
		return run;
	};

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
		const target = c.when && capabilities.controls.find((t) => t.id === c.when!.control);
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

	return {
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
					const bands = request.bands ?? options.profile?.bandCount ?? undefined;
					if (typeof bands !== 'number' || !Number.isInteger(bands) || bands < 0) {
						throw new BridgeError(
							'invalid-request',
							`${handler.id} needs a band count: pass \`bands\`, or open the device with its profile`
						);
					}
					r.bands = bands;
				}
				return handler.pull(ctx, r);
			});
		},

		push(request) {
			return serial(async () => {
				if (!capabilities.canWrite) {
					throw new BridgeError('unsupported', `${handler.id} can't write to this device`);
				}
				const result = await handler.push(ctx, request);
				return { reconnect: result.reconnect || capabilities.disconnectOnSave };
			});
		},

		currentSlot() {
			return serial(async () => (handler.currentSlot ? handler.currentSlot(ctx) : null));
		},

		setEnabled(enabled, slot) {
			return serial(async () => {
				if (!handler.setEnabled) {
					throw new BridgeError('unsupported', `${handler.id} has no EQ switch`);
				}
				await handler.setEnabled(ctx, enabled, slot);
			});
		},

		firmware() {
			return serial(readFirmware);
		},

		readControls() {
			return serial(async () => {
				const values: Record<string, number | null> = {};
				// Controls without `when` first: a `when` names one of them (SPEC §9.1).
				const order = [
					...capabilities.controls.filter((c) => !c.when),
					...capabilities.controls.filter((c) => c.when)
				];
				for (const c of order) {
					values[c.id] = (await present(c, values)) ? await driver(c).read(ctx) : null;
				}
				return values;
			});
		},

		writeControl(id, value) {
			return serial(async () => {
				const c = capabilities.controls.find((x) => x.id === id);
				if (!c) throw new BridgeError('invalid-request', `${handler.id}: no control "${id}" here`);
				if (!controlTakes(c, value)) {
					throw new BridgeError('invalid-request', `${handler.id}: "${id}" doesn't take ${value}`);
				}
				if (!(await present(c))) {
					throw new BridgeError('unsupported', `${handler.id}: the device has no "${id}" now`);
				}
				await driver(c).write(ctx, value);
				if (c.reconnect) return { reconnect: true };
				const back = await driver(c).read(ctx);
				if (!near(back, value)) {
					throw new BridgeError(
						'rejected',
						`${handler.id}: "${id}" reads back ${back}, not ${value}`
					);
				}
				return { reconnect: false };
			});
		},

		close() {
			return serial(() => transport.close());
		}
	};
}
