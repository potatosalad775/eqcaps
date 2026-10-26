# Plan

> **Archived 2026-10-26.** The build-out plan and phase log (Phases 0–5, 2026-10-02 to
> 2026-10-04). What is still true is in [../ARCHITECTURE.md](../ARCHITECTURE.md).

## 1. Goal

A shared, vendor-neutral system that answers one question for any EQ app:

> *Which filter configurations does this EQ engine (a hardware DSP or a software EQ) actually
> accept?*

It covers band count, filter types per slot, frequency/Q/gain domains including quantization and
value sets, conditional domains, cross-band rules, preamp, device identity and provenance. It
consists of:

1. **A format**: [SPEC.md](../SPEC.md), JSON Schema, conformance vectors.
2. **A database**: community-maintained profiles, CI-validated, published as static JSON.
3. **A reference engine**: resolve / validate / fit / assign / complete, in TypeScript, portable
   by spec.
4. **An inspector web app**: browse, connect a device, read, guided reads, author, submit.
   See [INSPECTOR.md](../INSPECTOR.md).

Non-goals (v1): per-channel (L/R) EQ, protocol sharing for non-JS platforms, coefficient
quantization and bridge-computed biquads, a submission backend, non-EQ device features (DAC
filters, mic gain…).

## 2. Consumers

| Consumer | Uses | Needs from us |
| --- | --- | --- |
| modernGraphTool (browser) | client + core, npm or CDN; later device-bridge | lazy fetch, match by connected device, fit before push, per-slot UI hints |
| Android hardware PEQ app (uniPEQ: SvelteKit + Capacitor, USB) | core + client + device-bridge from npm, `bundle.json` snapshot + periodic refresh, native USB transport plugin of its own | transport-agnostic bridge, offline bundle, stable ids, matching by USB identity (D27) |
| devicePEQ, AutoEQ, others | data and schema, if they choose to (no outreach planned, D26) | neutral format, CC0 data, software targets |
| Contributors | inspector | read, guided read, author, one-click PR |

## 3. System overview

```
             contributors                                   consumers
                  │                                             ▲
   ┌──────────────▼──────────────┐   PR    ┌──────────────────┐ │ fetch (CORS, static)
   │ Inspector (static SPA)      │────────▶│ GitHub repo      │ │
   │  T0 browse  T1 identify     │         │  data/  schema/  │ │
   │  T2 read    T3 guided read  │         │  evidence/       │ │
   │  T4 author/submit           │         └────────┬─────────┘ │
   │   uses: core, client,       │                  │ CI: validate, collisions,
   │         device-bridge       │                  │     conformance, build
   └─────────────────────────────┘                  ▼           │
                  ▲                       ┌──────────────────────┴─┐
                  └───── same origin ─────│ GitHub Pages            │──▶ npm (+ jsDelivr)
                                          │  /          inspector   │──▶ GitHub Release bundle
                                          │  /v1/ data              │
                                          └─────────────────────────┘
```

## 4. Repository layout (target)

```
eqcaps/
├── CLAUDE.md                     project guide for agents
├── docs/                         PLAN, SPEC, INSPECTOR, DECISIONS, research/
├── schema/v1/
│   ├── profile.schema.json       published (flat) profiles
│   └── source.schema.json        authoring files (adds extends / abstract)
├── data/
│   ├── profiles/<brand>/<id>.json
│   ├── bases/<id>.json           abstract chip-family bases
│   └── evidence/<id>/<date>-<hash>.json
├── conformance/v1/
│   ├── *.json                    engine test vectors (generated + hand-written)
│   └── profiles/                 format fixtures: SPEC examples + cases per validation rule
├── packages/
│   ├── core/                     types, semantic validator, engine (zero deps, sync)
│   ├── client/                   fetch/cache index, profiles, bundle; matchDevice()
│   ├── build/                    structural validation (Ajv), the validation pipeline, publishing
│   │                             (flatten, index, bundle, hashes) and the data CLI
│   ├── device-bridge/            codecs, sessions, profiles' protocols checked, transport interface and
│   │                             browser transports (WebHID/Web Serial/Web Bluetooth); from devicePEQ (D20, D33)
│   └── kotlin/                   (not scheduled, D15) Kotlin port of core
├── apps/inspector/               Svelte 5 + Vite static SPA
├── scripts/
│   ├── codegen.ts                source.schema.json + TS types from profile.schema.json (D13)
│   ├── conformance.ts            engine vectors in conformance/v1/
│   ├── release.ts                npm packages, tag and GitHub Release (D32)
│   └── sample-consumer.ts        fetch, match and fit against the built data, as an app would
├── LICENSE                       MIT: packages/, apps/, scripts/
├── LICENSE-DATA                  CC0-1.0: data/, schema/, conformance/ and all published JSON (D25)
├── THIRD-PARTY-NOTICES.md        devicePEQ (0BSD), modernGraphTool (MIT), AutoEQ (MIT)
└── .github/                      workflows, CODEOWNERS, PR template, issue forms
```

Dependency direction: `core` ← `client`, `build`, `inspector`; `device-bridge` ← `inspector` here,
plus external apps (modernGraphTool, the Android app). **Nothing in `schema/`, `data/`, `core` or
`client` may depend on `device-bridge`** (D2).

## 5. Roadmap

Sizes are rough focused-effort estimates for one developer. Each phase lists the exit criteria
that must hold before the next phase relies on it.

### Phase 0: Bootstrap · S (1–2 days) · done 2026-10-02
- `git init`, npm workspaces, TS strict, Vitest, Prettier, ESLint, CI (lint, typecheck, test).
- `LICENSE` (MIT), `LICENSE-DATA` (CC0-1.0), `THIRD-PARTY-NOTICES.md` (D25); README stub;
  CODEOWNERS (D28).
- Create `potatosalad775/eqcaps` on GitHub and enable Pages (D24).
- **Exit:** CI green on empty packages.

The repo is private for now. Pages and branch protection need it public (or GitHub Pro), so both
move to Phase 3, where the `/next/` deploy and outside PRs first need them.

### Phase 1: Format as code · M (1–2 weeks) · done 2026-10-02
- `schema/v1/*.schema.json` written from SPEC §2–§11.
- `packages/core`: generated types, `validateProfile()` semantic validator (merged slots complete,
  on-grid bounds, acyclic variants and realization laws, status gating per SPEC §10, `extends`
  resolution for source files).
- Fixtures: SPEC examples A–H (valid), plus an invalid fixture **per semantic rule**.
- **Exit:** every MUST in SPEC §3–§11 has a failing fixture; examples validate; `$schema` gives
  autocompletion and errors in VS Code.

### Phase 2: Reference engine and conformance · M (≈2 weeks) · done 2026-10-02
- `core`: `resolveSlot`, `project`, `toRealized`, `toWritten`, `validate`, `validateList`,
  `assign`, `fit`, `complete`, `isGraphic`, `describe` (human-readable summaries for UIs).
- Property tests (fast-check) over random profiles and filter lists: soundness, faithfulness on
  valid input, idempotence, no added bands, and `toWritten`∘`toRealized` = identity.
- `conformance/v1/` vectors: exact ops + property ops (SPEC §13.8).
- *2026-10-03:* realization laws, `toRealized` and `toWritten` were removed from the format before
  v1 was first published (D39).
- **Exit:** properties hold over ≥ 10k generated cases; vectors checked in; SPEC §13 updated with
  anything implementation forced us to clarify.

Every property runs on 10k random profiles in `npm test` and passed at 100k
(`EQCAPS_PROPERTY_RUNS=100000`). Vectors for all eight ops are in `conformance/v1/`, generated by
`scripts/conformance.ts`. What the implementation settled is recorded in D30 and SPEC §6–§8 and
§13, including a new *safe* property of `fit` and `complete` returning warnings.

### Phase 3: Data pipeline, seed data, `/next/` · M (≈2 weeks) · done 2026-10-02
- `packages/build` + CLI: `validate`, `build` (flatten, index, bundle, sha256), `check-collisions`.
- `scripts/import/`: devicePEQ registry + device configs, modernGraphTool registrations, AutoEQ
  `PEQ_CONFIGS` → `draft` profiles, enriched with wire grids from
  [research/prior-art.md §2](../research/prior-art.md#2-what-the-device-handlers-actually-encode).
  Records the upstream commit it read (D26), maps devicePEQ's `peqConstraintsRef` /
  `peqConstraintsOverride` to bases + `extends`, maps filter codes (D22), turns compensation
  settings into `realization` blocks (D29), and reads only devicePEQ's own 0BSD files (D25).
- `packages/client`: `loadIndex()`, `loadProfile()`, `loadBundle()`, TTL + ETag cache (pluggable
  storage), `matchDevice(identity)` with specificity. Failure contributes zero profiles and never
  throws into the host app.
- CI on PRs: format check, schema + semantic validation, collisions, build. On `main`: deploy
  `/next/` to Pages.
- Make the repo public, enable Pages, and protect `main` (one maintainer approval, D28).
- `CONTRIBUTING.md` and PR template, both stating the inbound licenses (D25); issue forms ("new
  device", "wrong constraint").
- Publish `core` and `client` to npm on tagged releases (D18). The Android app and modernGraphTool
  consume them from there.
- **Exit:** `/next/index.json` is live with all importable devices as drafts; a malformed PR fails
  CI with a readable message; a 20-line sample consumer fetches, matches and validates.

Built: the build CLI (`npm run data:validate`, `npm run data:build`), the seed import (98 draft
profiles, 15 bases; what was taken and skipped is in D31), the client (D32), CI data validation
with line annotations, the Pages deploy, the local release script (`npm run release`),
`CONTRIBUTING.md`, the PR template and issue forms. `scripts/sample-consumer.ts` fetches, matches,
validates and fits, and a test runs it against the built data. The repository is public, `/next/`
is live on Pages, and `main` is protected (one approval, CI required, D28). `core` and `client`
0.1.0 are on npm.

### Phase 4: Inspector v1 (T0, T1, T2, T4) and spec freeze · L (3–4 weeks) · done 2026-10-03
- `packages/device-bridge`: extract from modernGraphTool, keep behaviour, add identity extraction,
  "any device" connect, capability flags, `profileId` linkage for migrated handlers.
  - Define the transport interface with no browser types in handlers, so the Android app can plug
    in a native USB transport (D27).
  - Catch up with upstream devicePEQ at a pinned commit: the Conexant handler, and its recorded
    device captures as codec regression tests. Codecs apply only constant wire factors;
    upstream's compensation code is replaced by profile `realization` (D20, D29).
  - Publish to npm.
- `apps/inspector`: search, profile view with per-slot chart, playground, connect/identify,
  descriptor dump, read + validate, editor, prefilled PR/issue submission, PII review on export.
- Hand-author ≥ 10 profiles at `community-verified` or better (vendor-app / docs evidence),
  including each hard case: type-partitioned (JDS), value set (Edifier-like), stepped, graphic,
  frequency-partitioned, conditional.
- **Exit:** a real HID device goes connect → matched profile → read → validate → prefilled PR,
  end to end. **Freeze format v1** and publish `/v1/` alongside `/next/`.

The device bridge is built (D33): 16 protocols from devicePEQ `0617f38`, each a pure codec
(request ↔ frames, plus the wire grid it can carry) and a session that does the I/O, behind
transports without browser types, with WebHID, Web Serial and Web Bluetooth implementations.
Profiles carry their protocol (handler and per-device settings, D42), so the client's
`matchDevice` is the only identity answer and a device on a known protocol needs no bridge
release; devices without a profile get a vendor guess marked experimental. Tests decode the recorded device
answers, round-trip every codec on its wire grid, check every hardware profile against its codec,
and run the consumer recipe (`fit` → `complete` → push) for every profile. They corrected three
seeded profiles and found two codec bugs; the open data findings are listed in D33.

The inspector is started (D34): search with feature filters, the profile view with its per-slot
chart, the playground (`validateList`, `fit` as a diff, `complete`), and the connect page (T1
identity, HID descriptor dump, matching, T2 read and validate, prefilled issues). It deploys at `/`
beside `/next/`. Left: publish the bridge, confirm connect → read on real hardware, the editor and
PR submission (T4), the evidence export with its PII review, the hand-authored profiles, and the
freeze.

*2026-10-03:* the editor and submission (T4), the evidence export with its PII review and `/docs`
are built (D35). Connect → match → read → validate → prefilled PR runs end to end in the
inspector; it was exercised against a fake WebHID device replaying the KT Micro Chu 2 capture
(only read commands were sent, and the Q 7 finding arrived in the editor), not yet on real
hardware. `npm run release -- <version> --pack` writes tarballs of `core`, `client` and the
bridge to `dist/pack/` for trying them in another app before publishing. The first hand-authored
profiles are in: RME ADI-2 DAC FS (PEQ, type- and frequency-partitioned) and its Bass/Treble
engine (stepped), written from RME's manual. They are `draft` until someone reviews them or tries
them on a device. Left for the exit: publish the bridge, the real-hardware run, ten verified
profiles covering every hard case (these need vendor apps or the devices themselves), and the
freeze.

*2026-10-03, later:* **format v1 is frozen** (D36), by the owner's decision, with the exit
criteria waived in part: no verified profiles rather than ten, and real devices identified and
read (Walkplay units) but the full flow only on a replayed capture. `/v1/` is built beside
`/next/`, and the client and inspector default to it. The Qudelix 5K is write-only over USB (D33),
so the inspector, which only reads, identifies it and says so; its profile now also matches the
`0x4007` identity a maintainer's unit reports. Group profiles are marked (`device.group`, D37), and
a device matched only by a group can be added as its own profile from Connect, driven by the
group's protocol (D33), with no code change.

### Phase 5: Guided reads (T3) · M (≈1–2 weeks) · done 2026-10-03 (replaces probe mode, D40)
The inspector never writes to a device. A guided read asks the user to change the EQ in the
vendor's own app, one step at a time, and reads the device back after each step; what the app let
them set becomes `vendor-app` evidence. Design: INSPECTOR §3.

Decided (DECISIONS D41, 2026-10-03):
- **Citation:** a `vendor-app` source whose `ref` is the evidence file. The evidence-ref rule
  (SPEC §10) covers every `ref` that starts with `evidence/`, in format 1.0.
- **Evidence file:** the T2 file plus `vendorApp`, one experiment per step (instruction, the full
  read-back, what changed, the conclusion), `constraints` and `notChecked` (INSPECTOR §6).
- **Sharing:** Walkplay's web app and the inspector held a Protocol Micro at once, in either
  order (INSPECTOR §3.4). The page keeps its connection and still supports reconnecting a granted
  device for a phone or desktop vendor app.

Build:
- `src/lib/guided/` (plain TS, tested by the root Vitest run, D34): the step planner (what's
  still unknown, first band then last band, every band only when they differ), inference from
  reads (bounds, steps by difference and GCD, type codes), change detection between reads, and
  the evidence writer. Tests feed it scripted read sequences, including a user who skips a step,
  forgets to save, or sets the wrong band.
- `GuidedRead.svelte` on `/connect`, offered after a read: the hearing notice, one step at a
  time with a Read button, skip and redo, a final "put your EQ back" step checked against the
  first read, then the evidence review and **Use in a profile**.
- Editor handoff: the findings as constraints (as the probe handoff did, removed in D40), the
  evidence cited per the decision above, unasked fields from the matched profile or the wire
  limits (`handler-code`), and notes for what wasn't checked.
- Docs: INSPECTOR §3 and §6 updated to what was built, SPEC §10 if the format changes, a
  DECISIONS entry.

**Exit:** a guided read of a real Walkplay unit with its vendor app produces a profile whose
domains match the app's UI limits, cited as evidence that CI accepts; no code path in the
inspector calls the bridge's `push` or `setEnabled` (a test checks the imports).

*2026-10-03:* this phase was probe mode (D38): an engine that wrote test values and read back what
the device kept. It was built and tested against virtual devices, then removed the same day (D40).
On a CrinEar Protocol Micro, band-count writes past its 8 bands corrupted its stored EQ, and the
restore, written at the wrong size, didn't repair it. Walkplay firmware also stores whatever it
is sent, so probes there couldn't learn ranges anyway.

*2026-10-04:* done. The exit is met by the owner's guided read of a CrinEar Protocol Micro in
Walkplay's web app (`data/evidence/crinear-protocol-micro/`, cited by its profile as
`vendor-app`), and `no-writes.test.ts` checks the inspector's imports. A second guided read
produced the EarAcoustic OSHUN DECO profile. Only the shared web-tab case (INSPECTOR §3.4) has run
on hardware; reconnecting for a phone or desktop vendor app is built but not yet tried (§7).

### Phase 6: Consumers (parallel once Phases 2–3 land)
- **modernGraphTool** (the original draft's M3/M5/M6, done in that repo): replace
  `EqConstraintPreset` with core types; load via client; re-enable the picker with visible badge +
  one-click "unlimited"; per-slot hints; "Fit to device"; `fit` + `complete` before push;
  AutoEQ optimizing within per-slot domains; device-peq compensation removed (D39);
  `deriveDeviceConstraint()` replaced by `matchDevice()`.
- **Android hardware PEQ app** (its own repo, D27): `core` + `client` + `device-bridge` from npm,
  a native USB transport plugin, an embedded `bundle.json`, `fit` + `complete` before push.
  Consumer guide for embedding.
- Kotlin port: not scheduled (D15).

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Format frozen before real-world use reveals gaps | Frozen 2026-10-03 with the verified-profiles gate waived by the owner (D36); gaps arrive as additive minors (SPEC §15) or wait for v2 |
| Few contributions | Seed import makes the DB useful on day one; the inspector makes contributing a guided flow; "draft" lowers the bar |
| A guided read harms hearing or hardware | The inspector never writes (D40): the user sets values in the vendor app, a hearing notice comes first, and a final read confirms the EQ is back as it was (INSPECTOR §3.5) |
| Bridge drifts between modernGraphTool and this repo during extraction | Moving is decided (D20): freeze device-peq changes in modernGraphTool or sync with a script until it consumes the package; take upstream devicePEQ changes at one pinned commit |
| Upstream devicePEQ keeps changing after the seed import | The seed and the bridge come from one pinned commit, `0617f38` (D31, D33); review upstream diffs by hand now and then (D26) |
| Wrong data writes bad EQ to devices | Consumers always run `fit` on the hard path; `status` visible; device firmware usually clamps anyway; "wrong constraint" issue form |
| Public ids/URLs churn | Home fixed under the owner's account (D24); custom domain before any move; ids permanent, with `deprecated` + `replacedBy` |
| Device tiers are Chromium-only | T0/T4 work everywhere; the UI explains instead of hiding |
| Android USB access (WebView has no WebHID, Web Serial or WebUSB) | Native plugin stays protocol-free and lives in the app repo; codecs never touch browser APIs (D27). A Kotlin device bridge remains out of scope. |
| A device's filters sound different from the values it's told | Out of scope (D39): devices get the values the user asks for, as vendor apps send them; reported quirks are warnings in `meta.notes` |

## 7. Immediate next steps

1. A guided read with a phone or desktop vendor app (INSPECTOR §3.4): the page reconnects to a
   granted device for each step, which hasn't run on hardware yet.
2. Next session: a profile for the PureAural (its own device, not a Walkplay variant), and for both
   it and the OSHUN DECO the protocol differences their vendor apps showed (D33 note) as protocol
   options, with the captures as tests. The OSHUN DECO profile is in (2026-10-04, from a guided
   read), with ranges from Walkplay's web app; whether its bands 11–16 do anything needs a
   measurement.
3. Publish the data package `@potatosalad775/eqcaps` (D32): decide its contents (the `/v1/` files)
   and add it to the release script.
4. Carried from Phase 4: verified profiles, with every hard case among them. Guided reads
   (`vendor-app` evidence) are the way in for devices with read-back.
   The two RME drafts are the nearest by documents: their notes list what to check (shelf
   direction, frequency grid, Q step, the older ADI-2 DAC).
5. Qudelix 5K: the USB handler can't read (D33), and devicePEQ's writes are reported unstable.
   A capture of the vendor app's USB traffic, made by the owner, would show whether the device
   answers reads and what a reliable write looks like. Until then it can't be read.
6. Shrink the group profiles: as devices are identified, give them device profiles with their
   real (vendor id, product id) and drop pairs from the groups. Q11 is answered (D43): lists made
   the index 6× smaller but still claim pairs that don't exist.
