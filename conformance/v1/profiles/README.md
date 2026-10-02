# Format conformance fixtures

Fixtures for profile **validators** (SPEC §13.8). Engine vectors live one directory up. Everything
here is CC0-1.0.

## `examples/`

The SPEC §12 examples, completed into whole profiles. Every file in `examples/` is a valid
published profile, and together they form a valid database. `examples/source/` holds example F in
authoring form: flattened, it must produce a valid profile with no issues.

## `cases/`

One file per rule, or several when a rule has edge cases worth pinning down. A case is:

```jsonc
{
  "description": "What the case shows.",
  "spec": "§4",                             // the SPEC section it tests
  "maintainers": ["maintainer-a"],          // optional: handles listed in MAINTAINERS; default none
  "profile": { },                           // one of profile | profiles | files, see below
  "expect": [                               // issues the validator must report; [] = valid
    { "code": "domain-off-grid", "path": "/band/gain/min", "profileId": "device-a" }
  ]
}
```

Inputs:

- `profile`: an [RFC 7386](https://www.rfc-editor.org/rfc/rfc7386) merge patch over
  [`base.json`](base.json), a minimal valid hardware profile. The result is validated as a
  published profile: the profile schema first, then (if it passes) the semantic rules.
- `profiles`: merge patches over `base.json` making up a database. Each must pass on its own, then
  the cross-profile rules run (unique ids, `replacedBy` targets, match collisions).
- `files`: complete authoring files, validated as CI validates `data/`: the source schema, then
  `extends` flattening, then the profile schema and the semantic rules on every non-abstract file,
  then the cross-profile rules. Used where a merge patch can't express the input (inheritance,
  `bandCount: null`).

Matching: `code` is an issue code from `ISSUE_CODES` in `packages/core`, or `schema` for a
structural failure. `path` is a JSON Pointer into the validated profile or file. `profileId`, when
given, must match too. A validator passes a case when it reports every expected issue and nothing
else. One exception: when a case expects a `schema` issue, extra `schema` issues are allowed,
because schema validators report a failed `oneOf` differently.

The reference runner is `packages/build/test/conformance.test.ts`. It also checks that every
issue code has at least one case that triggers it.
