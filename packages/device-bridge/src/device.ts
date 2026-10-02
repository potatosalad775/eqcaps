import type { FilterType } from '@potatosalad775/eqcaps-core';
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
	slots: readonly Slot[];
	/** The device drops the connection after a push that saves; reconnect afterwards. */
	disconnectOnSave: boolean;
	/** The protocol for this device is unconfirmed. */
	experimental: boolean;
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
	close(): Promise<void>;
}

/** The transport kinds a handler runs over. */
export const transportsOf = (h: AnyHandler): readonly Transport['kind'][] =>
	typeof h.transport === 'string'
		? [h.transport as Transport['kind']]
		: (h.transport as readonly Transport['kind'][]);

/**
 * Drives `transport` with `protocol`: `protocolFor(profileId)` for a device the database knows,
 * `guessProtocol(vendorId)` otherwise. Operations run one at a time.
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
	const ctx: HandlerContext<Transport, object> = {
		transport,
		options: handlerOptions,
		sleep: options.sleep ?? realSleep,
		log: options.log ?? (() => {})
	};
	const capabilities: DeviceCapabilities = {
		...handler.capabilities(transport, handlerOptions),
		types: handler.codec.types,
		wire: handler.codec.wire(handlerOptions),
		slots: protocol.slots ?? [],
		disconnectOnSave: protocol.disconnectOnSave ?? false,
		experimental: protocol.experimental ?? false
	};

	// One operation at a time: two pulls interleaving on one input stream corrupt each other.
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(op: () => Promise<T>): Promise<T> => {
		const run = queue.then(op, op);
		queue = run.catch(() => {});
		return run;
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

		close() {
			return serial(() => transport.close());
		}
	};
}
