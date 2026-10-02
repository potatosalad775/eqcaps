// Generates the engine conformance vectors conformance/v1/<op>.json (SPEC §13.8) from the inputs
// below. Exact ops get their expectation from the reference engine in packages/core; property
// ops carry the facts a case asserts, and runners check the properties themselves.
//
// Usage: node scripts/conformance.ts [--check]
// With --check nothing is written; the script fails if a vector file is out of date. After an
// intended change in engine behaviour, regenerate and review the diff of the vectors: it is the
// change every port has to follow.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
	assign,
	complete,
	fit,
	project,
	projectType,
	resolveSlot,
	toRealized,
	toWritten,
	validate,
	type Domain,
	type Filter,
	type FilterType,
	type Profile
} from '../packages/core/src/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = `${root}conformance/v1/`;

// --- Profiles ----------------------------------------------------------------------------------

/**
 * A profile reference: a path under profiles/ without .json ("examples/b-jds-labs-element-iv"),
 * or an RFC 7386 merge patch over profiles/base.json, or over the file its "$base" names.
 */
type ProfileRef = string | object;

const readJson = (path: string) => JSON.parse(readFileSync(`${dir}${path}`, 'utf8')) as unknown;

function mergePatch(target: unknown, patch: unknown): unknown {
	if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
	const out: Record<string, unknown> =
		target !== null && typeof target === 'object' && !Array.isArray(target)
			? { ...(target as Record<string, unknown>) }
			: {};
	for (const [k, v] of Object.entries(patch)) {
		if (v === null) delete out[k];
		else out[k] = mergePatch(out[k], v);
	}
	return out;
}

function resolveProfile(ref: ProfileRef): Profile {
	if (typeof ref === 'string') return readJson(`profiles/${ref}.json`) as Profile;
	const { $base = 'base', ...patch } = ref as { $base?: string };
	return mergePatch(readJson(`profiles/${$base}.json`), patch) as Profile;
}

const JDS = 'examples/b-jds-labs-element-iv';
const PARTITIONED = 'examples/c-partitioned-windows';
const GAIN_WINDOW = 'examples/d-gain-dependent-window';
const GRAPHIC = 'examples/e-graphic-10';
const APO = 'examples/g-equalizer-apo';
const LAWS = 'examples/h-realization-laws';
const BASE = {};

const source = [{ kind: 'community', ref: 'conformance', date: '2026-10-02' }];
const NYQUIST = {
	realization: {
		laws: [{ law: 'nyquistScaledQ', types: ['PK', 'LPQ'], designRate: 48000 }],
		sources: source
	}
};
const ASCENDING = { rules: [{ type: 'ascendingFrequency' }] };
const LOCKED_MIDDLE = {
	bandCount: 3,
	bands: [{ index: 1, freq: { value: 1000 } }],
	rules: [{ type: 'ascendingFrequency' }]
};
const SPACING = { rules: [{ type: 'minSpacing', octaves: 1 }] };
/** Slot 0 sits above the slots fixed at 100 and 250 Hz, so no assignment is in order. */
const UNORDERABLE = {
	bandCount: 6,
	band: {
		freq: { min: 1000, max: 4000 },
		q: { min: null, max: null, step: null, values: [4] },
		gain: { min: 1, max: 6, step: null }
	},
	bands: [
		{ index: 0, gain: { min: -6, max: 6, step: 0.1 } },
		{ index: 2, freq: { value: 100 } },
		{ index: 3, freq: { values: [250] }, gain: { min: -6, max: 6, step: 0.1 } }
	],
	rules: [{ type: 'ascendingFrequency' }]
};
/** Slot 3 sits above every later slot; fit's passes repeat only after more than 8 of them. */
const LONG_CYCLE = {
	bandCount: 8,
	band: {
		types: ['LSC', 'PK', 'HSC'],
		freq: { min: 20, max: 1000, step: 0.5 },
		q: { min: null, max: null, step: null, values: [1.41, 2] },
		gain: { min: 1, max: 6, step: null }
	},
	bands: [
		{ index: 2, types: ['NO', 'BP', 'LSC'] },
		{ index: 3, freq: { min: 8000, max: 20000 } }
	],
	rules: [{ type: 'ascendingFrequency', strict: false }],
	realization: {
		laws: [{ law: 'shelfFrequencyShift', types: ['LSC', 'HSC'], designRate: 48000 }],
		sources: source
	},
	preamp: { mode: 'auto' }
};
const CONDITIONS = {
	band: {
		types: ['PK', 'LSC', 'LPQ'],
		variants: [
			{ when: { type: { in: ['LSC'] } }, q: { value: 0.707 } },
			{ when: { freq: { gte: 1000, lt: 5000 } }, q: { min: 0.5, max: 2, step: 0.1 } },
			{ when: { gain: { gt: 0 } }, freq: { min: 200, max: 8000 } },
			{ when: { gain: { eq: -6 } }, freq: { value: 100 } }
		]
	}
};

// --- Vectors -----------------------------------------------------------------------------------

const pk = (freq: number, gain: number, q = 1): Filter => ({ type: 'PK', freq, q, gain });
const f = (type: FilterType, freq: number, q: number, gain: number): Filter => ({
	type,
	freq,
	q,
	gain
});

interface Vector {
	description: string;
	profile?: ProfileRef;
	op: string;
	input: Record<string, unknown>;
	expect: unknown;
}

/** JSON has no NaN or infinities: vectors spell them as strings. */
const special = (x: number): number | string => (Number.isFinite(x) ? x : String(x));

function projectVector(
	description: string,
	value: number,
	domain: Domain,
	field: 'freq' | 'q' | 'gain' | 'preamp'
): Vector {
	return {
		description,
		op: 'project',
		input: { value: special(value), domain, field },
		expect: project(value, domain, field)
	};
}

function projectTypeVector(description: string, value: FilterType, types: FilterType[]): Vector {
	return {
		description,
		op: 'project',
		input: { value, domain: types, field: 'type' },
		expect: projectType(value, types)
	};
}

const exact = (
	op: 'resolveSlot' | 'toRealized' | 'toWritten' | 'validate',
	description: string,
	profile: ProfileRef,
	input: Record<string, unknown>
): Vector => {
	const p = resolveProfile(profile);
	const i = input as never as {
		slot: number;
		filter: Filter;
		slots: (Filter | null)[];
		preamp?: number;
	};
	const result =
		op === 'resolveSlot'
			? i.filter
				? resolveSlot(p, i.slot, i.filter)
				: resolveSlot(p, i.slot)
			: op === 'toRealized'
				? toRealized(p, i.filter)
				: op === 'toWritten'
					? toWritten(p, i.filter)
					: validate(p, i.slots, i.preamp);
	return { description, profile, op, input, expect: result };
};

const files: Record<string, { description: string; vectors: Vector[] }> = {
	project: {
		description:
			'project(value, domain, field) (SPEC §13.2). For field "type", domain is the slot\'s types.',
		vectors: [
			projectVector('range: below min clamps', 10, { min: 20, max: 20000 }, 'freq'),
			projectVector('range: above max clamps', 25000, { min: 20, max: 20000 }, 'freq'),
			projectVector('range: inside stays', 1234.5, { min: 20, max: 20000 }, 'freq'),
			projectVector('stepped: half-way rounds up', 0.25, { min: -12, max: 12, step: 0.5 }, 'gain'),
			projectVector(
				'stepped: negative half-way rounds up, towards 0',
				-0.25,
				{ min: -12, max: 12, step: 0.5 },
				'gain'
			),
			projectVector(
				'stepped: -0.75 rounds up to -0.5',
				-0.75,
				{ min: -12, max: 12, step: 0.5 },
				'gain'
			),
			projectVector('stepped: clamps first', 12.3, { min: -12, max: 12, step: 0.5 }, 'gain'),
			projectVector(
				'stepped 1/14: min stays on the grid',
				0.5,
				{ min: 0.5, max: 5, step: 0.07142857142857142 },
				'q'
			),
			projectVector(
				'stepped 1/14: rounds to the grid, 10 decimals',
				0.54,
				{ min: 0.5, max: 5, step: 0.07142857142857142 },
				'q'
			),
			projectVector(
				'stepped 1/14: max stays on the grid',
				5,
				{ min: 0.5, max: 5, step: 0.07142857142857142 },
				'q'
			),
			projectVector(
				'stepped: decimal step lands on a short decimal',
				0.123,
				{ min: 0.1, max: 10, step: 0.01 },
				'q'
			),
			projectVector(
				'set freq: log distance, 88 Hz is nearer 62',
				88,
				{ values: [31, 62, 125, 250] },
				'freq'
			),
			projectVector(
				'set freq: log distance, 89 Hz is nearer 125',
				89,
				{ values: [31, 62, 125, 250] },
				'freq'
			),
			projectVector('set freq: below the first value', 1, { values: [31, 62, 125, 250] }, 'freq'),
			projectVector('set freq: zero clamps to the first value', 0, { values: [31, 62] }, 'freq'),
			projectVector('set q: log distance', 0.6, { values: [0.5, 0.707, 1] }, 'q'),
			projectVector('set gain: a tie goes to the lower value', 0, { values: [-1, 1] }, 'gain'),
			projectVector('set gain: linear distance', 96, { values: [90, 100] }, 'gain'),
			projectVector('set preamp: linear distance', -4.4, { values: [-6, -3, 0] }, 'preamp'),
			projectVector('locked', 3, { value: 1.41 }, 'q'),
			projectVector('NaN gain is 0', NaN, { min: -12, max: 12 }, 'gain'),
			projectVector('NaN q is 1, projected', NaN, { min: 0.1, max: 10, step: 0.01 }, 'q'),
			projectVector('NaN freq is the log centre', NaN, { min: 20, max: 20000 }, 'freq'),
			projectVector('NaN preamp is 0, projected', NaN, { min: -12, max: -3 }, 'preamp'),
			projectVector('+Infinity is max', Infinity, { min: -12, max: 12, step: 0.5 }, 'gain'),
			projectVector('-Infinity is the first value', -Infinity, { values: [1, 2] }, 'gain'),
			projectTypeVector('type: allowed stays', 'HSC', ['PK', 'HSC']),
			projectTypeVector('type: otherwise the first type', 'LSC', ['PK', 'HSC'])
		]
	},
	resolveSlot: {
		description: 'resolveSlot(profile, slot, filter?) (SPEC §13.1).',
		vectors: [
			exact('resolveSlot', 'template merged with an override', JDS, { slot: 0 }),
			exact('resolveSlot', 'a slot without override', JDS, { slot: 5 }),
			exact('resolveSlot', 'override per key, replace', PARTITIONED, { slot: 3 }),
			exact('resolveSlot', 'without a filter, variants are ignored', GAIN_WINDOW, { slot: 0 }),
			exact('resolveSlot', 'variant holds: gain > 0', GAIN_WINDOW, {
				slot: 0,
				filter: pk(1000, 3)
			}),
			exact('resolveSlot', 'variant fails: gain = 0', GAIN_WINDOW, {
				slot: 0,
				filter: pk(1000, 0)
			}),
			exact('resolveSlot', 'gt uses the tolerance: 1e-12 is not > 0', GAIN_WINDOW, {
				slot: 0,
				filter: pk(1000, 1e-12)
			}),
			exact('resolveSlot', 'type condition', CONDITIONS, {
				slot: 0,
				filter: f('LSC', 2000, 1, 3)
			}),
			exact('resolveSlot', 'per field, first match wins', CONDITIONS, {
				slot: 0,
				filter: pk(2000, 3)
			}),
			exact('resolveSlot', 'gte holds at the bound', CONDITIONS, { slot: 0, filter: pk(1000, -3) }),
			exact('resolveSlot', 'gte holds within tolerance below the bound', CONDITIONS, {
				slot: 0,
				filter: pk(999.9999999999, -3)
			}),
			exact('resolveSlot', 'lt fails at the bound', CONDITIONS, { slot: 0, filter: pk(5000, -3) }),
			exact('resolveSlot', 'eq', CONDITIONS, { slot: 0, filter: pk(300, -6) }),
			exact('resolveSlot', 'gainless types count as gain 0 in conditions', CONDITIONS, {
				slot: 0,
				filter: f('LPQ', 300, 0.7, 6)
			}),
			exact('resolveSlot', 'graphic slot: freq and q locked', GRAPHIC, { slot: 9 }),
			exact('resolveSlot', 'unbounded: any slot is the template', APO, { slot: 99 })
		]
	},
	toRealized: {
		description: 'toRealized(profile, filter) (SPEC §13.3).',
		vectors: [
			exact('toRealized', 'no realization: identity', BASE, { filter: pk(1000, -12, 4) }),
			exact('toRealized', 'gainScaledQ: q / A', LAWS, { filter: pk(1000, -12, 4) }),
			exact('toRealized', 'gainScaledQ uses |gain|', LAWS, { filter: pk(1000, 12, 4) }),
			exact('toRealized', 'low shelf: both laws', LAWS, { filter: f('LSC', 100, 0.7, 6) }),
			exact('toRealized', 'high shelf: frequency moves down', LAWS, {
				filter: f('HSC', 8000, 0.7, 6)
			}),
			exact('toRealized', 'shelf at 0 dB: unchanged', LAWS, { filter: f('LSC', 100, 0.7, 0) }),
			exact('toRealized', 'freq at or above designRate/2: law not applied', LAWS, {
				filter: f('LSC', 30000, 0.7, 6)
			}),
			exact('toRealized', 'gainless type: gain is 0, no law applies', LAWS, {
				filter: f('BP', 1000, 2, 9)
			}),
			exact('toRealized', 'nyquistScaledQ: q · cos(π·f / designRate)', NYQUIST, {
				filter: pk(12000, 3)
			}),
			exact('toRealized', 'nyquistScaledQ on a gainless type', NYQUIST, {
				filter: f('LPQ', 6000, 0.707, 0)
			})
		]
	},
	toWritten: {
		description: 'toWritten(profile, filter) (SPEC §13.3).',
		vectors: [
			exact('toWritten', 'no realization: identity', BASE, { filter: pk(1000, -12, 4) }),
			exact('toWritten', 'gainScaledQ: q · A', LAWS, { filter: pk(1000, -12, 4) }),
			exact('toWritten', 'low shelf: freq inverted first, then q', LAWS, {
				filter: f('LSC', 100, 0.7, 6)
			}),
			exact('toWritten', 'high shelf', LAWS, { filter: f('HSC', 8000, 0.7, -6) }),
			exact('toWritten', 'freq at or above designRate/2: law not applied', LAWS, {
				filter: f('HSC', 24000, 0.7, 6)
			}),
			exact('toWritten', 'nyquistScaledQ: q factor at the written freq', NYQUIST, {
				filter: pk(12000, 3, Math.SQRT1_2)
			}),
			exact('toWritten', 'gainless type: gain becomes 0', BASE, { filter: f('NO', 1000, 5, 4) })
		]
	},
	validate: {
		description:
			'validate(profile, slots, preamp?) (SPEC §13.4). Exact, including the order of violations.',
		vectors: [
			exact('validate', 'valid slots, empty ones included', BASE, {
				slots: [pk(1000, 3), null, pk(4000, -2.5, 0.71)]
			}),
			exact('validate', 'per slot: type, then freq, q, gain', BASE, {
				slots: [pk(1000, 3), null, f('LSC', 100, 0.7, 3), pk(30000, 0.15, 0.105)]
			}),
			exact(
				'validate',
				'gainless type: gain not checked',
				{ band: { types: ['PK', 'LPQ'] } },
				{
					slots: [f('LPQ', 5000, 0.7, 99)]
				}
			),
			exact('validate', 'not in set: a lookup-table frequency', 'examples/a-edifier-w830nb', {
				slots: [pk(76, 1.25, 0.5), pk(80, 1.25, 0.5)]
			}),
			exact('validate', 'locked frequency and q', GRAPHIC, {
				slots: [pk(31, 3, 1.41), pk(63, 3, 1.41), pk(125, 3, 1.4)]
			}),
			exact('validate', 'values within tolerance are members', GRAPHIC, {
				slots: [pk(31.0000000000001, 3, 1.41)]
			}),
			exact('validate', 'domain bounds are members', BASE, {
				slots: [pk(20, 12, 10), pk(20000, -12, 0.1)]
			}),
			exact('validate', 'variants resolved against the filter itself', GAIN_WINDOW, {
				slots: [pk(100, -3), pk(100, 3)]
			}),
			exact('validate', 'too many bands, reported once', BASE, {
				slots: [pk(100, 1), pk(200, 1), pk(400, 1), pk(800, 1), pk(1600, 1), pk(3200, 1)]
			}),
			exact('validate', 'preamp none: must be 0', BASE, { slots: [], preamp: -3 }),
			exact('validate', 'preamp manual: domain', LAWS, { slots: [], preamp: 0.5 }),
			exact('validate', 'preamp manual: off grid', LAWS, { slots: [], preamp: -0.05 }),
			exact('validate', 'preamp auto: not checked', GAIN_WINDOW, { slots: [], preamp: 5 }),
			exact('validate', 'preamp left out: not checked', BASE, { slots: [] }),
			exact('validate', 'ascendingFrequency: a filter out of order', ASCENDING, {
				slots: [pk(1000, 1), pk(500, 1)]
			}),
			exact('validate', 'ascendingFrequency: strict rejects equal', ASCENDING, {
				slots: [pk(1000, 1), pk(1000, 1)]
			}),
			exact(
				'validate',
				'ascendingFrequency: non-strict allows equal',
				{ rules: [{ type: 'ascendingFrequency', strict: false }] },
				{ slots: [pk(1000, 1), pk(1000, 1)] }
			),
			exact('validate', 'ascendingFrequency: a locked filler with no room', LOCKED_MIDDLE, {
				slots: [pk(2000, 1), null, pk(5000, 1)]
			}),
			exact('validate', 'ascendingFrequency: a locked filler that fits', LOCKED_MIDDLE, {
				slots: [pk(500, 1), null, pk(5000, 1)]
			}),
			exact(
				'validate',
				'ascendingFrequency: a range filler needs a value strictly above its neighbour',
				{
					bandCount: 3,
					bands: [{ index: 1, freq: { min: 1000, max: 4000 } }],
					rules: [{ type: 'ascendingFrequency' }]
				},
				{ slots: [pk(4000, 1), null, pk(5000, 1)] }
			),
			exact('validate', 'ascendingFrequency: partitioned windows', PARTITIONED, {
				slots: [pk(100, 1), pk(1000, 1), null, pk(5000, 1)]
			}),
			exact(
				'validate',
				'ascendingFrequency on an unbounded profile skips empty slots',
				{ $base: APO, rules: [{ type: 'ascendingFrequency' }] },
				{ slots: [pk(100, 1), null, pk(500, 1), pk(50, 1)] }
			),
			exact('validate', 'minSpacing: active filters only, higher slot reported', SPACING, {
				slots: [pk(100, 1), pk(150, 1), pk(400, 1), pk(160, 0)]
			}),
			exact('validate', 'minSpacing: exactly the spacing is enough', SPACING, {
				slots: [pk(100, 1), pk(200, 1)]
			}),
			exact(
				'validate',
				'unknown rule and an allowed unknown type',
				{ band: { types: ['PK', 'x-tilt'] }, rules: [{ type: 'maxResponse', db: 6 }] },
				{ slots: [f('x-tilt', 1000, 1, 2)] }
			),
			exact('validate', 'unbounded profile: any number of slots', APO, {
				slots: [pk(100, 1), pk(200, 1), pk(400, 1), pk(800, 1), pk(1600, 1), pk(30000, 1)]
			})
		]
	},
	assign: {
		description:
			'assign(profile, filters) (SPEC §13.5). Property op: expect.valid says whether an assignment exists in which every active filter has a slot that accepts it as it is; if so, assign must return one. Inactive filters always get no slot.',
		vectors: [
			assignVector('type-partitioned slots', JDS, [
				pk(1000, 3),
				f('HSC', 8000, 0.7, 2),
				pk(2000, -1),
				f('LSC', 100, 0.7, 4),
				pk(500, 0)
			]),
			assignVector('frequency-partitioned slots, input reversed', PARTITIONED, [
				pk(5000, 1),
				pk(2000, 1),
				pk(500, 1),
				f('LSC', 100, 1, 1)
			]),
			assignVector(
				'first fit would block the valid assignment',
				{ bandCount: 2, bands: [{ index: 1, freq: { min: 1000, max: 2000 } }] },
				[pk(1500, 1), pk(8000, 1)]
			),
			assignVector('gain-dependent windows', GAIN_WINDOW, [pk(100, -3), pk(300, 3), pk(4000, 2)]),
			assignVector('graphic: one filter per centre', GRAPHIC, [
				pk(1000, 3, 1.41),
				pk(31, -2, 1.41),
				pk(16000, 4, 1.41)
			]),
			assignVector(
				'more filters than slots',
				BASE,
				[pk(100, 3), pk(200, 0.5), pk(400, -6), pk(800, 2), pk(1600, 1)],
				false
			),
			assignVector('a type no slot allows', BASE, [f('LSC', 100, 0.7, 3)], false),
			assignVector('unbounded', APO, [pk(100, 1), pk(200, 0), f('HPQ', 30, 0.707, 0)])
		]
	},
	fit: {
		description:
			'fit(profile, filters, preamp) (SPEC §13.6). Property op: runners check sound, faithful, idempotent and no added filters on every vector; expect.feasible is what this input must give.',
		vectors: [
			fitVector('valid input comes back unchanged', JDS, [pk(1000, 3, 2), f('LSC', 105, 0.7, 4)]),
			fitVector('every field out of its domain', BASE, [pk(30000, 15, 0.123)]),
			fitVector('realization: written q that realizes the wanted q', LAWS, [pk(1000, -12, 4)]),
			fitVector('realization: written q capped by its domain', LAWS, [pk(1000, -12, 6)]),
			fitVector('realization: shifted shelf rounded onto the written grid', LAWS, [
				f('LSC', 100, 0.7, 6)
			]),
			fitVector('preamp projected', LAWS, [], 3),
			fitVector('minSpacing moves a filter up', SPACING, [pk(100, 3), pk(150, 2)]),
			fitVector(
				'minSpacing that cannot be fixed',
				{ band: { freq: { min: 20, max: 160 } }, rules: [{ type: 'minSpacing', octaves: 1 }] },
				[pk(100, 3), pk(150, 2)]
			),
			fitVector(
				'minSpacing spreads a cluster of identical filters',
				{ bandCount: 8, rules: [{ type: 'minSpacing', octaves: 1 }] },
				Array.from({ length: 8 }, () => pk(20, 1))
			),
			fitVector('ascendingFrequency that can never hold: passes cycle', UNORDERABLE, [
				pk(1000, 0.1, 4),
				pk(1000, 1, 4),
				pk(100, 1, 4),
				pk(4000, 1, 4),
				pk(250, 1.1, 4)
			]),
			fitVector('ascendingFrequency that can never hold: a long cycle of passes', LONG_CYCLE, [
				f('BP', 21, 1, 0),
				f('BP', 17, 1, 0),
				f('NO', 10, 1, 0),
				pk(10, 1),
				f('LSC', 21, 1, -7.5),
				pk(20.25, -0.5)
			]),
			fitVector('partitioned engine ordered by frequency', PARTITIONED, [
				pk(5000, 1),
				pk(2000, 1),
				pk(500, 1),
				pk(100, 1)
			]),
			fitVector('more filters than slots', BASE, [
				pk(100, 3),
				pk(200, 0.5),
				pk(400, -6),
				pk(800, 2),
				pk(1600, 1),
				pk(3200, 0)
			]),
			fitVector('gain projected to 0 leaves the slot empty', BASE, [pk(1000, 0.04)]),
			fitVector('type projected', BASE, [f('HSC', 8000, 0.7, 3)]),
			fitVector('graphic EQ: frequencies snap to the centres', GRAPHIC, [
				pk(40, 3, 2),
				pk(900, -2, 0.7)
			]),
			fitVector('unbounded', APO, [pk(100, 1), f('HPQ', 0.5, 0.707, 0), pk(200, 40)])
		]
	},
	complete: {
		description:
			'complete(profile, slots) (SPEC §13.7). Property op: runners check its properties on every vector; expect.warnings lists the warning codes per slot this input must give.',
		vectors: [
			completeVector('fillers at the log centre', BASE, [pk(1000, 3), null]),
			completeVector('fillers spread between neighbours under ascendingFrequency', ASCENDING, [
				null,
				pk(1000, 3),
				null,
				null
			]),
			completeVector('graphic: locked frequencies', GRAPHIC, []),
			completeVector(
				'a slot that cannot take 0 dB',
				{ bandCount: 2, bands: [{ index: 1, gain: { min: 1, max: 6 } }] },
				[]
			),
			completeVector('gainless types only', { bandCount: 1, band: { types: ['HPQ', 'AP'] } }, []),
			completeVector('no room for a filler', LOCKED_MIDDLE, [pk(2000, 1), null, pk(5000, 1)]),
			completeVector('partitioned windows', PARTITIONED, [null, pk(300, 1), null, null]),
			completeVector('unbounded: only the filters', APO, [pk(100, 1), null, pk(200, 1)])
		]
	}
};

function assignVector(
	description: string,
	profile: ProfileRef,
	filters: Filter[],
	valid = true
): Vector {
	assign(resolveProfile(profile), filters); // must not throw
	return { description, profile, op: 'assign', input: { filters }, expect: { valid } };
}

function fitVector(
	description: string,
	profile: ProfileRef,
	filters: Filter[],
	preamp = 0
): Vector {
	const r = fit(resolveProfile(profile), filters, preamp);
	return {
		description,
		profile,
		op: 'fit',
		input: { filters, preamp },
		expect: { feasible: r.feasible }
	};
}

function completeVector(
	description: string,
	profile: ProfileRef,
	slots: (Filter | null)[]
): Vector {
	const r = complete(resolveProfile(profile), slots);
	return {
		description,
		profile,
		op: 'complete',
		input: { slots },
		expect: { warnings: r.warnings }
	};
}

// --- Output ------------------------------------------------------------------------------------

const check = process.argv.includes('--check');
let stale = false;
for (const [op, content] of Object.entries(files)) {
	const path = `${dir}${op}.json`;
	const text = await format(JSON.stringify(content), {
		...(await resolveConfig(path)),
		filepath: path
	});
	let current = '';
	try {
		current = readFileSync(path, 'utf8');
	} catch {
		// New file.
	}
	if (current === text) continue;
	if (check) {
		console.error(`${path} is out of date: run npm run conformance`);
		stale = true;
	} else {
		writeFileSync(path, text);
		console.log(`wrote ${path}`);
	}
}
if (stale) process.exit(1);
