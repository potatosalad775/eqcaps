// Every codec, under every set of options the protocol table uses: what `encode` writes, `decode`
// reads back, for any request on the codec's own wire grid, its end points included; values
// outside the grid are refused, never clamped, and so are a preamp or slot the write doesn't
// carry (D33).

import { FILTER_TYPES, type Filter, type FilterType } from '@potatosalad775/eqcaps-core';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
	guessProtocol,
	HANDLERS,
	isBridgeError,
	KNOWN_HID_VENDORS,
	PROTOCOLS,
	transportsOf,
	type AnyHandler,
	type PushRequest,
	type Transport,
	type WireField,
	type WireGrid
} from '../src/index.ts';

/** Each distinct handler and options pair, from the table and the vendor guesses. */
const variants = new Map<string, { handler: string; options: object }>();
const add = (handler: string, options: object = {}) =>
	variants.set(`${handler} ${JSON.stringify(options)}`, { handler, options });
for (const p of Object.values(PROTOCOLS)) add(p.handler, p.options);
for (const v of KNOWN_HID_VENDORS) add(guessProtocol(v)!.handler, guessProtocol(v)!.options);
add('airoha', { ble: true });

function transportFor(kind: Transport['kind']): Transport {
	if (kind !== 'hid')
		return { kind, write: async () => {}, read: async () => null, close: async () => {} };
	return {
		kind,
		vendorId: 0,
		productId: 0,
		productName: '',
		collections: [
			{
				usagePage: 0xff00,
				usage: 1,
				inputReports: [],
				outputReports: [{ reportId: 8, size: 63 }],
				featureReports: [],
				children: []
			}
		],
		sendReport: async () => {},
		sendFeatureReport: async () => {},
		receiveFeatureReport: async () => new Uint8Array(64),
		onInputReport: () => () => {},
		close: async () => {}
	};
}

/**
 * Grid points of `w` within [lo, hi], plus the grid's own end points: a decoder that reads an
 * end of the field as "unset" mustn't advertise it.
 */
function onGrid(w: WireField, lo: number, hi: number): fc.Arbitrary<number> {
	const min = Math.max(w.min, lo);
	const max = Math.min(w.max, hi);
	if (w.step === undefined)
		return fc
			.integer({ min: Math.ceil(min * 100), max: Math.floor(max * 100) })
			.map((k) => k / 100);
	const step = w.step;
	const at = (k: number) => Number((k * step).toPrecision(12));
	return fc.oneof(
		fc.integer({ min: Math.ceil(min / step - 1e-9), max: Math.floor(max / step + 1e-9) }).map(at),
		fc.constantFrom(at(Math.round(w.min / step)), at(Math.round(w.max / step)))
	);
}

const freqs = (wire: WireGrid) =>
	'values' in wire.freq ? fc.constantFrom(...wire.freq.values) : onGrid(wire.freq, 10, 20000);

const close = (a: number | undefined, b: number | undefined) =>
	a !== undefined && b !== undefined && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

describe.each(
	[...variants.values()].map((v) => [`${v.handler} ${JSON.stringify(v.options)}`, v] as const)
)('%s', (_name, { handler: id, options }) => {
	const handler = HANDLERS[id as keyof typeof HANDLERS] as AnyHandler;
	const { codec } = handler;
	const wire = codec.wire(options);
	const caps = handler.capabilities(transportFor(transportsOf(handler)[0]!), options);
	const types = codec.types.filter((t) => !t.startsWith('x-'));

	const filter: fc.Arbitrary<Filter> = fc.record({
		type: fc.constantFrom(...types),
		freq: freqs(wire),
		q: wire.q ? onGrid(wire.q, 0.1, 20) : fc.constant(1),
		gain: onGrid(wire.gain, -20, 20)
	});
	const request: fc.Arbitrary<PushRequest> = fc
		.record({
			filters: caps.bands
				? fc.array(filter, { minLength: caps.bands, maxLength: caps.bands })
				: fc.array(filter, { minLength: 1, maxLength: 10 }),
			preamp:
				wire.preamp && caps.writesPreamp
					? fc.option(onGrid(wire.preamp, -20, 0), { nil: undefined })
					: fc.constant(undefined)
		})
		.map(({ filters, preamp }) => (preamp === undefined ? { filters } : { filters, preamp }));

	test('decode(encode(request)) gives the request back', () => {
		fc.assert(
			fc.property(request, (r) => {
				const state = codec.decode(codec.encode(r, options), options);
				expect(state.filters).toHaveLength(r.filters.length);
				r.filters.forEach((f, i) => {
					const g = state.filters[i]!;
					expect(g.type).toBe(f.type);
					expect(close(g.freq, f.freq), `freq ${g.freq} ≠ ${f.freq}`).toBe(true);
					if (wire.q) expect(close(g.q, f.q), `q ${g.q} ≠ ${f.q}`).toBe(true);
					expect(close(g.gain, f.gain), `gain ${g.gain} ≠ ${f.gain}`).toBe(true);
				});
				if (r.preamp !== undefined) expect(close(state.preamp, r.preamp)).toBe(true);
			}),
			{ numRuns: 50 }
		);
	});

	const base = (): Filter => ({
		type: types[0]!,
		freq: 'values' in wire.freq ? wire.freq.values[0]! : 1000,
		q: 1,
		gain: 0
	});
	const write = (f: Filter) =>
		codec.encode(
			{ filters: Array.from({ length: caps.bands ?? 1 }, (_, i) => (i === 0 ? f : base())) },
			options
		);
	const refused = (f: Filter, code: string) => {
		try {
			write(f);
		} catch (e) {
			return isBridgeError(e, code as never);
		}
		return false;
	};

	test('a value outside the wire is refused, not clamped', () => {
		// Past the last grid point; a float field's range is the float range.
		const over = (w: WireField) => (w.step === undefined ? w.max * 2 : w.max + w.step);
		expect(refused({ ...base(), gain: over(wire.gain) }, 'unrepresentable')).toBe(true);
		const freq = 'values' in wire.freq ? 1001.5 : over(wire.freq);
		expect(refused({ ...base(), freq }, 'unrepresentable')).toBe(true);
	});

	test('a preamp or slot the write does not carry is refused', () => {
		const filters = Array.from({ length: caps.bands ?? 1 }, base);
		const refusedWith = (extra: Partial<PushRequest>) => {
			try {
				codec.encode({ filters, ...extra }, options);
			} catch (e) {
				return isBridgeError(e, 'invalid-request');
			}
			return false;
		};
		if (!caps.writesPreamp) expect(refusedWith({ preamp: 0 })).toBe(true);
		if (!caps.writesSlot) expect(refusedWith({ slot: 0 })).toBe(true);
	});

	const missing = (FILTER_TYPES as readonly FilterType[]).filter((t) => !codec.types.includes(t));
	test.skipIf(missing.length === 0)('a type without a wire code is refused', () => {
		expect(refused({ ...base(), type: missing[0]! }, 'unsupported-type')).toBe(true);
	});
});
