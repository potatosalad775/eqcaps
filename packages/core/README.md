# @potatosalad775/eqcaps-core

Types, semantic validator and reference engine for
[eqcaps](https://github.com/potatosalad775/eqcaps) EQ constraint profiles: which filter
configurations an EQ engine (a hardware DSP or a software EQ) accepts. Zero dependencies, no
environment types, synchronous.

- **Engine** (format SPEC §13): `resolveSlot`, `project`, `toRealized`, `toWritten`, `validate`,
  `validateList`, `assign`, `fit`, `complete`, plus `isGraphic`, `describe` and `unsupported`.
- **Validation**: `validateProfile` (semantic rules of one profile), `checkDatabase`
  (cross-profile rules), `flattenProfile` (authoring `extends` → published form).
- **Types** generated from the JSON Schema, including the published `index.json` and
  `bundle.json`.

Writing to a device: `fit` → `complete` → encode the written values. Reading from one: decode →
`toRealized`. While editing: `validateList`.

To load profiles, use [`@potatosalad775/eqcaps-client`](https://www.npmjs.com/package/@potatosalad775/eqcaps-client).
The format definition is
[docs/SPEC.md](https://github.com/potatosalad775/eqcaps/blob/main/docs/SPEC.md) (v1, frozen).

License: MIT.
