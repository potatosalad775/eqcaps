// A virtual device for probe tests (PLAN Phase 5): a protocol's real codec in front of firmware
// that accepts what a "truth" profile allows. Every push goes through `encode` and `decode`, so
// values land on the wire grid exactly as on hardware; the firmware then stores, clamps, snaps,
// coerces or rejects them. Failure modes (whole-set rejection, NAKs, silent resets, disconnects)
// are switches, so each of the engine's failure paths can be exercised without hardware.

import {
	domainBounds,
	near,
	project,
	resolveSlot,
	usesGain,
	type Domain,
	type Filter,
	type Profile
} from '@potatosalad775/eqcaps-core';
import {
	BridgeError,
	HANDLERS,
	transportsOf,
	type AnyHandler,
	type DeviceCapabilities,
	type PullRequest,
	type PullResult,
	type PushRequest,
	type PushResult,
	type Protocol,
	type Transport
} from '@potatosalad775/eqcaps-device-bridge';
import type { ProbeIO } from './types.ts';

export interface FakeDeviceOptions {
	protocol: Protocol;
	/** What the firmware accepts. Its `bandCount` is the device's. */
	truth: Profile;
	/** What the device holds at the start; flat peaking bands by default. */
	initial?: (Filter | null)[];
	initialPreamp?: number;
	/** A value outside its range is clamped onto it (default), or the band is rejected. */
	outOfRange?: 'clamp' | 'reject';
	/** A type the slot doesn't take rejects the band (default), or becomes the slot's first type. */
	wrongType?: 'reject' | 'coerce';
	/** One rejected band rejects the whole write. */
	wholeSet?: boolean;
	/** A rejected write answers with an error (`rejected`) instead of silently. */
	nak?: boolean;
	/** A rejected write resets every band to its defaults instead. */
	resetOnInvalid?: boolean;
	/** The device disconnects at this write (1-based): it and everything after it fails. */
	disconnectAtWrite?: number;
	/** Bands are stored sorted by frequency. */
	reorders?: boolean;
	/** Bands past the device's count that a band-by-band read still answers (as unset). */
	phantomBands?: number;
	/** Capability overrides (for example `disconnectOnSave`). */
	capabilities?: Partial<DeviceCapabilities>;
}

function transportFor(kind: Transport['kind']): Transport {
	if (kind !== 'hid') {
		return { kind, write: async () => {}, read: async () => null, close: async () => {} };
	}
	return {
		kind,
		vendorId: 0,
		productId: 0,
		productName: '',
		collections: [],
		sendReport: async () => {},
		sendFeatureReport: async () => {},
		receiveFeatureReport: async () => new Uint8Array(64),
		onInputReport: () => () => {},
		close: async () => {}
	};
}

const FLAT: Filter = { type: 'PK', freq: 1000, q: 1, gain: 0 };

export class FakeDevice implements ProbeIO {
	readonly capabilities: DeviceCapabilities;
	/** What the device holds, one entry per band. */
	stored: (Filter | null)[];
	preamp: number | undefined;
	/** Pushes received, including failed ones. */
	writes = 0;
	readonly pushes: PushRequest[] = [];
	disconnected = false;
	private readonly o: FakeDeviceOptions;
	private readonly handler: AnyHandler;

	constructor(options: FakeDeviceOptions) {
		this.o = options;
		this.handler = HANDLERS[options.protocol.handler];
		const handlerOptions = options.protocol.options ?? {};
		const transport = transportFor(transportsOf(this.handler)[0] as Transport['kind']);
		this.capabilities = {
			...this.handler.capabilities(transport, handlerOptions),
			types: this.handler.codec.types,
			wire: this.handler.codec.wire(handlerOptions),
			slots: options.protocol.slots ?? [],
			disconnectOnSave: false,
			experimental: false,
			...options.capabilities
		};
		const count = this.bandCount;
		this.stored = Array.from({ length: count }, (_, i) =>
			options.initial ? (options.initial[i] ?? null) : this.defaultBand(i)
		);
		this.preamp = options.initialPreamp ?? (options.truth.preamp.mode === 'manual' ? 0 : undefined);
	}

	get bandCount(): number {
		return this.o.truth.bandCount ?? 10;
	}

	/** A band's factory default: flat, inside its slot. */
	private defaultBand(i: number): Filter {
		const slot = resolveSlot(this.o.truth, i);
		const type = slot.types[0] ?? 'PK';
		const freq = project(FLAT.freq, slot.freq, 'freq');
		return { type, freq, q: project(FLAT.q, slot.q, 'q'), gain: 0 };
	}

	private check() {
		if (this.disconnected) throw new BridgeError('transport', 'the device is gone');
	}

	/** One field through the firmware: its stored value, or null if the band is rejected. */
	private field(value: number, domain: Domain, name: 'freq' | 'q' | 'gain'): number | null {
		const { min, max } = domainBounds(domain);
		const inside = (value >= min || near(value, min)) && (value <= max || near(value, max));
		if (!inside && this.o.outOfRange === 'reject') return null;
		return project(value, domain, name);
	}

	/** What the firmware stores for band `i`, or null when it rejects it. */
	private firmware(f: Filter, i: number): Filter | null {
		const slot = resolveSlot(this.o.truth, i);
		let type = f.type;
		if (!slot.types.includes(type)) {
			if (this.o.wrongType !== 'coerce') return null;
			type = slot.types[0]!;
		}
		const effective = resolveSlot(this.o.truth, i, { ...f, type });
		const freq = this.field(f.freq, effective.freq, 'freq');
		const q = this.field(f.q, effective.q, 'q');
		const gain = usesGain(type) ? this.field(f.gain, effective.gain, 'gain') : 0;
		if (freq === null || q === null || gain === null) return null;
		return { type, freq, q, gain };
	}

	private ascendingViolated(bands: (Filter | null)[]): boolean {
		const rule = this.o.truth.rules?.find((r) => r.type === 'ascendingFrequency');
		if (!rule) return false;
		const strict = rule.strict !== false;
		for (let i = 1; i < bands.length; i++) {
			const a = bands[i - 1]?.freq;
			const b = bands[i]?.freq;
			if (a === undefined || b === undefined) continue;
			if (strict ? b < a || near(a, b) : b < a && !near(a, b)) return true;
		}
		return false;
	}

	async push(request: PushRequest): Promise<PushResult> {
		this.writes++;
		this.pushes.push(request);
		if (this.o.disconnectAtWrite !== undefined && this.writes >= this.o.disconnectAtWrite) {
			this.disconnected = true;
		}
		this.check();
		if (!this.capabilities.canWrite) throw new BridgeError('unsupported', 'write-only');
		const handlerOptions = this.o.protocol.options ?? {};
		// Exactly what the wire carries: refused values throw here, as on hardware.
		const frames = this.handler.codec.encode(request, handlerOptions);
		const wire = this.handler.codec.decode(frames, handlerOptions);

		const next = [...this.stored];
		let rejected = false;
		wire.filters.forEach((f, i) => {
			if (i >= this.bandCount || !f) return;
			const stored = this.firmware(f, i);
			if (stored) next[i] = stored;
			else rejected = true;
		});
		let preamp = this.preamp;
		if (wire.preamp !== undefined && this.o.truth.preamp.mode === 'manual') {
			const p = this.field(wire.preamp, this.o.truth.preamp.gain, 'gain');
			if (p === null) rejected = true;
			else preamp = p;
		}
		if (this.ascendingViolated(next)) {
			if (this.o.reorders) {
				const active = next.filter((x): x is Filter => x !== null);
				active.sort((a, b) => a.freq - b.freq);
				next.splice(0, active.length, ...active);
			} else {
				this.reject(true);
				return { reconnect: false };
			}
		}
		if (rejected && this.o.resetOnInvalid) {
			this.stored = this.stored.map((_, i) => this.defaultBand(i));
			return { reconnect: false };
		}
		if (rejected && this.o.wholeSet) {
			this.reject(true);
			return { reconnect: false };
		}
		this.stored = next;
		this.preamp = preamp;
		if (rejected) this.reject(false);
		return { reconnect: false };
	}

	/** A rejection: nothing changes (`whole`) or only the valid bands did; NAKs when set to. */
	private reject(whole: boolean) {
		if (this.o.nak && whole) throw new BridgeError('rejected', 'the device refused the write');
	}

	async pull(request: PullRequest = {}): Promise<PullResult> {
		this.check();
		if (!this.capabilities.canRead) throw new BridgeError('unsupported', 'write-only');
		let filters: (Filter | null)[];
		if (this.capabilities.needsBandCount) {
			const asked = request.bands ?? this.bandCount;
			const readable = this.bandCount + (this.o.phantomBands ?? 0);
			if (asked > readable) throw new BridgeError('timeout', `band ${readable} didn't answer`);
			filters = Array.from({ length: asked }, (_, i) => this.stored[i] ?? null);
		} else {
			filters = [...this.stored];
		}
		return {
			filters: filters.map((f) => (f ? { ...f } : null)),
			...(this.capabilities.readsPreamp && this.preamp !== undefined ? { preamp: this.preamp } : {})
		};
	}
}
