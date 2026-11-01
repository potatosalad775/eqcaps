# eqcaps: agent rules

A vendor-neutral database of EQ constraint profiles (what each hardware DSP or software EQ
accepts), with the engine, client, device bridge and inspector around it. Format v1 is frozen and
served under `/v1/`; `core`, `client` and `device-bridge` are on npm; uniPEQ (`../uniPEQ`) is the
first app on them. How the parts fit: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Commands

- `npm run lint` (`npm run format` fixes, data files included) · `npm run check` (generated files,
  vectors, typecheck) · `npm test` · `npm run build`. Run lint, check and test before a commit;
  `npm run data:validate` too after touching `data/`.
- `npm run codegen` after editing `schema/v1/profile.schema.json`; `npm run conformance` after
  changing engine behaviour.
- `npm run data:build` writes `dist/site/v1/`; `npm run inspector:dev` serves it (build first).
- `npm run release -- <version> --pack` puts tarballs in `dist/pack/` for trying in uniPEQ. A real
  release is the owner's, run locally for npm 2FA.

## Sources of truth, in order

1. **The vendor's own app** (web, Android, desktop): what a handler sends (frames, order, commits,
   saves, delays) and what the data says (ranges, types, presets, controls). Follow it, and change
   the handler when it disagrees, without waiting for a recording (D50).
2. **Recorded device answers**: `packages/device-bridge/test/captures/` and `test/recordings/`.
3. **devicePEQ `0617f38`**, only where no vendor app is known. Note where it differs.

Deviate from the vendor app only where it is plainly broken, and say so in the profile's notes.
To read a vendor app, use the `read-vendor-app` skill.

## Always

- Define the format only in [docs/SPEC.md](docs/SPEC.md). A format change is an additive minor
  (SPEC §15) with a DECISIONS entry, or it waits for v2.
- Change a decision by editing its DECISIONS entry with a dated note, SPEC in the same change; a
  new one takes the next free number. Changing an invariant (ARCHITECTURE §6) needs one.
- Give every semantic validation rule an issue code in `packages/core/src/issues.ts` and a case in
  `conformance/v1/profiles/cases/` that triggers it.
- Profiles: `data/profiles/<brandSlug(brand)>/<id>.json`, abstract bases in `data/bases/`, each
  file starting with `"$schema"`. Ids are permanent: rename = `deprecated` + `replacedBy`.
- Write the value the device is told, in Hz, dB and RBJ Q, unit conversions folded in. A
  conversion the vendor app makes on the way to the device is a `protocol` option (D39).
- Put a reported firmware quirk in `meta.notes` as a warning; never correct for it (D39).
- Cite every claim in `meta.sources`; inherited sources never count toward `status` (SPEC §10).
- USB ids are lowercase 4-digit hex (`"0x2972"`); `productName` matches exactly, trailing spaces
  included; a match field takes a list rather than one entry per combination (D43).
- A device in a group gets its own profile extending the group's base, not the group (D37).
- Per-vendor behaviour of a shared handler goes in an option, so other brands keep theirs. A new
  option goes in `src/protocols.ts` `OPTIONS` and the bridge README; a new control in the
  handler's `controls` and the README.
- Release the bridge before publishing data that uses a new option or control: `main` deploys
  `/v1/` on every push, and an older bridge drops a protocol it can't read.
- Test the bridge against device answers and codec round trips, never devicePEQ's bytes.
- Put testable inspector logic in plain `.ts` under `apps/inspector/src/lib/`; keep routes thin.
- Workspace packages import each other by package name; relative imports carry `.ts`; scripts are
  `.ts` run by Node (`--conditions=eqcaps:source` where they need sources).
- Hand-wrap Markdown at 100 columns (it isn't run through Prettier). Cite decisions as `D39`,
  SPEC and INSPECTOR sections as `SPEC §9`; those numbers are stable.
- Record work in progress in `docs/plans/<effort>.md` and its README row.

## Never

- Copy vendor code, app bundles or reverse-engineered vendor material, nor anything from
  devicePEQ's `fiio-js-capture/`, `walkplayJS/`, `walkplayPreprocessor/walkplay.js`, `Q5K/`,
  `bluetooth_tools/`. Facts only, cited as sources (D25).
- Put app-specific things in profiles (measurement names, store ids, UI concepts), or bytes,
  frames, commands or wire grids: `protocol` only names a handler and its settings (D2, D42).
- Make `schema/`, `data/`, `core` or `client` depend on `device-bridge`; give `core` a dependency
  or environment types.
- Let a handler see browser APIs (only `src/transport.ts`), or match identities (the client does).
- Let a codec clamp, pad or convert: round onto the wire grid, else throw a `BridgeError` (D33).
- Call `push`, `setEnabled` or `writeControl` from the inspector (invariant 9, D40).
- Write `LSQ`/`HSQ` in a profile: types are Equalizer APO's `PK LSC HSC LPQ HPQ BP NO AP` (D22).
- Edit by hand: `schema/v1/source.schema.json`, `*.generated.ts`, `conformance/v1/*.json`.
- Edit `docs/history/`, or put developer detail in README.md (it is for users).
- Edit `../modernGraphTool`, `../devicePEQ` or `../uniPEQ` from a task in this repo.

## Where things live

- [docs/SPEC.md](docs/SPEC.md): the format and engine semantics. The only definition.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): parts, package boundaries, invariants, data flow,
  roadmap.
- [docs/DECISIONS.md](docs/DECISIONS.md): why each choice was made, by D-number.
- [docs/INSPECTOR.md](docs/INSPECTOR.md): the inspector; code cites its § numbers.
- [docs/plans/](docs/plans/): work in progress, one file per effort.
- [CONTRIBUTING.md](CONTRIBUTING.md): adding devices, evidence, the development setup.
- [packages/device-bridge/README.md](packages/device-bridge/README.md): handlers, options, controls.
- [tools/userscripts/](tools/userscripts/): the WebHID recorder for vendor web apps.
- `../devicePEQ` (0BSD, fallback reference), `../modernGraphTool` (older bridge),
  `../uniPEQ` (the first app): local clones, read only.
