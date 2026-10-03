import {
	findCycle,
	NUMERIC_FIELDS,
	variantDefines,
	variantReads,
	type Field
} from './dependencies.ts';
import { domainBounds, domainForm, near, onGrid } from './domain.ts';
import { compareFirmware } from './firmware.ts';
import { error, type Issue } from './issues.ts';
import { mergeSlotFields, overrideIndices, slotOverrides } from './slots.ts';
import type { Domain, Profile, SlotFields, Source } from './types/schema.generated.ts';

/** Source kinds that count toward a verified status (SPEC §10). */
export const COUNTING_SOURCE_KINDS: ReadonlySet<Source['kind']> = new Set([
	'probe',
	'vendor-docs',
	'vendor-app',
	'measurement'
]);

/** A source counts if its kind counts and it wasn't inherited through `extends` (SPEC §10). */
export function isCountingSource(source: Source): boolean {
	return COUNTING_SOURCE_KINDS.has(source.kind) && source.via === undefined;
}

const SLOT_FIELDS = ['types', 'freq', 'q', 'gain'] as const;
const EVIDENCE_REF = /^evidence\/[a-z0-9]+(-[a-z0-9]+)*\/[^/\\]+\.json$/;

/**
 * Semantic validation of one published (flat) profile: the rules of SPEC §2–§11 that JSON Schema
 * can't express. Expects a profile that already passed `profile.schema.json`; on anything else
 * the result is unspecified. Cross-profile rules live in `checkDatabase`.
 */
export function validateProfile(profile: Profile): Issue[] {
	return [
		...checkDomains(profile),
		...checkBands(profile),
		...checkDependencies(profile),
		...checkMatch(profile),
		...checkMeta(profile)
	];
}

// §4 ------------------------------------------------------------------------------------------

function checkDomain(d: Domain, field: 'freq' | 'q' | 'gain' | 'preamp', path: string): Issue[] {
	const issues: Issue[] = [];
	const form = domainForm(d);
	if ('min' in d && d.min > d.max) {
		issues.push(error('domain-bounds-order', path, `min ${d.min} is greater than max ${d.max}`));
	}
	if (form === 'stepped' && 'step' in d) {
		for (const bound of ['min', 'max'] as const) {
			if (!onGrid(d[bound], d.step)) {
				issues.push(
					error(
						'domain-off-grid',
						`${path}/${bound}`,
						`${bound} ${d[bound]} is not a multiple of step ${d.step}; the grid is anchored at 0, so use values for an offset grid`
					)
				);
			}
		}
	}
	if ('values' in d) {
		for (let i = 1; i < d.values.length; i++) {
			const prev = d.values[i - 1] as number;
			const cur = d.values[i] as number;
			if (!(cur > prev) || near(cur, prev)) {
				issues.push(
					error(
						'domain-values-order',
						`${path}/values/${i}`,
						`values must be strictly ascending: ${cur} follows ${prev}`
					)
				);
			}
		}
	}
	if (field === 'freq' || field === 'q') {
		const { min } = domainBounds(d);
		if (min <= 0) {
			const at =
				form === 'locked'
					? `${path}/value`
					: form === 'set'
						? `${path}/values/${(d as { values: number[] }).values.indexOf(min)}`
						: `${path}/min`;
			issues.push(error('domain-not-positive', at, `${field} must be > 0, but ${min} is allowed`));
		}
	}
	return issues;
}

function checkSlotDomains(slot: SlotFields, path: string): Issue[] {
	const issues: Issue[] = [];
	for (const f of NUMERIC_FIELDS) {
		const d = slot[f];
		if (d) issues.push(...checkDomain(d, f, `${path}/${f}`));
	}
	(slot.variants ?? []).forEach((v, j) => {
		for (const f of NUMERIC_FIELDS) {
			const d = v[f];
			if (d) issues.push(...checkDomain(d, f, `${path}/variants/${j}/${f}`));
		}
	});
	return issues;
}

function checkDomains(profile: Profile): Issue[] {
	const issues = checkSlotDomains(profile.band, '/band');
	(profile.bands ?? []).forEach((entry, k) =>
		issues.push(...checkSlotDomains(entry, `/bands/${k}`))
	);
	if (profile.preamp.mode === 'manual') {
		issues.push(...checkDomain(profile.preamp.gain, 'preamp', '/preamp/gain'));
	}
	return issues;
}

// §2, §5 --------------------------------------------------------------------------------------

function checkBands(profile: Profile): Issue[] {
	const issues: Issue[] = [];
	const bands = profile.bands ?? [];
	if (profile.bandCount === null) {
		if (bands.length > 0) {
			issues.push(
				error(
					'bands-unbounded',
					'/bands',
					'an unbounded profile (bandCount: null) has no per-slot overrides'
				)
			);
		}
	} else {
		const bandCount = profile.bandCount;
		const seen = new Set<number>();
		bands.forEach((entry, k) => {
			overrideIndices(entry).forEach((i, m) => {
				const at = Array.isArray(entry.index) ? `/bands/${k}/index/${m}` : `/bands/${k}/index`;
				if (i >= bandCount) {
					issues.push(
						error(
							'band-index-out-of-range',
							at,
							`slot ${i} does not exist (bandCount is ${bandCount})`
						)
					);
				} else if (seen.has(i)) {
					issues.push(error('band-index-duplicate', at, `slot ${i} is overridden more than once`));
				}
				seen.add(i);
			});
		});
	}

	const overrides = slotOverrides(profile);
	const slotCount = profile.bandCount ?? 1;
	for (const f of SLOT_FIELDS) {
		const missing: number[] = [];
		for (let i = 0; i < slotCount; i++) {
			if (mergeSlotFields(profile.band, overrides.get(i)?.entry)[f] === undefined) missing.push(i);
		}
		if (missing.length === 0) continue;
		const which =
			profile.bandCount === null
				? 'the template'
				: missing.length === slotCount
					? 'every slot'
					: `slot${missing.length > 1 ? 's' : ''} ${formatIndices(missing)}`;
		issues.push(
			error(
				'slot-incomplete',
				'/band',
				`${which} has no "${f}"; define it in band, or in bands[] for those slots`
			)
		);
	}
	return issues;
}

function formatIndices(xs: number[]): string {
	const runs: string[] = [];
	for (let i = 0; i < xs.length;) {
		let j = i;
		while (j + 1 < xs.length && xs[j + 1] === (xs[j] as number) + 1) j++;
		runs.push(j > i ? `${xs[i]}–${xs[j]}` : `${xs[i]}`);
		i = j + 1;
	}
	return runs.join(', ');
}

// §6, §8 --------------------------------------------------------------------------------------

function checkDependencies(profile: Profile): Issue[] {
	const issues: Issue[] = [];
	const reported = new Set<string>();
	const report = (issue: Issue) => {
		const k = `${issue.code} ${issue.path} ${issue.message}`;
		if (!reported.has(k)) {
			reported.add(k);
			issues.push(issue);
		}
	};
	const overrides = slotOverrides(profile);
	for (let i = 0; i < (profile.bandCount ?? 1); i++) {
		const override = overrides.get(i);
		const slot = mergeSlotFields(profile.band, override?.entry);
		const variantsPath =
			override?.entry.variants !== undefined ? `${override.path}/variants` : '/band/variants';
		const edges: [Field, Field][] = [];
		(slot.variants ?? []).forEach((v, j) => {
			for (const a of variantReads(v)) {
				for (const f of variantDefines(v)) {
					if (a === f) {
						report(
							error(
								'variant-self-reference',
								`${variantsPath}/${j}`,
								`the variant defines "${f}" and also tests it in "when"`
							)
						);
					} else {
						edges.push([a, f]);
					}
				}
			}
		});
		const cycle = findCycle(edges);
		if (cycle) {
			report(
				error(
					'dependency-cycle',
					variantsPath,
					`fields depend on each other in a cycle: ${cycle.join(' → ')} (variants must be acyclic)`
				)
			);
		}
	}
	return issues;
}

// §3 ------------------------------------------------------------------------------------------

function checkMatch(profile: Profile): Issue[] {
	const fw = profile.match?.firmware;
	if (fw?.min !== undefined && fw.max !== undefined && compareFirmware(fw.min, fw.max) >= 0) {
		return [
			error(
				'firmware-range-empty',
				'/match/firmware',
				`no firmware matches: min ${fw.min} is inclusive and max ${fw.max} exclusive`
			)
		];
	}
	return [];
}

// §10 -----------------------------------------------------------------------------------------

function checkEvidenceRef(source: Source, path: string): Issue[] {
	if (
		(source.kind === 'probe' || source.kind === 'measurement') &&
		!EVIDENCE_REF.test(source.ref)
	) {
		return [
			error(
				'evidence-ref-invalid',
				`${path}/ref`,
				`a ${source.kind} source points to its evidence file: evidence/<profile id>/<file>.json`
			)
		];
	}
	return [];
}

function checkMeta(profile: Profile): Issue[] {
	const { meta } = profile;
	const issues: Issue[] = [];
	meta.sources.forEach((s, k) => issues.push(...checkEvidenceRef(s, `/meta/sources/${k}`)));

	const counting = meta.sources.filter(isCountingSource);
	if (
		(meta.status === 'community-verified' || meta.status === 'maintainer-verified') &&
		counting.length === 0
	) {
		issues.push(
			error(
				'status-needs-evidence',
				'/meta/status',
				`${meta.status} needs a probe, vendor-docs, vendor-app or measurement source of its own (inherited sources don't count)`
			)
		);
	} else if (meta.status === 'maintainer-verified' && !counting.some((s) => s.by !== undefined)) {
		// Whether `by` is a maintainer is checked by the maintainer approving the merge (D28).
		issues.push(
			error(
				'status-needs-maintainer',
				'/meta/status',
				'maintainer-verified needs a counting source whose "by" names the maintainer who checked it'
			)
		);
	}
	if (meta.status === 'deprecated' && meta.replacedBy === profile.id) {
		issues.push(error('replaced-by-self', '/meta/replacedBy', 'a profile cannot replace itself'));
	}
	return issues;
}
