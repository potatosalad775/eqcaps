/**
 * Every issue code with the rule it reports. `schema` comes from structural (JSON Schema)
 * validation; every other code is a semantic rule from docs/SPEC.md.
 */
export const ISSUE_CODES = {
	schema: 'Structural: the file fails profile.schema.json or source.schema.json.',
	'domain-bounds-order': '§4: a range has min > max.',
	'domain-off-grid': "§4: a stepped range's min or max is not on its grid.",
	'domain-values-order': '§4: set values are not strictly ascending (duplicates included).',
	'domain-not-positive': '§4: a freq or q domain allows a value ≤ 0.',
	'bands-unbounded': '§5.2: bands[] overrides on an unbounded (bandCount: null) profile.',
	'band-index-out-of-range': '§5.2: an override index is ≥ bandCount.',
	'band-index-duplicate': '§5.2: a slot is overridden more than once.',
	'slot-incomplete': '§2, §5: after merging, a slot lacks types, freq, q or gain.',
	'variant-self-reference': "§6: a variant's `when` references a field the variant defines.",
	'dependency-cycle': '§6: variant dependencies form a cycle.',
	'firmware-range-empty': '§3: match.firmware has min ≥ max, so no firmware matches.',
	'status-needs-evidence': '§10: a verified status without a counting source.',
	'status-needs-maintainer':
		'§10: maintainer-verified without a counting source whose `by` names who checked it.',
	'evidence-ref-invalid':
		'§10: a probe or measurement source whose ref is not an evidence file path.',
	'replaced-by-self': '§10: a deprecated profile replaced by itself.',
	'extends-missing': '§11: `extends` names a file that does not exist.',
	'extends-cycle': '§11: an `extends` chain loops.',
	'extends-too-deep': '§11: an `extends` chain is deeper than 4.',
	'duplicate-id': '§2: two files share an id.',
	'replaced-by-missing': '§10: replacedBy names a profile that does not exist.',
	'match-collision':
		'§3: two non-deprecated profiles with the same engine label share a match entry and overlapping firmware ranges.'
} as const;

export type IssueCode = keyof typeof ISSUE_CODES;

export interface Issue {
	code: IssueCode;
	severity: 'error' | 'warning';
	/** JSON Pointer into the profile (or authoring file) the issue is about. */
	path: string;
	message: string;
	/** Set by multi-profile checks (flattening, database). */
	profileId?: string;
}

export function error(code: IssueCode, path: string, message: string): Issue {
	return { code, severity: 'error', path, message };
}
