# Decisions

Why the plan looks the way it does. Each entry: the decision, the reason, and what was rejected.
Change a decision by editing its entry and adding a dated note. Don't silently rewrite.

Status legend: **accepted** = proceed on this basis; **proposed** = recommended, needs owner
confirmation (see [Open questions](#open-questions-for-the-owner)).

---

## Review of the original concept draft

The original draft was written as a modernGraphTool issue. Most of its schema ideas hold up. The
main changes come from (a) making the project standalone and multi-consumer, and (b) what the real
device handlers turned out to do ([research/prior-art.md](research/prior-art.md)).

| Draft element | Verdict | What changed |
| --- | --- | --- |
| Template `band` + per-slot `bands[]` | **keep** | Merge semantics specified (per key, replace). `index` may be an array. AutoEQ independently uses the same shape. |
| Domains `{min,max,step}` / `{values}` / `{value}` | **keep** | Grid anchored at 0, `min`/`max` must be on-grid, tolerance-based equality (non-decimal steps such as 1/14 exist). |
| `variants` with `when` | **keep, refined** | Selection is per field, first match wins; the dependency graph must be acyclic; predicates on `type` are allowed (fixed shelf Q is very common). |
| No `mode`; `isGraphic` derived | **keep** | |
| Rules `monotonicFrequency`, `minSpacing` | **keep, sharpened** | Renamed `ascendingFrequency` and evaluated on *completed* slots, fillers included, because that's what the device sees. `minSpacing` applies to active filters only. |
| `preamp` | **keep, extended** | `mode: manual \| auto \| none \| unknown`. |
| `channels` | **keep** (reserved) | |
| `meta.source` enum | **extend** | Several `sources[]` with kinds, verification levels gated on evidence (D17, D28), evidence files in the repo. |
| `meta.verifiedFirmware` | **move** | Firmware scoping goes in `match.firmware`; firmware per source. |
| `match.devicePeq` | **drop** | modernGraphTool-specific. Replaced by transport-level identity (USB / Bluetooth). |
| `match.phoneNames` | **drop** | Binding measurements is consumer-side (D9). |
| `match.usb` numeric ids | **change** | Hex strings, plus `productName` (how most HID devices are actually told apart), plus specificity ranking. |
| Enforcement `hard` / `soft` | **move** | This is consumer policy. The engine provides `validateList` for the soft path and `fit` + `complete` for the hard path (D12). |
| One JSON per device + `index.json` | **keep** | Plus `bundle.json`, `sha256` per file, a `/next/` channel before freeze, and `extends`. |
| Publish via modernGraphTool's CDN build | **change** | Own static hosting (D18). |
| Milestones M1–M6 | **re-sequenced** | M1, M2 and M4 become this repo's Phases 1–3. M3, M5 and M6 are consumer work in modernGraphTool (Phase 6). New here: conformance, inspector, device bridge. |
| M5 "DeviceModelConfig becomes single source of truth here" | **narrow** | Only the constraint half moves. Protocol fields stay in the bridge (D2). |
| *(missing)* slot assignment | **add** | JDS Labs assigns filters to slots by type, so positional mapping is wrong in general (D8). |
| *(missing)* neutral fillers / complete | **add** | Exactly-N devices, per-slot neutral values, ascending rules over fillers. |
| *(missing)* software EQ targets | **add** | D16 |
| *(missing)* cross-language story | **add** | D15 |
| *(missing)* inheritance | **add** | D3 |

---

## Scope and architecture

### D1. Standalone, vendor-neutral project (accepted)
The repo hosts the format, the data, the reference engine, the distribution and the inspector.
modernGraphTool is one consumer among several (Android EQ app, devicePEQ, AutoEQ, …).
**Why:** the user's goal is a shared system, and a format owned by one app gets shaped by that
app's UI (the draft's `match.devicePeq` and `phoneNames` are examples).
**Rejected:** keeping the DB inside modernGraphTool.

### D2. Constraint data ≠ protocol data (accepted)
Profiles say *which values an engine accepts*. How to talk to a device (`reportId`, `schemeNo`,
`baudRate`, slot ids, `compensate2X`, `disconnectOnSave`) stays in the device bridge, which
references a profile by id.
**Why:** an Android software-EQ app or AutoEQ has no use for WebHID report ids. Protocol data also
changes for different reasons and at a different rate. `DeviceModelConfig` mixes both today, which
is why `derive-constraint.ts` exists.
**Rejected:** migrating `DeviceModelConfig` wholesale (the draft's M5).
*2026-10-02:* realization laws describe the engine's DSP, not how to talk to it, so they are
profile data (D29), not bridge config. Constant wire factors such as `compensate2X` stay in the
codec: they're unit conversions.

### D3. Profiles are device-keyed; sharing through `extends` (accepted)
One profile per device engine, with `abstract` bases for chip families and `extends`, flattened at
build time.
**Why:** consumers match *devices*, so lookups must be device-first. devicePEQ's shape-named
profiles (`peq10Band12dBFullShelves`) show that sharing is needed (≈70 Walkplay-chip devices), and
`extends` gives the sharing without making consumers resolve indirection.
**Rejected:** shape-named profiles referenced by devices; copy-paste per device.
*2026-10-02:* upstream devicePEQ has since moved to the same pattern: each device model names a
shared profile (`peqConstraintsRef`) and may override fields (`peqConstraintsOverride`), 106 refs in
`usbDeviceConfig.js`. The importer maps these to bases + `extends` (D23).

### D16. Software EQ targets are first-class (accepted)
`kind: software` profiles (Equalizer APO, Wavelet, Poweramp, Spotify, USB Audio Player Pro, …),
with `bandCount: null` allowed.
**Why:** an Android EQ app and AutoEQ target *apps* as often as hardware. AutoEQ's `PEQ_CONFIGS`
already maintains exactly this list, so it's a seed source and a potential consumer.
*2026-10-02:* AutoEQ is no longer actively maintained (owner), so `PEQ_CONFIGS` is a one-off seed.
This repo maintains the software-target list from then on (D26).

### D27. Android consumer: a Capacitor app on the TypeScript stack (accepted as direction, 2026-10-02; was Q6)
The Android app is a **hardware** PEQ app that pushes EQ to devices over USB. The prototype uses
Ionic + Capacitor so it can run the TypeScript engine. It's early: the stack may change, and it
hasn't been confirmed to run on a device yet.
- It consumes `core`, `client` and `device-bridge` from npm, as modernGraphTool does, and embeds a
  `bundle.json` snapshot so it works offline (invariant 8).
- Capacitor runs in Android System WebView, which has no WebHID, Web Serial or WebUSB. USB access
  goes through a native plugin. Keep that plugin **protocol-free**: enumerate (VID, PID, product
  string), open, HID reports or bulk/CDC transfers, close. All device-specific logic stays in the
  bridge's TS codecs. That's why the bridge's transport interface must not assume browser APIs
  (D20, INSPECTOR §4).
- The plugin is app code and lives with the app. This repo provides the transport interface and the
  browser transports.
- Kotlin port: not scheduled (D15).

**Why:** one engine and one bridge serve the inspector, modernGraphTool and the Android app, and
native code is limited to a thin transport.
**Watch:** Android's kernel HID driver may already hold a device's HID interface. The plugin has to
claim it with `force` or fail with a clear message. Untested until the prototype runs on hardware.
**Superseded:** the earlier assumption that Android needs a Kotlin engine (and, if it controls
hardware, a Kotlin device bridge).

---

## Format

### D4. Template + override, replace-merge (accepted)
See SPEC §5.2. Replace instead of deep merge, because a deep-merged `{min,max}` + `{step}` silently
produces a grid nobody wrote down.

### D5. Domain forms and tolerance (accepted)
SPEC §4. Evidence: grids of 1/14, 1/3, 1/60 and 1/4096 exist (prior-art §2), so exact float
equality is impossible. Non-uniform grids are enumerated rather than adding a log-step feature,
because enumeration covers lookup tables (Edifier), ISO bands and log grids with one mechanism.

### D6. Variants: per-field first match, acyclic (accepted)
SPEC §6. Without an evaluation order, "freq depends on gain" combined with "gain depends on freq"
has no defined projection. Acyclicity plus topological order gives a deterministic `fit` in any
language.

### D7. No `mode` (accepted)
Graphic = all slots freq-locked (derived). Removes the `if (graphic)` branches the draft complains
about, and covers hybrids for free.

### D8. Slot assignment is an explicit operation (accepted)
Apps hold filter *lists*; engines have *slots*. `assign` maps one to the other. It is
order-preserving for homogeneous engines and matching-based otherwise (SPEC §13.5).
**Why:** JDS Labs Element IV (2 LS + 8 PK + 2 HS) is filled by type, and partitioned devices are
filled by frequency. A positional rule is wrong for both.

### D11. Closed rule set, no expression language (accepted)
Answers the draft's open question 4. v1 has `ascendingFrequency` and `minSpacing`. New rules arrive
as minor versions with defined semantics, and unknown rules are surfaced, never ignored. An
expression language would have to be implemented identically on every platform, which is the
expensive part.

### D22. Filter type vocabulary: Equalizer APO codes (accepted, 2026-10-02; was Q4)
`PK LSC HSC LPQ HPQ BP NO AP` with RBJ semantics. Every code is a valid Equalizer APO filter code
that takes the same parameters, so Equalizer APO / AutoEQ text maps 1:1.
**Why:** `LSC`/`HSC` are what AutoEQ outputs and what Equalizer APO users know. They are also the
right filters: Equalizer APO's `LSC`/`HSC` are shelves defined by their *center* frequency, which is
the RBJ cookbook's f0, while its fixed-slope `LS 6dB`/`LS 12dB` use a corner frequency.
Realization differences that follow a known law are described by `realization` (D29).
Coefficient quantization stays out of scope.
*2026-10-02:* changed from modernGraphTool's `LSQ`/`HSQ`. Importers map modernGraphTool and
devicePEQ `LSQ`/`HSQ` → `LSC`/`HSC`, and devicePEQ `LP`/`HP` → `LPQ`/`HPQ` (with `q` locked where
the device fixes it). modernGraphTool's shelf `q` is RBJ Q, so its `LSQ` is exactly `LSC`.
devicePEQ reads a shelf's `q` as the cookbook *slope* S in places (FiiO shelf compensation,
Conexant biquads). Its profile ranges are wire values and import as they are, but shelf *filter
values* from devicePEQ-based tools may need S → Q conversion (prior-art §2.1). The earlier SPEC
mapping table wrongly listed Equalizer APO's `LP`/`HP` for `LPQ`/`HPQ`: in Equalizer APO, `LP`/`HP`
have a fixed Q and only `LPQ`/`HPQ` take one.
**Rejected:** keeping `LSQ`/`HSQ` plus a mapping table. That only made sense if devicePEQ adopted
the format, and no outreach is planned (D26).

### D13. JSON Schema is the structural source of truth (accepted)
Hand-written JSON Schema (draft 2020-12). TS types are generated from it, and CI fails on drift. A
semantic validator covers what JSON Schema can't: merged slots complete, on-grid bounds, acyclic
variants and realization laws, match collisions, verification gating. Each `profile.json` carries `$schema`, so VS Code
validates while editing.
**Why:** a non-TS consumer (a Kotlin port, a Python tool) can't import TypeScript, but every
language can read JSON Schema.
**Rejected:** Zod/TypeBox as the source (TS-first ties the spec to one ecosystem).
*2026-10-02 (Phase 1):* only `profile.schema.json` is hand-written. `scripts/codegen.ts` derives
`source.schema.json` from it (adds `abstract`/`extends`, forbids `via`, relaxes `required`), and
generates the TS types for both. `npm run check` fails on drift. The type generator is our own:
json-schema-to-typescript dropped the fields of every `$ref` + `properties` composition and turned
each required-only `anyOf` into `[k: string]: unknown`. The schemas use a small, fixed subset of
JSON Schema, which the generator covers exactly (~150 lines). The derived source schema is
self-contained, so VS Code resolves it from a relative `$schema` path. Structural validation (Ajv)
lives in `packages/build`, so `core` stays dependency-free.
Format fixtures live in `conformance/v1/profiles/`, beside the engine vectors, and are CC0 like
them (D25). Ports of the validator run them too. Cases are RFC 7386 merge patches over one valid
base profile, so each case shows only what breaks it.

### D14. Published files are flat; consumers are lenient (accepted)
`extends` is resolved at build time. Consumers ignore unknown keys and never run the strict CI
schema at runtime. Keeps every port small and keeps old apps working when minors add fields.

### D17. Provenance and verification (accepted)
`meta.sources[]` with kinds. Verified statuses require probe, vendor-docs, vendor-app or
measurement evidence. Evidence JSON lives in `data/evidence/`.
**Why:** handler code shows only *wire* limits; firmware limits differ (prior-art §2), and users
need to know which kind of claim they're trusting.
*2026-10-02:* the single `verified` status is split by who checked the evidence (D28, SPEC §10).

### D28. Verification levels and governance (accepted, 2026-10-02; was Q8)
Maintainers can't own every device, so a status records *who checked* as well as *what evidence
exists*:
- `draft`: no counting evidence (seeded, handler code, unconfirmed reports).
- `community-verified`: a contributor supplied counting evidence (probe file, vendor docs,
  vendor-app capture, measurement). A maintainer reviewed it but didn't reproduce it.
- `maintainer-verified`: a maintainer checked it personally, on their own hardware or against
  vendor docs.

Exact rules and CI checks are in SPEC §10. Sources inherited through `extends` never count: a probe
of one Walkplay device doesn't verify another.

Governance: anyone may open a PR, including for `draft` profiles. Merging needs one maintainer
approval (branch protection), which covers status raises too: CI checks the evidence rule for each
level, and the reviewer checks the evidence content. Changes to `schema/`, `docs/SPEC-DRAFT.md`
and `packages/core/` also need a CODEOWNER. Those rules are path-based, so CODEOWNERS can enforce
them. Maintainers are listed in `MAINTAINERS`. Former maintainers stay listed, marked as former, so
their past verifications stay valid.
*2026-10-02 (Phase 0):* CODEOWNERS also covers `MAINTAINERS` (it decides who can make a profile
`maintainer-verified`) and `.github/` (it holds the CI that enforces the evidence rules).
**Rejected:** a single `verified` level. With few maintainers and many devices, it would either
stay empty or mean different things on different profiles. Also rejected: counting confirmations
("N reports make it verified"), because that's easy to game and one probe file outweighs several
"works for me" reports.

### D29. Domains are written values; realization laws are profile data (accepted, 2026-10-02; was Q10)
Some engines build a different filter from the cookbook meaning of the values they take
(prior-art §2.1). Uncorrected, a typical AutoEQ preset comes out 0.6–1.3 dB off and a ±12 dB narrow
filter up to 3.5 dB off. Two parts:
1. **Domains describe the values the engine takes**, in canonical units. Authors fold in every
   conversion that depends only on the value itself: register value → dB, octaves → Q, and
   constant factors such as KTMicro's ×2 or Walkplay's ×0.9775 frequency. A deviation that depends
   on another field is a realization law. Every evidence kind except measurement observes these
   values, so it's the only meaning most profiles can be written in.
2. **Realization laws are profile data from v1** (SPEC §8): a closed set (`gainScaledQ`,
   `nyquistScaledQ`, `shelfFrequencyShift`) with its own sources, because only a measurement can
   show them. Core gains exact `toRealized` and `toWritten`. `fit` takes the response the user wants
   and returns the written values to send, plus the realized result.

**Why:** the laws live in one place that every consumer can read, instead of as compensation code
inside one bridge (devicePEQ's `compensation.js` and per-model flags). The bridge becomes a pure
codec, and UIs and optimizers can show, and aim at, what the listener gets. The laws describe the
engine's DSP, not how to talk to it, so invariant 2 holds.
**Consequences:**
- The engine op that fills slots up to `bandCount`, formerly `realize`, is renamed `complete`, so
  "realized" means one thing only.
- devicePEQ mapping: `rbjGain` → `gainScaledQ`; `cosNyquist` → `nyquistScaledQ` (without its
  unused `constant`/`exponent` knobs); `shelfSqrtA` → `shelfFrequencyShift`. Q `constant` and
  frequency `ratio` become value-only conversions, folded into domains and applied by the codec.
  `peakingAlpha` disappears, because in RBJ-Q terms it's the identity.
- Consumers hold *wanted* filters. Device reads go through `toRealized`; writes go through `fit` →
  `complete`. modernGraphTool and the Android app adopt this directly, with no compatibility layer.

**Rejected:** domains in realized terms (needs a measurement of every device, and domains become
gain-dependent); laws in bridge config only (every consumer re-implements them, and nothing outside
the bridge sees them); deferring the laws to a v1 minor (owner prefers them in v1).

---

## Engine and consumers

### D9. Measurement-name binding lives in the consumer (accepted)
Answers the draft's open question 2. The DB carries hardware identity (`match`) and searchable
`aliases`. Mapping "this measurement / phone_book entry → profile id" is done by each app, for
example an opt-in key in modernGraphTool's `phone_book.json`.
**Why:** measurement naming is per-database (different reviewers name the same IEM differently),
so a central list would always be incomplete for somebody.

### D10. Auto-apply policy recommendation (accepted, consumer guidance)
Answers the draft's open question 1. The consumer guide recommends:
- **Auto-apply** only for a physically connected device with a unique match at specificity ≥ 3.
- **Suggest** ("Constraints available for X, apply?") for name-based or ambiguous matches.
- **Never** silently rewrite user filters. Show the active profile at all times, one click from
  "unlimited".

### D12. Enforcement levels are consumer policy (accepted)
Soft path: `validateList` while editing, flag but don't rewrite, offer "Fit to device".
Hard path: `fit` + `complete` before any device write.
*2026-10-02:* `realize` renamed `complete` (D29).

### D15. Normative vs informative engine behaviour; conformance vectors (accepted)
`project`, `resolveSlot`, `toRealized`, `toWritten` and `validate` are exact and normative.
`assign`, `fit` and `complete` are normative only through their properties (sound, faithful on
valid input, idempotent). This repo ships
conformance vectors, and ports to other languages prove themselves against them.
**Why:** exact cross-language agreement on matching heuristics is costly and buys nothing. Agreement
on *validity* is what matters.
*2026-10-02 (was Q7):* every known consumer runs TypeScript, including the Android app (D27), so no
port is scheduled. The vectors stay: they are the contract for any future port, and they pin down
the TS engine too. If a Kotlin port is ever needed, it lives in `packages/kotlin` so it runs
against the vectors in this repo's CI. The earlier "Kotlin first, for Android" plan and the
rejection of a WASM or embedded-JS engine on Android assumed a native Kotlin app. Both are moot
while the app is a WebView app.
*2026-10-02:* `toRealized`/`toWritten` added to the exact ops, and `realize` renamed `complete`
(D29).

---

## Distribution and process

### D18. Static hosting plus npm (accepted, 2026-10-02; was Q5)
GitHub Actions builds `dist/` on every merge to `main` and deploys to GitHub Pages: the inspector at
`/`, data at `/v1/` (and `/next/` before freeze). Tagged releases publish an npm package with the
same files, which jsDelivr mirrors automatically, for pinned and embedded use. `bundle.json` is also
attached to GitHub Releases for snapshotting. No server, no database. GitHub Pages serves
`Access-Control-Allow-Origin: *`, so browser consumers can fetch cross-origin.
*2026-10-02:* the code packages (`core`, `client`, `device-bridge`) are published to npm as well,
because the Android app consumes them (D27). URLs and package names are in D24.
**Rejected for now:** Cloudflare Pages. The output is static, so switching later is cheap.

### D19. Contributions via GitHub only; no backend in v1 (accepted)
The inspector builds prefilled PR/issue URLs (INSPECTOR §2 T4). CI (schema, semantic validator,
collision check, prettier) gates merges. Review rules are in D28, licensing of contributions in D25.
*2026-10-02:* "CODEOWNERS required for verified status changes" is replaced by D28. CODEOWNERS is
path-based and can't see a field change, and every merge already needs a maintainer.
**Rejected for v1:** an anonymous submission API (needs a bot token, moderation and abuse handling).
Revisit if PR friction proves to be the bottleneck.

### D20. The inspector lives here, with the device bridge (accepted, 2026-10-02; was Q2)
The bridge is extracted from modernGraphTool `src/lib/device-peq` into `packages/device-bridge`,
and refactored into codec + transport (INSPECTOR §4). The format, data and core engine **never
depend on it**. modernGraphTool later switches to consuming the package.
*2026-10-02:* two additions.
- The transport interface must not assume browser APIs. The Android app plugs in a native USB
  transport (D27).
- modernGraphTool's port is behind upstream devicePEQ. It lacks the Conexant handler and the
  recorded device captures with per-handler tests (prior-art §2, §5). The extraction includes a
  one-time catch-up from upstream (0BSD), pinned to a recorded commit.
- Upstream's compensation code (`compensation.js`) is **not** ported. Its laws become profile data
  and core applies them (D29). Codecs apply only constant wire factors (KTMicro ×2, Walkplay
  ×0.9775).

### D21. Tech stack (accepted)
npm workspaces, TypeScript strict, Vitest + fast-check, Ajv, Svelte 5 + Vite for the inspector, and
Prettier + ESLint configured like modernGraphTool. Same stack as the first consumer, so code and
reviewers move between the two easily.
*2026-10-02 (Phase 0):* two differences from modernGraphTool. Markdown is excluded from Prettier:
the docs are hand-wrapped at 100 columns with compact tables and column-aligned jsonc comments, and
Prettier pads every table and reindents the examples. The Svelte and Tailwind Prettier plugins
arrive with the inspector (Phase 4). CI runs Node 24, on Linux and Windows like modernGraphTool.
Scripts are TypeScript run directly by Node (type stripping), so the minimum is Node 22.18.

### D23. Seed data is imported and marked draft (accepted)
A one-off importer reads devicePEQ's `peqConstraintsConfig.json` + device configs and AutoEQ's
`PEQ_CONFIGS`, and emits `draft` profiles with `handler-code` / `community` sources, enriched with
the wire grids from prior-art §2. Verification then happens one device at a time.
*2026-10-02:* the importer records the upstream commit it read (D26). It maps devicePEQ's
`peqConstraintsRef` / `peqConstraintsOverride` to bases + `extends` (D3) and filter codes per D22.
It reads only devicePEQ's own 0BSD files, never the third-party material listed in D25.
Compensation settings in devicePEQ's model configs become `realization` blocks, mapped per D29,
with a `community` source citing `compensation.js`.

### D24. Name and home: eqcaps, under the owner's accounts (accepted, 2026-10-02; was Q1)
The project is **eqcaps** ("EQ capabilities"). It's neutral, not tied to modernGraphTool, and
covers software EQs as well as devices. It lives under the owner's personal GitHub account and npm
scope, like `@potatosalad775/turboeq`:

| What | Where |
| --- | --- |
| Repository | `github.com/potatosalad775/eqcaps` |
| Pages (inspector at `/`, data at `/v1/` and `/next/`) | `https://potatosalad775.github.io/eqcaps/` |
| `$schema` in profiles | `https://potatosalad775.github.io/eqcaps/v1/schema/profile.schema.json` |
| npm, data files (mirrored by jsDelivr) | `@potatosalad775/eqcaps` |
| npm, code | `@potatosalad775/eqcaps-core`, `@potatosalad775/eqcaps-client`, `@potatosalad775/eqcaps-device-bridge` |

The repo and the package names were unclaimed on 2026-10-02.
**Trade-off:** every URL contains the account name. `$schema` URLs are cheap to change: it's one
repo-wide replace, and consumers ignore them. The data URL that apps fetch is harder to change, but
apps keep working without it (invariant 8). If a move to an organization ever becomes likely, put
a custom domain in front before apps hard-code the data URL.
*2026-10-02:* first recorded as eqDeviceInfo with `@eq-device-info/*`, then renamed the same day,
before anything was published.
**Rejected for now:** a GitHub organization (owner). Revisit if more maintainers join (D28).

### D25. Licenses: code MIT, data CC0-1.0 (accepted, 2026-10-02; was Q9)
- **MIT:** code (`packages/`, `apps/`, `scripts/`). Matches modernGraphTool.
- **CC0-1.0:** `data/` and everything published as JSON (profiles, index, bundle, schema,
  conformance vectors). Any app, including closed-source Android apps, can embed it without
  attribution plumbing, and `meta.contributors` still credits people.
- **Inbound = outbound:** `CONTRIBUTING.md` and the PR template state that contributions to `data/`
  are CC0-1.0 and code is MIT. This has to be in place before the first external PR, because
  relicensing contributed data later needs every contributor's consent.

Compatibility with the sources we borrow from:

| Source | License | What we take | Obligation |
| --- | --- | --- | --- |
| devicePEQ (© 2024 Jerome O'Flaherty) | 0BSD | constraint registry, device configs → CC0 data; handler code (via modernGraphTool) → MIT code | none. 0BSD grants use, modification and redistribution for any purpose, with no conditions. Credited anyway in `meta.sources` and `THIRD-PARTY-NOTICES.md`. |
| modernGraphTool `device-peq` | MIT | bridge code | keep its copyright and license notice in `packages/device-bridge` |
| AutoEQ `PEQ_CONFIGS` | MIT | facts only (band counts, ranges) → CC0 data | none for facts; its notice goes in `THIRD-PARTY-NOTICES.md` as a courtesy |

Nothing flows back as an obligation, and devicePEQ could take our CC0 data just as freely.

**Not covered by devicePEQ's 0BSD.** Its repo also contains:
- captured vendor web-app bundles (`fiio-js-capture/`, `walkplayJS/`,
  `walkplayPreprocessor/walkplay.js`, `Q5K/q5K-chrome-plugin.js`), which are vendor code with
  embedded MIT/ISC library headers;
- protocol notes reverse-engineered from decompiled vendor apps (`bluetooth_tools/`).

Nothing from these is copied here. Facts learned from them (a band count, a frequency range) may
become data with a `community` source that cites them.
**Rejected:** CC-BY-4.0 for data, which puts an attribution duty on every embedding app.

### D26. No upstream coordination; this repo is the source of truth (accepted, 2026-10-02; was Q3)
AutoEQ hasn't been updated in years, and devicePEQ's maintainer is focused on other projects
(owner), so no outreach or joint spec work is planned.
- The seed import (D23) is one-off. After it, profiles are maintained here, with no automatic sync
  in either direction.
- The importer records the upstream commit it read, so later upstream changes can be reviewed as a
  diff and taken over by hand. devicePEQ still gets occasional commits (last 2026-08-26, with v0.22
  untagged).
- devicePEQ and AutoEQ stay *potential* consumers. The format is public and CC0 (D25), so either
  can adopt it without coordination. Nothing in the plan depends on that.

---

## Open questions for the owner

None open. A new question gets a number, a recommendation and an entry here.

### Answered 2026-10-02

| Q | Answer | Recorded in |
| --- | --- | --- |
| Q1 Name, org, scope | eqcaps, under the owner's GitHub account and npm scope | D24 |
| Q2 Bridge ownership | move it here | D20 |
| Q3 Upstream outreach | none; do our own thing | D26 |
| Q4 Filter type codes | `LSC`/`HSC` | D22 |
| Q5 Hosting | GitHub Pages | D18 |
| Q6 Android app | hardware PEQ over USB; Ionic + Capacitor prototype on the TS engine | D27 |
| Q7 Kotlin port | `packages/kotlin` if ever; not a priority | D15 |
| Q8 Governance | as recommended, plus two verified levels | D28 |
| Q9 Licenses | MIT code, CC0 data; checked against devicePEQ | D25 |
| Q10 Written vs realized values | domains are written values; realization laws in profiles from v1 | D29 |
