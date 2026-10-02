import fc from 'fast-check';
import {
	FILTER_TYPES,
	isKnownType,
	toRealized,
	validateProfile,
	type Domain,
	type Filter,
	type FilterType,
	type Law,
	type Profile,
	type Rule,
	type Variant,
	usesGain
} from '../src/index.ts';
import { normalizeDecimal } from '../src/project.ts';
import { engineProfile, resolveField, type EngineSlot } from '../src/resolve.ts';

// Random valid profiles and filter lists for the engine properties (SPEC §13.6).

const pick = <T>(xs: readonly T[]) => fc.constantFrom(...xs);

/** Bounds a and b < c from `xs`. */
const bounds = (xs: readonly number[]) =>
	fc
		.tuple(fc.integer({ min: 0, max: xs.length - 2 }), fc.integer({ min: 1, max: xs.length - 1 }))
		.map(([i, d]) => [xs[i] as number, xs[Math.min(xs.length - 1, i + d)] as number] as const);

const sorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

export const freqDomain: fc.Arbitrary<Domain> = fc.oneof(
	bounds([20, 50, 100, 200, 1000, 4000, 8000, 20000]).map(([min, max]) => ({ min, max })),
	fc
		.tuple(bounds([20, 50, 100, 200, 1000, 4000, 8000, 20000]), pick([0.5, 1, 10]))
		.map(([[min, max], step]) => ({ min, max, step })),
	fc
		.subarray([31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000], { minLength: 1 })
		.map((v) => ({ values: sorted(v) })),
	pick([100, 1000, 3000]).map((value) => ({ value }))
);

export const qDomain: fc.Arbitrary<Domain> = fc.oneof(
	fc.tuple(pick([0.1, 0.3, 0.5, 0.7]), pick([2, 5, 10])).map(([min, max]) => ({ min, max })),
	fc
		.tuple(pick([0.1, 0.3, 0.5]), pick([2, 5, 10]), pick([0.01, 0.1]))
		.map(([min, max, step]) => ({ min, max, step })),
	fc.constant({ min: 0.5, max: 5, step: 0.07142857142857142 }),
	fc.subarray([0.5, 0.707, 1, 1.41, 2, 4], { minLength: 1 }).map((v) => ({ values: sorted(v) })),
	pick([0.707, 1.41]).map((value) => ({ value }))
);

export const gainDomain: fc.Arbitrary<Domain> = fc.oneof(
	pick([3, 6, 12, 20]).map((g) => ({ min: -g, max: g })),
	fc
		.tuple(pick([6, 12]), pick([0.1, 0.25, 0.5, 1]))
		.map(([g, step]) => ({ min: -g, max: g, step })),
	fc.subarray([-6, -3, 0, 3, 6], { minLength: 1 }).map((v) => ({ values: sorted(v) })),
	pick([0, 3]).map((value) => ({ value })),
	fc.constant({ min: 1, max: 6 })
);

const types: fc.Arbitrary<FilterType[]> = fc.oneof(
	{ weight: 3, arbitrary: fc.constant<FilterType[]>(['PK']) },
	{ weight: 3, arbitrary: fc.shuffledSubarray([...FILTER_TYPES], { minLength: 1, maxLength: 4 }) },
	{
		weight: 1,
		arbitrary: fc.shuffledSubarray(['PK', 'LSC', 'HSC'] as FilterType[], { minLength: 1 })
	}
);

/** Variants whose edges (type → *, gain → freq, gain → q, freq → q) agree with every law's. */
const variant: fc.Arbitrary<Variant> = fc.oneof(
	freqDomain.map((freq) => ({ when: { gain: { gt: 0 } }, freq })),
	fc
		.tuple(fc.shuffledSubarray([...FILTER_TYPES], { minLength: 1, maxLength: 3 }), qDomain)
		.map(([t, q]) => ({ when: { type: { in: t } }, q })),
	qDomain.map((q) => ({ when: { freq: { lt: 1000 } }, q })),
	gainDomain.map((gain) => ({ when: { type: { eq: 'PK' as FilterType } }, gain })),
	qDomain.map((q) => ({ when: { gain: { lte: -3 } }, q }))
);

const slotFields = fc.record(
	{
		types,
		freq: freqDomain,
		q: qDomain,
		gain: gainDomain,
		variants: fc.array(variant, { minLength: 1, maxLength: 2 })
	},
	{ requiredKeys: [] }
);

const laws: fc.Arbitrary<Law[]> = fc
	.record(
		{
			gainScaledQ: fc.shuffledSubarray(['PK', 'LSC', 'HSC'] as ('PK' | 'LSC' | 'HSC')[], {
				minLength: 1
			}),
			nyquistScaledQ: fc.tuple(
				fc.shuffledSubarray([...FILTER_TYPES], { minLength: 1, maxLength: 3 }),
				pick([48000, 96000])
			),
			shelfFrequencyShift: fc.shuffledSubarray(['LSC', 'HSC'] as ('LSC' | 'HSC')[], {
				minLength: 1
			})
		},
		{ requiredKeys: [] }
	)
	.map((r) => {
		const out: Law[] = [];
		if (r.gainScaledQ) out.push({ law: 'gainScaledQ', types: r.gainScaledQ });
		if (r.nyquistScaledQ) {
			const [t, designRate] = r.nyquistScaledQ;
			out.push({ law: 'nyquistScaledQ', types: t, designRate });
		}
		if (r.shelfFrequencyShift) {
			out.push({ law: 'shelfFrequencyShift', types: r.shelfFrequencyShift, designRate: 48000 });
		}
		return out;
	});

const rules: fc.Arbitrary<Rule[]> = fc.oneof(
	{ weight: 3, arbitrary: fc.constant<Rule[]>([]) },
	{ weight: 2, arbitrary: fc.constant<Rule[]>([{ type: 'ascendingFrequency' }]) },
	{ weight: 1, arbitrary: fc.constant<Rule[]>([{ type: 'ascendingFrequency', strict: false }]) },
	{
		weight: 2,
		arbitrary: pick([0.1, 0.25, 0.5]).map((octaves): Rule[] => [{ type: 'minSpacing', octaves }])
	}
);

const preamp = fc.oneof(
	fc.constant({ mode: 'manual' as const, gain: { min: -12, max: 0, step: 0.5 } }),
	fc.constant({ mode: 'manual' as const, gain: { min: -6, max: 6 } }),
	pick(['none', 'auto', 'unknown'] as const).map((mode) => ({ mode }))
);

const source = { kind: 'community' as const, ref: 'property test', date: '2026-10-02' };

export const profileArb: fc.Arbitrary<Profile> = fc
	.record({
		bandCount: fc.oneof(
			{ weight: 9, arbitrary: fc.integer({ min: 1, max: 8 }) },
			{ weight: 1, arbitrary: fc.constant(null) }
		),
		band: fc.record({
			types,
			freq: freqDomain,
			q: qDomain,
			gain: gainDomain,
			variants: fc.array(variant, { maxLength: 2 })
		}),
		overrides: fc.array(slotFields, { maxLength: 6 }),
		laws: fc.option(laws, { nil: undefined }),
		rules,
		preamp
	})
	.map((r): Profile => {
		const n = r.bandCount;
		const bands =
			n === null
				? []
				: r.overrides
						.slice(0, n)
						.flatMap((o, i) => (Object.keys(o).length ? [{ index: i % n, ...o }] : []));
		const unique = bands.filter((b, k) => bands.findIndex((c) => c.index === b.index) === k);
		return {
			schemaVersion: '1.0',
			id: 'property',
			kind: n === null ? 'software' : 'hardware',
			device: { brand: 'Property', model: 'Test' },
			...(n !== null && { match: { usb: [{ vendorId: '0x0001', productId: '0x0001' }] } }),
			bandCount: n,
			band: r.band,
			...(unique.length > 0 && { bands: unique }),
			rules: r.rules,
			...(r.laws && { realization: { laws: r.laws, sources: [source] } }),
			preamp: r.preamp,
			meta: { status: 'draft', sources: [source] }
		};
	})
	.filter((p) => validateProfile(p).length === 0);

// --- Filters -----------------------------------------------------------------------------------

const logUniform = (min: number, max: number) =>
	fc.double({ min: Math.log(min), max: Math.log(max), noNaN: true }).map(Math.exp);

export const filterArb = (profile: Profile): fc.Arbitrary<Filter> => {
	const known = [...new Set(engineProfile(profile).slots.flatMap((s) => s.types))].filter(
		isKnownType
	);
	return fc.record({
		type: fc.oneof(
			{ weight: 4, arbitrary: pick<FilterType>(known.length ? known : ['PK']) },
			pick<FilterType>([...FILTER_TYPES])
		),
		freq: logUniform(10, 30000),
		q: logUniform(0.05, 20),
		gain: fc.oneof(
			fc.constant(0),
			fc.integer({ min: -30, max: 30 }).map((g) => g / 2),
			fc.double({ min: -20, max: 20, noNaN: true })
		)
	});
};

/** A random member of a domain. */
export function member(d: Domain): fc.Arbitrary<number> {
	if ('value' in d) return fc.constant(d.value);
	if ('values' in d) return pick(d.values);
	if (!('step' in d))
		return fc.oneof(pick([d.min, d.max]), fc.double({ min: d.min, max: d.max, noNaN: true }));
	const { min, max, step } = d;
	return fc
		.integer({ min: Math.round(min / step), max: Math.round(max / step) })
		.map((k) => normalizeDecimal(k * step));
}

/** Written values one slot accepts, built field by field in evaluation order. */
export function slotMember(slot: EngineSlot): fc.Arbitrary<Filter> {
	const knownTypes = slot.types.filter(isKnownType);
	let arb: fc.Arbitrary<Partial<Filter>> = pick(knownTypes.length ? knownTypes : slot.types).map(
		(type) => ({ type })
	);
	for (const f of slot.order) {
		arb = arb.chain((v) =>
			f === 'gain' && !usesGain(v.type as FilterType)
				? fc.constant({ ...v, gain: 0 })
				: member(resolveField(slot, f, v)).map((x) => ({ ...v, [f]: x }))
		);
	}
	return arb as fc.Arbitrary<Filter>;
}

/**
 * Written filters that fit distinct slots, as a list in random order. `realized` turns them into
 * what the app would hold.
 */
export function validListArb(profile: Profile, realized: boolean): fc.Arbitrary<Filter[]> {
	const p = engineProfile(profile);
	const n = p.bandCount ?? 4;
	return fc
		.subarray(
			Array.from({ length: n }, (_, i) => i),
			{ maxLength: n }
		)
		.chain((indices) =>
			fc.tuple(
				...indices.map((i) => slotMember(p.slots[p.bandCount === null ? 0 : i] as EngineSlot))
			)
		)
		.chain((fs) => fc.shuffledSubarray(fs, { minLength: fs.length, maxLength: fs.length }))
		.map((fs) => (realized ? fs.map((f) => toRealized(profile, f)) : fs));
}

export interface Case {
	profile: Profile;
	filters: Filter[];
	preamp: number;
}

/** A profile, a list of filters (random, valid-derived or mixed) and a preamp. */
export const caseArb: fc.Arbitrary<Case> = profileArb.chain((profile) =>
	fc.record({
		profile: fc.constant(profile),
		filters: fc.oneof(
			fc.array(filterArb(profile), { maxLength: (profile.bandCount ?? 4) + 2 }),
			validListArb(profile, true),
			fc
				.tuple(validListArb(profile, true), fc.array(filterArb(profile), { maxLength: 2 }))
				.map(([a, b]) => [...a, ...b])
		),
		preamp: fc.oneof(
			fc.constant(0),
			fc.integer({ min: -24, max: 12 }).map((g) => g / 2),
			fc.double({ min: -15, max: 15, noNaN: true })
		)
	})
);
