# Plan

## 1. Goal

A shared, vendor-neutral system that answers one question for any EQ app:

> *Which filter configurations does this EQ engine (a hardware DSP or a software EQ) actually
> accept?*

It covers band count, filter types per slot, frequency/Q/gain domains including quantization and
value sets, conditional domains, cross-band rules, preamp, device identity and provenance. It
consists of:

1. **A format**: [SPEC-DRAFT.md](SPEC-DRAFT.md), JSON Schema, conformance vectors.
2. **A database**: community-maintained profiles, CI-validated, published as static JSON.
3. **A reference engine**: resolve / validate / fit / assign / complete, plus written ↔ realized
   conversion, in TypeScript, portable by spec.
4. **An inspector web app**: browse, connect a device, read, probe, author, submit.
   See [INSPECTOR.md](INSPECTOR.md).

Non-goals (v1): per-channel (L/R) EQ, protocol sharing for non-JS platforms, coefficient
quantization and bridge-computed biquads, a submission backend, non-EQ device features (DAC
filters, mic gain…).

## 2. Consumers

| Consumer | Uses | Needs from us |
| --- | --- | --- |
| modernGraphTool (browser) | client + core, npm or CDN; later device-bridge | lazy fetch, match by connected device, fit before push, per-slot UI hints |
| Android hardware PEQ app (Ionic + Capacitor prototype, USB) | core + client + device-bridge from npm, `bundle.json` snapshot + periodic refresh, native USB transport plugin of its own | transport-agnostic bridge, offline bundle, stable ids, matching by USB identity (D27) |
| devicePEQ, AutoEQ, others | data and schema, if they choose to (no outreach planned, D26) | neutral format, CC0 data, software targets |
| Contributors | inspector | probe, author, one-click PR |

## 3. System overview

```
             contributors                                   consumers
                  │                                             ▲
   ┌──────────────▼──────────────┐   PR    ┌──────────────────┐ │ fetch (CORS, static)
   │ Inspector (static SPA)      │────────▶│ GitHub repo      │ │
   │  T0 browse  T1 identify     │         │  data/  schema/  │ │
   │  T2 read    T3 probe        │         │  evidence/       │ │
   │  T4 author/submit           │         └────────┬─────────┘ │
   │   uses: core, client,       │                  │ CI: validate, collisions,
   │         device-bridge       │                  │     conformance, build
   └─────────────────────────────┘                  ▼           │
                  ▲                       ┌──────────────────────┴─┐
                  └───── same origin ─────│ GitHub Pages            │──▶ npm (+ jsDelivr)
                                          │  /          inspector   │──▶ GitHub Release bundle
                                          │  /v1/ (/next/) data     │
                                          └─────────────────────────┘
```

## 4. Repository layout (target)

```
eqcaps/
├── CLAUDE.md                     project guide for agents
├── docs/                         PLAN, SPEC-DRAFT, INSPECTOR, DECISIONS, research/
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
│   ├── build/                    structural validation (Ajv) and the validation pipeline; later
│   │                             compile, index, bundle, hashes and the CI CLI
│   ├── device-bridge/            codecs, sessions, protocols by profile id, transport interface and
│   │                             browser transports (WebHID/Web Serial/Web Bluetooth); from devicePEQ (D20, D33)
│   └── kotlin/                   (not scheduled, D15) Kotlin port of core
├── apps/inspector/               Svelte 5 + Vite static SPA
├── scripts/
│   ├── codegen.ts                source.schema.json + TS types from profile.schema.json (D13)
│   └── import/                   one-off importers: seed data (devicePEQ, modernGraphTool, AutoEQ)
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
  [research/prior-art.md §2](research/prior-art.md#2-what-the-device-handlers-actually-encode).
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

### Phase 4: Inspector v1 (T0, T1, T2, T4) and spec freeze · L (3–4 weeks) · in progress
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
Protocols are keyed by profile id, so the client's `matchDevice` is the only identity answer;
devices without a profile get a vendor guess marked experimental. Tests decode the recorded device
answers, round-trip every codec on its wire grid, check every hardware profile against its codec,
and run the consumer recipe (`fit` → `complete` → push) for every profile. They corrected three
seeded profiles and found two codec bugs; the open data findings are listed in D33. Left: publish
the bridge, confirm it on real hardware, the inspector, and the hand-authored profiles.

### Phase 5: Probe mode (T3) · L (3–4 weeks)
- Bridge: offline codec analysis (the codecs' `wire()` and `types`, D33) that produces
  `handler-code` sources automatically.
- Probe engine: planner, parallel per-slot search, step inference, whole-set-rejection fallback,
  backup/restore, evidence writer, safety UX (INSPECTOR §3).
- Fake-device tests for every failure path (disconnect mid-probe, rejected write, silent reset).
- **Exit:** ≥ 3 handler families probed end to end on real hardware; derived profiles match the
  hand-authored ones, or the difference is explained and fixed; restore is verified on every run,
  including injected failures.

### Phase 6: Consumers (parallel once Phases 2–3 land)
- **modernGraphTool** (the original draft's M3/M5/M6, done in that repo): replace
  `EqConstraintPreset` with core types; load via client; re-enable the picker with visible badge +
  one-click "unlimited"; per-slot hints; "Fit to device"; `fit` + `complete` before push;
  `toRealized` after pull and for the graph; AutoEQ optimizing within per-slot domains through
  `toRealized`; device-peq compensation removed; `deriveDeviceConstraint()` replaced by `matchDevice()`.
- **Android hardware PEQ app** (its own repo, D27): `core` + `client` + `device-bridge` from npm,
  a native USB transport plugin, an embedded `bundle.json`, `fit` + `complete` before push,
  `toRealized` after pull.
  Consumer guide for embedding.
- Kotlin port: not scheduled (D15).

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Format frozen before real-world use reveals gaps | `/next/` channel; the freeze gate requires ≥ 10 profiles at `community-verified` or better across all hard cases; later additions arrive as minors |
| Few contributions | Seed import makes the DB useful on day one; the inspector makes contributing a guided flow; "draft" lowers the bar |
| Probing harms hearing or hardware | Opt-in, mute/headphones-off gate, EQ commands only, backup → restore with verification, write budget shown, rate limiting, maintainers' own devices first |
| Bridge drifts between modernGraphTool and this repo during extraction | Moving is decided (D20): freeze device-peq changes in modernGraphTool or sync with a script until it consumes the package; take upstream devicePEQ changes at one pinned commit |
| Upstream devicePEQ keeps changing after the seed import | The importer records the upstream commit; review upstream diffs by hand now and then (D26) |
| Wrong data writes bad EQ to devices | Consumers always run `fit` on the hard path; `status` visible; device firmware usually clamps anyway; "wrong constraint" issue form |
| Public ids/URLs churn | Home fixed under the owner's account (D24); custom domain before any move; ids permanent, with `deprecated` + `replacedBy` |
| Device tiers are Chromium-only | T0/T4 work everywhere; the UI explains instead of hiding |
| Android USB access (WebView has no WebHID, Web Serial or WebUSB) | Native plugin stays protocol-free and lives in the app repo; codecs never touch browser APIs (D27). A Kotlin device bridge remains out of scope. |
| Realization laws are wrong or missing for a device | Laws carry their own sources, and unmeasured ones are shown as such (SPEC §8); `measurement` evidence verifies them; no `realization` key means unknown, not exact |

## 7. Immediate next steps

1. Owner: publish the bridge with `core` and `client` as 0.2.0 (`npm run release -- 0.2.0`). The
   captures prove the bytes, not that a write lands: the first real-hardware check comes with the
   inspector's connect → read flow, or modernGraphTool switching over to the package.
2. Phase 4: start `apps/inspector` (T0 browse and playground first; T1/T2 on the bridge).
3. Hand-author the ≥ 10 verified profiles the freeze needs. Candidates from D33's findings: the
   FiiO filter types and the KT Micro Q ranges, settled from vendor apps or docs.
4. Answer Q11 (compact USB match entries), or leave it until the index grows.
