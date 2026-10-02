# Contributing to eqcaps

Thanks for helping. Most contributions are **device data**: a new profile, or a correction to one.
Code and format changes are welcome too.

## Licensing of contributions

By opening a pull request you agree that:

- what you contribute to `data/`, `schema/` and `conformance/` is dedicated to the public domain
  under [CC0 1.0](LICENSE-DATA), like everything already there;
- code you contribute (`packages/`, `apps/`, `scripts/`) is licensed under [MIT](LICENSE).

Don't submit material you can't license that way. Copied vendor code, vendor apps' bundles and
reverse-engineered vendor material are out. Facts are fine: a band count or a gain range you
learned from a vendor app can go into a profile, with a source that says where it came from.

## Adding or fixing a device

The format is defined in [docs/SPEC-DRAFT.md](docs/SPEC-DRAFT.md). In short:

1. One file per EQ engine: `data/profiles/<brand>/<id>.json`, where `<brand>` is the brand in
   lowercase with dashes (`jds-labs`) and `<id>` is `<brand>-<model>` (`jds-labs-element-iv`).
   Ids are permanent. To rename, deprecate the old profile with `replacedBy`.
2. Start the file with `"$schema": "../../../schema/v1/source.schema.json"`, so your editor
   validates and autocompletes as you type.
3. Write the values the engine **takes**, in Hz, dB and RBJ-cookbook Q. Fold in any conversion
   that depends only on the value (register units, octaves → Q, a constant frequency factor).
   Deviations that depend on another field are `realization` laws (SPEC §8).
4. Say where every claim comes from in `meta.sources`, and pick the `meta.status` your evidence
   supports (SPEC §10):
   - `draft`: no evidence beyond handler code or a report;
   - `community-verified`: you supplied counting evidence (a probe file, vendor docs, a vendor-app
     capture or a measurement);
   - `maintainer-verified`: a maintainer checked it on their own hardware or against vendor docs.
5. Put probe or measurement files in `data/evidence/<id>/`. Remove anything personal first:
   Bluetooth names people gave their devices, serial numbers, MAC addresses.

Devices that share a chip can share a base in `data/bases/` through `extends` (SPEC §11).

Most profiles were seeded from devicePEQ, modernGraphTool and AutoEQ by
[`scripts/import/seed.ts`](scripts/import/seed.ts) and are `draft`. Their notes say what is known
to be uncertain. Checking one against your device is one of the most useful things you can do.

## Adding a device to the bridge

If an existing protocol already drives your device, give the device a profile (its `match` is how
apps recognize it), then add an entry for the profile id to
[`packages/device-bridge/src/protocols.ts`](packages/device-bridge/src/protocols.ts) with the
handler and its protocol settings. Constraints (bands, ranges, types) go in the profile, never in
the protocol entry; the tests check that the profile only allows what the protocol can write. A
recorded exchange with the device in `packages/device-bridge/test/captures/` makes it a regression
test. New protocols need a handler, a codec and a session: see the existing ones and
[DECISIONS D33](docs/DECISIONS.md).

## Checking your change

Requires Node 22.18 or later.

```sh
npm install
npm run data:validate   # layout, schema, semantic and cross-profile rules
npm run lint            # formatting (run `npm run format` to fix)
npm test
```

CI runs the same checks on every pull request and marks each problem on its line in the diff.

## Review

Every merge needs one maintainer's approval. The reviewer checks your evidence against the status
you chose. Changes to `schema/`, `docs/SPEC-DRAFT.md`, `packages/core/` and `.github/` also need
a code owner. Decisions behind the format are in [docs/DECISIONS.md](docs/DECISIONS.md); a
change to one needs a new or amended entry there.

Not sure how to describe a device? Open a [new device issue](../../issues/new/choose) with what you
know, and we'll work it out together.
