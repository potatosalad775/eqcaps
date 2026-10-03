# eqcaps

A vendor-neutral database of **EQ constraint profiles**. Each profile says what an EQ engine (a
hardware DSP or a software EQ) actually accepts: band count, filter types per slot,
frequency/Q/gain domains with quantization, conditional domains, cross-band rules, preamp, device
identity and provenance. The repo also holds the tooling to author, verify, validate and publish
profiles for any EQ app: modernGraphTool, an Android hardware PEQ app (Capacitor), and anyone else
who adopts the format.

**Status: Phases 0–4 done; format v1 frozen 2026-10-03 (D36), published under `/v1/` beside
`/next/`. `core` and `client` 0.1.0 on npm; the bridge and 0.2.0 are next (PLAN §7). Phase 5 is
guided reads (planned, INSPECTOR §3); the probe was removed (D40).** Read `docs/PLAN.md` first.

Commands: `npm run lint` · `npm run check` (codegen and vector drift + typecheck) · `npm test` ·
`npm run build` · `npm run codegen` after editing `schema/v1/profile.schema.json` ·
`npm run conformance` after changing engine behaviour · `npm run data:validate` · `npm run data:build`
(writes `dist/site/v1/` and `next/`) · `npm run inspector:dev` (serves the local `dist/site/v1/`; run
`data:build` first) · `npm run release -- <version>` (owner only, run locally for npm 2FA) · `npm run release --
<version> --pack` (tarballs in `dist/pack/`, to try the packages in another app).
Never edit `schema/v1/source.schema.json`,
`*.generated.ts` or `conformance/v1/*.json` (engine vectors) by hand.

## Docs

| File | Contents |
| --- | --- |
| `docs/PLAN.md` | goal, consumers, architecture, repo layout, phased roadmap with exit criteria, risks |
| `docs/SPEC.md` | **the** format definition (v1, frozen) and engine semantics. Single source of truth. |
| `docs/INSPECTOR.md` | inspector web app: capability tiers, device probing methodology, safety, privacy |
| `docs/DECISIONS.md` | every design decision with rationale, review of the original concept draft, **open questions for the owner** |
| `docs/research/prior-art.md` | evidence: existing constraint models + what real device handlers encode |

When a decision changes, edit its entry in DECISIONS.md with a dated note, and update SPEC.md
in the same change. v1 is frozen: a format change must be an additive minor (SPEC §15) or wait
for v2. Don't define format details anywhere except SPEC.md.

## Invariants (changing one needs a DECISIONS entry)

1. **Vendor-neutral format.** Nothing app-specific in profiles: no measurement names, no
   modernGraphTool store ids, no UI concepts.
2. **Constraint data ≠ wire format.** Profiles say which values are accepted, never how bytes
   are laid out on the wire (frames, commands, scheme numbers, wire grids): that is the handlers'
   code in `packages/device-bridge`. A profile's `protocol` only selects a bridge handler and its
   per-device settings (D42); the engine never reads it. `schema/`, `data/`, `core` and `client`
   never depend on the bridge.
3. **Canonical units, written values:** Hz, dB, RBJ-cookbook Q. Domains describe the values the
   engine is told; authors fold in unit conversions (register value → dB, octaves → Q). How the
   engine's filters sound is out of scope: nothing models or corrects firmware quirks (D39).
4. **Profile ids are permanent public API.** Rename = `deprecated` + `replacedBy`.
5. **Published files are flat.** `extends`/`abstract` exist only in authoring files and are resolved
   by the build.
6. **JSON Schema is the structural source of truth.** TS types are generated from it. Rules JSON
   Schema can't express live in the semantic validator and are written down in SPEC.
7. `project` / `resolveSlot` / `validate` are exact and normative
   across languages; `assign` / `fit` / `complete` are normative only through their properties
   (SPEC §13).
8. **Consumers must work without the CDN.** The database enhances an app and never blocks it.
9. **The inspector never writes to a device** (D40): it calls the bridge's `pull`, never `push` or
   `setEnabled`. Writing is for apps, through `fit` + `complete`.

## Conventions

- npm workspaces · TypeScript strict · Vitest + fast-check · Ajv · Svelte 5 + Vite (inspector) ·
  Prettier + ESLint configured like modernGraphTool. Markdown is not run through Prettier (D21).
- Scripts are `.ts` files run directly by Node (type stripping, Node ≥ 22.18). Relative imports
  carry the `.ts` extension.
- `core` has zero dependencies and no environment types (no DOM, no Node). Ajv lives in `build`.
- Every semantic validation rule has an issue code in `ISSUE_CODES` (`packages/core/src/issues.ts`)
  and at least one case in `conformance/v1/profiles/cases/` that triggers it. A test enforces it.
- One JSON file per profile: `data/profiles/<brand>/<id>.json`, starting with `"$schema"` so editors
  validate it. `<brand>` is `brandSlug(device.brand)`. Abstract bases: `data/bases/<id>.json`.
- `data/` was seeded once by `scripts/import/seed.ts` (D31) and is now edited by hand. Don't re-run
  the importer over it.
- No calibration (D39): profiles hold the value the device is told, and nothing corrects firmware
  quirks (no factors folded into domains, no scaling in codecs). Put a reported quirk in
  `meta.notes` as a warning.
- Device bridge (D33): handlers see only the transport interfaces in `src/transport.ts`, never
  browser APIs (those are in `src/browser/`, typed structurally). Codecs write exactly the written
  values they're given: round onto the wire grid, never clamp, pad or convert types; anything the
  wire can't carry is a `BridgeError`. A handler is a pure codec (`encode`/`decode`/`wire`) plus a
  session that does the I/O. Which handler drives a device, with its options and presets, is the
  profile's `protocol` (D42), inherited from the base, so a device on a known protocol is a data
  file only; `src/protocols.ts` checks it against the handlers (`protocolOf`) and holds the
  vendor guesses for devices without a profile. Identities stay in profile `match` (the client
  matches, the bridge doesn't). A new handler option goes in that file's `OPTIONS` and the README.
  Protocols come from devicePEQ `0617f38`; test against device answers
  (`packages/device-bridge/test/captures/`) and codec round trips, not devicePEQ's bytes.
- Inspector (D34): SvelteKit SPA with adapter-static and Tailwind, never server-rendered. Logic
  that can be tested lives in plain `.ts` modules under `src/lib/` (tested by the root Vitest run);
  routes and components stay thin. Nothing in the inspector calls the bridge's `push` or
  `setEnabled` (invariant 9).
  The editor (D35) edits authoring files, read from the repository (`/data/` in dev, GitHub
  `main` in production), and checks them with `packages/build`, as CI does.
- Workspace packages import each other by package name. Node scripts that need sources run with
  `--conditions=eqcaps:source`; `scripts/*.ts` import sources by relative path.
- USB ids are lowercase 4-digit hex strings (`"0x2972"`). HID `productName` matches exactly,
  trailing spaces included. A match field takes a list rather than one entry per combination
  (D43).
- Name is **eqcaps** (D24): repo `potatosalad775/eqcaps`, Pages `potatosalad775.github.io/eqcaps`,
  npm `@potatosalad775/eqcaps` (data) and `@potatosalad775/eqcaps-{core,client,device-bridge}`.
  The local folder is still named `eqDeviceInfo`.
- Filter type codes are Equalizer APO's: `PK LSC HSC LPQ HPQ BP NO AP` (D22). modernGraphTool and
  devicePEQ write `LSQ`/`HSQ`; convert at the boundary, never in profiles.
- Licenses (D25): code MIT; `data/`, `schema/`, `conformance/` and all published JSON CC0-1.0.
- Status levels: `draft` · `community-verified` · `maintainer-verified` · `deprecated` (SPEC §10).

## Related code

- `../modernGraphTool` is the first consumer. Its `src/lib/device-peq/` is the older TS bridge
  (MIT) that `packages/device-bridge` replaces, and its `src/lib/types/eq-constraint.ts` the flat
  model this project replaces. Read it for reference; don't edit it from this repo's tasks.
- `../devicePEQ` is a local clone of `jeromeof/devicePEQ` (0BSD), upstream of that bridge. Seed data:
  `devicePEQ/peqConstraintsConfig.json` (36 shape-named profiles) + `devicePEQ/*DeviceConfig.js`.
  Also worth reading: `devicePEQ/compensation.js` (the quirks devicePEQ corrects; D39 says why we
  don't) and
  `tests/captures/` (recorded device exchanges). **Don't copy anything** from `fiio-js-capture/`,
  `walkplayJS/`, `walkplayPreprocessor/walkplay.js`, `Q5K/` or `bluetooth_tools/`. They are vendor
  code or reverse-engineered vendor material, not 0BSD (D25). No upstream coordination (D26).
- `jaakkopasanen/AutoEq` (MIT) `autoeq/constants.py` `PEQ_CONFIGS` holds per-filter app/device configs:
  one-off seed data for `kind: software` profiles. AutoEQ is no longer actively maintained.
