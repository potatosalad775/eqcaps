import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { domainViolation, fit, near, project } from '../src/index.ts';
import {
	caseArb,
	freqDomain,
	gainDomain,
	profileArb,
	qDomain,
	validListArb
} from './arbitraries.ts';
import {
	checkAssign,
	checkComplete,
	checkFaithful,
	checkIdempotent,
	checkNoAddedBands,
	checkSound
} from './checks.ts';

// The normative engine properties (SPEC §13.5–§13.7) over random valid profiles and filter lists.
// The exit criterion of Phase 2 is ≥ 10k cases per property.

/** Cases per property. Set EQCAPS_PROPERTY_RUNS to search harder, e.g. 100000. */
const RUNS = Number(process.env['EQCAPS_PROPERTY_RUNS'] ?? 10_000);
vi.setConfig({ testTimeout: Math.max(30_000, RUNS * 5) });

describe('fit properties (SPEC §13.6)', () => {
	it('sound: feasible ⇔ validate(slots) = []; slots and preamp are always in their domains', () => {
		fc.assert(
			fc.property(caseArb, (c) => checkSound(c.profile, c.filters, c.preamp)),
			{ numRuns: RUNS }
		);
	});

	it('faithful: validateList(x) = [] ⇒ slots hold x, with no changes', () => {
		let applied = 0;
		fc.assert(
			fc.property(caseArb, (c) => {
				if (checkFaithful(c.profile, c.filters, c.preamp)) applied++;
			}),
			{ numRuns: RUNS }
		);
		// Enough of the generated lists are valid for the property to mean something.
		expect(applied).toBeGreaterThan(RUNS / 10);
	});

	it('idempotent: fit(F.slots) = F', () => {
		fc.assert(
			fc.property(caseArb, (c) => checkIdempotent(c.profile, c.filters, c.preamp)),
			{ numRuns: RUNS }
		);
	});

	it('never increases the number of active filters', () => {
		fc.assert(
			fc.property(caseArb, (c) => checkNoAddedBands(c.profile, c.filters, c.preamp)),
			{ numRuns: RUNS }
		);
	});
});

describe('assign property (SPEC §13.5)', () => {
	it('returns a valid assignment whenever one exists', () => {
		const arb = profileArb.chain((profile) =>
			fc.record({ profile: fc.constant(profile), filters: validListArb(profile) })
		);
		fc.assert(
			fc.property(arb, (c) => checkAssign(c.profile, c.filters, true)),
			{ numRuns: RUNS }
		);
	});
});

describe('complete properties (SPEC §13.7)', () => {
	it('fills exactly bandCount slots, keeps filled ones, and keeps the order validate allowed', () => {
		fc.assert(
			fc.property(caseArb, (c) =>
				checkComplete(c.profile, fit(c.profile, c.filters, c.preamp).slots)
			),
			{ numRuns: RUNS }
		);
	});
});

describe('exact ops', () => {
	it('project lands in the domain, fixes members, and is idempotent', () => {
		const arb = fc.oneof(
			fc.tuple(freqDomain, fc.constant('freq' as const)),
			fc.tuple(qDomain, fc.constant('q' as const)),
			fc.tuple(gainDomain, fc.constant('gain' as const))
		);
		const value = fc.oneof(
			fc.double({ min: -1e5, max: 1e5 }),
			fc.double({ min: 0.001, max: 30000, noNaN: true }),
			fc.constantFrom(NaN, Infinity, -Infinity, 0)
		);
		fc.assert(
			fc.property(arb, value, ([d, field], x) => {
				const y = project(x, d, field);
				expect(domainViolation(y, d)).toBeNull();
				expect(project(y, d, field)).toBe(y);
				if (domainViolation(x, d) === null) expect(near(y, x)).toBe(true);
			}),
			{ numRuns: RUNS }
		);
	});
});
