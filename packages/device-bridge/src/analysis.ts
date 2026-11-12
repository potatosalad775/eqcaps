// Offline codec analysis (INSPECTOR §4): what a protocol's write frames can carry,
// learnt from its codec alone, with no device. It gives the band counts a write can hold, the
// filter types with wire codes, and each field's wire range and resolution as an eqcaps domain:
// the `handler-code` knowledge of a device (SPEC §10). Wire limits bound what a device can be
// sent; they say nothing about what its firmware accepts, which only the vendor shows.

import type { Domain, Filter, FilterType } from '@potatosalad775/eqcaps-core';
import { isBridgeError } from './errors.ts';
import type { WireField, WireGrid } from './handler.ts';
import { HANDLERS } from './handlers/index.ts';
import type { Protocol } from './protocols.ts';

/** The most bands the analysis tries to encode. */
export const MAX_ANALYSED_BANDS = 128;

export interface CodecAnalysis {
	handler: Protocol['handler'];
	/**
	 * Band counts one write can carry, every count from `min` to `max`. `max` is
	 * `MAX_ANALYSED_BANDS` when the codec takes more.
	 */
	bands: { min: number; max: number };
	/** Filter types with wire codes, in the codec's order. */
	types: readonly FilterType[];
	/**
	 * Each field as a domain over its wire grid, or null where the field is a float with no limit
	 * of its own (the wire says nothing). `q` is null too when the write carries no Q, and
	 * `preamp` when it carries no preamp.
	 */
	freq: Domain | null;
	q: Domain | null;
	gain: Domain | null;
	preamp: Domain | null;
	/** The raw grid, for display. */
	wire: WireGrid;
}

/** A flat band every codec can carry: its first type, at 1 kHz or its first listed frequency. */
function plainBand(protocol: Protocol): Filter {
	const codec = HANDLERS[protocol.handler].codec;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- options of this handler
	const wire = codec.wire((protocol.options ?? {}) as any);
	const freq = 'values' in wire.freq ? (wire.freq.values[0] as number) : 1000;
	return {
		type: codec.types.includes('PK') ? 'PK' : (codec.types[0] as FilterType),
		freq,
		q: 1,
		gain: 0
	};
}

/** Whether the codec encodes `count` bands; false when it refuses the count itself. */
function encodes(protocol: Protocol, count: number): boolean {
	const codec = HANDLERS[protocol.handler].codec;
	const band = plainBand(protocol);
	try {
		codec.encode(
			{ filters: Array.from({ length: count }, () => ({ ...band })) },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- options of this handler
			(protocol.options ?? {}) as any
		);
		return true;
	} catch (error) {
		if (isBridgeError(error)) return false;
		throw error;
	}
}

/** Band counts a write can carry: the codecs take one contiguous run of counts. */
function bandRange(protocol: Protocol): { min: number; max: number } {
	let min = 0;
	for (let n = 1; n <= MAX_ANALYSED_BANDS; n++) {
		if (encodes(protocol, n)) {
			min = n;
			break;
		}
	}
	if (min === 0) return { min: 0, max: 0 };
	let max = min;
	while (max < MAX_ANALYSED_BANDS && encodes(protocol, max + 1)) max++;
	return { min, max };
}

/** Wire values a decoder reads as "unset" are already left out of the grid (D33). */
function fieldDomain(
	w: WireField | { values: readonly number[] },
	positive: boolean
): Domain | null {
	if ('values' in w) return { values: [...w.values] };
	if (w.step === undefined) return null;
	const step = w.step;
	// Grids are anchored at 0 (SPEC §4); freq and q must stay above it.
	const tidy = (x: number) => Number((Math.round(x / step) * step).toPrecision(12));
	let min = tidy(w.min);
	const max = tidy(w.max);
	if (positive && min <= 0) min = tidy(step);
	if (min > max) return null;
	return { min, max, step };
}

/** What `protocol`'s codec can write, worked out offline. */
export function analyzeCodec(protocol: Protocol): CodecAnalysis {
	const handler = HANDLERS[protocol.handler];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- options of this handler
	const wire = handler.codec.wire((protocol.options ?? {}) as any);
	return {
		handler: protocol.handler,
		bands: bandRange(protocol),
		types: handler.codec.types,
		freq: fieldDomain(wire.freq, true),
		q: wire.q ? fieldDomain(wire.q, true) : null,
		gain: fieldDomain(wire.gain, false),
		preamp: wire.preamp ? fieldDomain(wire.preamp, false) : null,
		wire
	};
}

/** Where a handler's code lives in this repository, at `commit`. */
export function handlerCodeUrl(handler: Protocol['handler'], commit: string): string {
	return `https://github.com/potatosalad775/eqcaps/blob/${commit}/packages/device-bridge/src/handlers/${handler}.ts`;
}
