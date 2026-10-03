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
level, and the reviewer checks the evidence content. Changes to `schema/`, `docs/SPEC.md`
and `packages/core/` also need a CODEOWNER. Those rules are path-based, so CODEOWNERS can enforce
them. There is no maintainer list. For `maintainer-verified`, CI requires a counting source with
`by`, and the approving maintainer confirms that `by` names a maintainer, just as they check the
evidence itself.
*2026-10-02 (Phase 0):* CODEOWNERS also covers `.github/` (it holds the CI that enforces the
evidence rules).
*2026-10-02 (after Phase 1):* the `MAINTAINERS` file is dropped (owner: too much upkeep for what it
buys). It existed only so CI could check `by` against a list, and it had to keep former
maintainers forever so their old verifications stayed valid. Every merge already needs a
maintainer's approval, and that approval is the actual guarantee. Also rejected: checking `by`
against CODEOWNERS, which would invalidate a former maintainer's verifications once they leave it.
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
*2026-10-02:* vectors exist for all eight ops, one file per op; property ops carry asserted facts
(D30).

### D30. Engine semantics pinned down by the reference implementation (accepted, 2026-10-02)
Phase 2 implemented SPEC §13 and ran its properties over 100k random profiles per property. Where
the draft left room, these choices were made (all now in SPEC §6–§8 and §13):
- **Exact outputs are fully specified.** `validate` fixes the order of its violations and names
  the slot where a rule breaks (the draft's `slot: null` for rules gave UIs nothing to point at).
  `too-many-bands` is reported once. Variant conditions, activity and every comparison use the §4
  tolerance. A gainless type's gain counts as 0 everywhere, conditions included. Unknown types
  count as gain-using, so their gain is kept rather than silently zeroed.
- **ascendingFrequency on the completed array is checked exactly, without running `complete`.**
  Each empty slot takes the lowest frequency its filler's domain allows, which is optimal for
  every later slot. `validate` therefore stays exact, and `complete` is guaranteed to keep the
  order whenever `validate` found room.
- **`project(NaN)` is the field's neutral value.** A NaN otherwise reaches the device as written
  data. Laws with a `designRate` are the identity outside `0 < f < designRate/2`, which keeps
  `toRealized`/`toWritten` total and mutually inverse. In-domain values are never affected.
- **`fit` never trades a filter for a rule, and is a fixpoint.** A wanted filter whose gain
  projects to 0 leaves its slot empty (a flat filter is no filter). `minSpacing` moves a filter to
  the lowest allowed frequency at or above the target, where projecting the target could round it
  back down. The frequency-ordered assignment replaces the min-cost one only if it keeps as many
  filters. The reference repeats its pass on its own realized output until the slots stop
  changing, because heuristic choices that depend on the input otherwise break idempotence (the
  property tests found such cases on profiles whose rules can never be met).
  *2026-10-02:* the passes can also cycle. With slots fixed below an earlier slot's window, the
  frequency-ordered assignment shifts the filters one slot along the chain on every pass. The
  reference now stops when the slots repeat any earlier pass and takes the cycle member with the
  fewest violations, then the least distance to the wanted filters (matched as multisets), then
  the first in slot order. The choice depends only on the cycle, so it is idempotent. The cap on
  passes went from 8 to 32, because the property tests found cycles that only repeat after more
  than 8.
- **Idempotence is stated precisely:** same slots, realized filters, preamp and feasibility. On an
  infeasible result, filters may come back paired with different inputs, so `changes` can differ.
  A new normative property, *safe*, says every written value of `fit` is in its domain.
- **`complete(profile, slots)` returns `{ filters, warnings }`.** The draft's `preamp` argument had
  no use. Warnings (`not-neutral`, `no-room`) replace the draft's unspecified "emit a warning".
  `assign` also returns `slotOf`, and `validateList` names the input filter of each violation,
  because an editing UI holds a list, not slots.
  *2026-10-02 (Phase 4):* `fit` returns `slotOf` too, for the same reason: the inspector's
  playground shows each wanted filter beside what it became, and `changes` names only the filters
  that moved. The reference already composed this mapping across its passes. Additive, and pinned
  by a property check: it pairs every filled slot with exactly one wanted filter.
- **Engine vectors are generated** by `scripts/conformance.ts` from hand-written inputs, with the
  reference engine supplying exact-op expectations. `npm run check` fails on drift, as it does for
  codegen. Unit tests pin hand-computed values independently, so a generated vector can't simply
  encode a bug.
- **No profile caching.** Each operation prepares the profile it is given. Apps (the inspector
  editor) mutate profiles in place, so a cache keyed by object identity would go stale.

**Rejected:** a canonical sort by filter content inside `assign` (it loses list order, which
`fit`'s second pass relies on to keep slots stable); relaxing idempotence to feasible results
only (the fixpoint makes the full property cheap); a `rule-unsatisfiable` profile check for
profiles whose ascendingFrequency can never hold (possible later, since `validate` already
detects every instance).

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
*2026-10-02 (Phase 4):* done, from devicePEQ `0617f38` directly, since modernGraphTool's port
predates most of upstream's changes. What the bridge looks like is D33.

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

### D31. Seed import: what was taken and how (accepted, 2026-10-02)
`scripts/import/seed.ts` ran once against devicePEQ `0617f38` (2026-08-26), with facts from
modernGraphTool `fd55b9f8` and AutoEQ `7ae0f56` transcribed in `scripts/import/tables.ts`. It
wrote 98 `draft` profiles and 15 bases. From now on `data/` is edited by hand (D26); the script
refuses to overwrite it without `--force`.
- **Bases** are per codec family and devicePEQ shape (`walkplay-peq-8-band-10db-pk-only`), because
  wire grids differ per handler even where devicePEQ shares a shape. A base is written only when
  two or more profiles use it; otherwise its content goes into the profile.
  `peqConstraintsRef` + `peqConstraintsOverride` become `extends` + overridden keys (D3, D23).
  devicePEQ's inline constraint fields next to a ref are ignored, as devicePEQ itself ignores them.
- **Domains** are devicePEQ's ranges on the handler's wire grid, bounds moved inward onto it.
  Frequency is 20 Hz–20 kHz, which devicePEQ assumes but doesn't record. Constant frequency
  factors are folded in (Walkplay SchemeNo11 ×0.9775 gives a 0.9775 Hz grid, KTMicro
  `compensate2X` a 2 Hz grid), per D29.
- **Preamp:** `manual` with the handler's wire range where the handler writes one, `auto` where
  `deviceHandlesPregain` is set and the handler honours it, `none` where the handler never sends
  one, otherwise `unknown`.
- **Realization:** `rbjGain` → `gainScaledQ` (peaking only for FiiO, as devicePEQ scopes it),
  `cosNyquist` → `nyquistScaledQ`, `shelfSqrtA` → `shelfFrequencyShift`, each with a `community`
  source citing `compensation.js`. A named device gets its group's laws only when a recorded
  capture puts its product id in that group; otherwise its realization stays unknown.
- **Identity:** a named HID device matches `productName` under every vendor id of its devicePEQ
  vendor block, as devicePEQ does. A recorded capture adds its exact (vid, pid, name), so the
  device wins over its product-id group (specificity 4 vs 3). Product-id groups become one
  profile each (`walkplay-schemeno11-devices`), matching every (vendor id, product id) pair of
  the block, because devicePEQ doesn't record which vendor id goes with which product id. A
  product id in two groups stays with the first, which devicePEQ checks first. Bluetooth SPP
  devices get a name prefix marked as a placeholder (SPEC example A did the same).
- **Names and ids** are curated in `tables.ts`. Name variants of one device (`FIIO BTR17`,
  `BTR17`) become one profile. Where they disagree, the narrower constraints win and the notes say
  so. Products with generic USB names (`CS43131 HiFi Audio DSP`) get the brand Walkplay.
- **modernGraphTool** contributes names only: product-name variants of upstream devices, and three
  devices upstream lacks, with the constraints of the upstream group their capture falls in.
  Its constraint values are older than upstream's and are not used.
- **AutoEQ's `PEQ_CONFIGS`** are optimizer settings, not engine limits. Only band count, gain
  range, peaking Q range and fixed bands are taken, for Spotify, Poweramp, Neutron, USB Audio
  Player Pro and Qudelix 5K (identity from a devicePEQ capture).
- **Not imported**, with reasons in `tables.ts` `NOT_IMPORTED`: network devices (WiiM, Luxsin;
  the format has no network identity), EarFun Tune Pro (fixed Q of unknown value), KT Micro's
  "Space Gaming IEM" (protocol unconfirmed upstream), devices of unknown brand, miniDSP (no
  identity), AutoEQ's generic presets.

**Consequence:** the Walkplay groups hold 6,536 of the 7,524 match entries, most of them pairs that
don't exist. `index.json` is 357 KB, 32 KB gzipped. See Q11.
**Rejected:** shape-named published profiles (D3); skipping the product-id groups, which would
drop most Walkplay devices; restricting groups to one vendor id, which drops real devices
(Moondrop and others ship under their own ids); copying modernGraphTool's constraint values.
*2026-10-02:* the bridge's tests (D33) corrected four seeded profiles: `fiio-ka15` had Walkplay
grids, because devicePEQ lets the product id group pick the handler; `moondrop-edge` and
`tanchjim-rita` allowed shelves their handlers can't write; `qudelix-5k` had continuous ranges
where its USB write is quantized.

### D32. Data pipeline and client (accepted, 2026-10-02)
- **Build:** `packages/build` validates `data/` (repository layout, schemas, semantic and
  cross-profile rules) and publishes a channel: flat profiles, `index.json`, `bundle.json`,
  schema and conformance (SPEC §14). Layout rules have their own codes (`LAYOUT_CODES`), apart
  from the format's `ISSUE_CODES`, because they are about this repository, not the format.
  Reports give file and line, and in GitHub Actions also annotate the line in the PR diff. The CLI
  runs from TypeScript sources through a custom export condition (`eqcaps:source`), so nothing
  needs building first.
- **Index additions:** entries also carry `aliases` (search) and `replacedBy` (so a client can
  follow a deprecated id without fetching the profile). Both optional (SPEC §14).
- **Channels:** `/next/` profiles point `$schema` at `/next/schema/`, since `/v1/` doesn't exist
  until the freeze.
- **Client:** `createClient()` with TTL + ETag revalidation for the index and bundle,
  content-addressed profile cache (index `sha256`), a pluggable store, an embedded `snapshot`
  for offline use, and `onError` as the only way failures surface. `matchDevice` is also a pure
  export, so a consumer can match against an embedded bundle without the client. The client
  reads `fetch` and timers from `globalThis` and declares only the types it uses, so it has no
  DOM or Node types.
- **Releases** are made locally with `npm run release -- <version>`: checks, build, `npm publish`
  of `core` and `client`, a git tag, and a GitHub Release with `bundle.json`. Versions are set
  only for the publish; `package.json` files stay at 0.0.0. The data package
  `@potatosalad775/eqcaps` (D24) waits for the freeze, when its contents become stable.
  *2026-10-03:* the format is frozen (D36); the data package is the next release task.
  *2026-10-02:* first done by a tag-triggered workflow with an npm token, which failed on the
  account's 2FA. Releases are rare, so a local script that lets npm prompt for 2FA beats managing
  an automation token. Lost: npm provenance attestations, which need a CI publish. Revisit with
  npm trusted publishing (OIDC from Actions, no token) if releases become frequent.

### D33. Device bridge: transports, codecs and protocols (accepted, 2026-10-02)
`packages/device-bridge` (`@potatosalad775/eqcaps-device-bridge`) drives the devices the database
describes. Its protocols come from devicePEQ at `0617f38`, the commit the seed import read (D31).
16 handlers: FiiO (USB HID, USB serial, "F1 10" over SPP and BLE), Walkplay, Moondrop, Moondrop
Old Fashioned, Conexant, KT Micro, Fosi Audio, Qudelix, JDS Labs, Nothing, Tanchjim Rita, Moondrop
Edge, Edifier, Airoha (SPP and BLE).
- **Transports.** Handlers see two interfaces and nothing else: HID (reports, feature reports,
  input listener, descriptor collections) and stream (serial or BLE: write, read with a timeout).
  A stream request first drops the bytes already received, and answers are matched to their
  command, so a late answer to an earlier write is never taken for the next one's.
  No browser types. WebHID, Web Serial and Web Bluetooth implementations are in the `./browser`
  entry, typed structurally. The Android app implements the same interfaces over its native USB
  plugin (D27).
- **A handler is a codec and a session.** The codec is pure: `encode(request)` gives the write
  frames, `decode(frames)` reads them back, `wire()` says what the frames can carry (range and
  resolution per field, or the list of frequencies) and `types` which filter types have codes. The
  session does the I/O: pull, push (sends the codec's frames, with the waits and acknowledgements
  the device needs), current slot, EQ on/off. The inspector can ask a codec what a value becomes
  on the wire without a device.
- **Codecs write what they are given.** No clamping, padding, type conversion or compensation.
  Values are rounded onto the wire grid; a value that doesn't fit its field is a `BridgeError`
  `unrepresentable`, a type without a wire code `unsupported-type`, both before anything is sent.
  The grid leaves out field values the decoder reads as "unset" (Walkplay 0 and 0xFFFF Hz, Moondrop
  outside 10 Hz–24 kHz, FiiO and Fosi Audio 0 Hz), so what a codec says it carries reads back as
  written.
  An unknown code reads back as the extension type `x-wire-<code>` and encodes to the same code,
  so a pull hides nothing and a probe can send any code. Constant wire factors are protocol
  options (`freqScale`: Walkplay SchemeNo11 0.9775, KT Micro 2), matching the profiles' grids
  (D29).
- **Push takes written values**, one per band in band order, normally `fit` then `complete`; the
  bridge does no fitting of its own, so INSPECTOR §4's raw push is the only push. The preamp is
  written only when given (Nothing sends it with the bands, so it is 0 when left out). A `preamp`
  or `slot` the write can't carry (`writesPreamp`, `writesSlot`) is an `invalid-request`: dropped
  silently, it would look applied.
- **Pull returns written values** in band order, `null` for a band that is off or unset, plus
  the preamp and slot where the protocol reports them. Protocols that read band by band take the
  count from the caller or the profile (`needsBandCount`). A chosen `slot` is refused where the
  protocol reads only the current preset (`readsSlot`), rather than answered with the current one.
- **Protocols are keyed by profile id.** `PROTOCOLS` maps each hardware profile to its handler,
  protocol options, preset slots and transport details (baud rate, disconnect on save). Which
  profile a connected device is, is the database's question, answered once by the client's
  `matchDevice`; the bridge holds no device identities. A device with no profile gets
  `guessProtocol(vendorId)`, its vendor's usual HID protocol, marked experimental. Browser
  choosers are filtered from the database entries the app has (`chooserFilters(index.profiles)`),
  plus the guessable vendors, so an app that embeds the bundle works offline (invariant 8).
- **Tests check the protocols against devices and data, not against devicePEQ's bytes.** The
  recorded captures (devicePEQ `tests/captures/`, its own 0BSD files; not `external/`, which is
  vendor web-app traffic) are kept where they hold real device answers: every pull decodes them,
  and the recorded writes, decoded and re-encoded, give the same band frames. Every codec, under
  every option set the table uses, round-trips any request on its wire grid (end points
  included) and refuses values outside it (fast-check). Every hardware profile has a protocol,
  `freqScale` equals its frequency step, and what a profile allows beyond the codec's wire, in
  range, grid or types, is listed.
- **Differences from upstream:** the FIIO KA15 is driven by the FiiO handler (devicePEQ lets its
  product id group pick Walkplay; the capture is FiiO's); Moondrop Old Fashioned uses its register
  handler (upstream imports it under a name the module doesn't export); FiiO's "EQ off" selects
  the model's off preset rather than preset `maxFilters`; FiiO pulls ask one question at a time
  and keep band order; Walkplay coefficients use the plain cookbook arithmetic; Airoha SPP writes
  32-bit frequencies (upstream's 16 bits overflow above 655 Hz); Edifier frequencies missing from
  the code table are refused rather than snapped; a Fosi Audio band at 0 Hz is refused rather than
  sent at 1000 Hz; KT Micro devices with listed band registers
  refuse bands past them; decoders return exact wire values rather than rounding to two decimals;
  Qudelix 5K is in the table (experimental, write-only) as modernGraphTool does.
- **Not ported:** compensation (profile `realization` now, D29) and the sample-rate reads that
  only fed it; non-EQ extras (mic gain, DAC filter, balance, battery); handlers for devices the
  database has no profile for (EarFun, WiiM, Luxsin, Topping); upstream's UI (toasts, device
  pickers).

**Found in the data:** `fiio-ka15` had Walkplay wire grids, `moondrop-edge` and `tanchjim-rita`
allowed shelves their handlers can't write, and `qudelix-5k` had continuous ranges on a quantized
write; all four are corrected (D31). Left open, kept visible by the tests: FiiO profiles allow LPQ,
HPQ, BP and AP, which no FiiO codec has codes for; recorded devices hold values outside their
draft ranges (KT Micro Chu 2, Bunny and One DSP with Q up to 8 against 5, Kiwi Ears Allegro Pro
at 18 Hz, EPZ TP13 at 19.55 Hz).
*2026-10-03:* not every hardware profile has a protocol any more. The RME ADI-2 DAC FS profiles
(from RME's manual) describe a device controlled over MIDI SysEx, which no handler speaks. The
protocol test lists such profiles by id, so a missing protocol is always a decision.
**Rejected:** keeping devicePEQ's `normalizeFiltersForDevice` in the bridge (constraint logic that
duplicates core's `fit`); passing profiles to the bridge for writes; a Kotlin bridge (D27); a
registry in the bridge that matches device identities to handlers, hand-written or generated from
the data (two matchers for one question; the client already matches, offline too, from an
embedded bundle); tests that require pushes to reproduce devicePEQ's recorded bytes down to its
arithmetic quirks (the goal is driving the database's devices, not reproducing devicePEQ);
devicePEQ's synthetic captures (Conexant, the two BLE ones, Qudelix) and non-EQ ones (mic gain,
the vendor site).

### D34. Inspector: a static SvelteKit app on the same origin as the data (accepted, 2026-10-02)
`apps/inspector` (private workspace, not published) is the T0–T2 tiers of INSPECTOR §2 so far:
search, profile view, playground, and connect → identify → match → read → validate.
- **SvelteKit with adapter-static, as a SPA.** Same stack as modernGraphTool (D21: SvelteKit is
  its Vite plugin), Tailwind included. Nothing renders on the server. Pages without parameters are
  prerendered shells; `/p/<id>` is not, because ids come from the data, which changes without a
  redeploy of the app. GitHub Pages answers unknown paths with `404.html`, which is the SPA
  fallback, so profile links are real paths. Built with `BASE_PATH=/eqcaps` and deployed at `/`
  of the Pages site beside `/next/`, replacing the placeholder page.
- **Data through the client, same origin.** The app reads `/next/` next to itself (dev and
  preview serve the local `dist/site/next/`), loads `index.json` for search and identity and
  `bundle.json` for profiles and feature filters (about 70 KB gzipped together), and gets
  everything else from the client: cache in `localStorage`, ETag revalidation (TTL 5 minutes,
  since contributors check their own changes here), failures as messages. Deprecated profiles,
  which the bundle leaves out, are fetched one by one.
- **Workspace sources.** Vite resolves workspace packages through the `eqcaps:source` condition,
  so nothing is built first. The app uses `build`'s main entry in the browser (`brandSlug` now,
  Ajv for the editor later); only its `./node` entry needs Node.
- **Playground formats.** Equalizer APO text (which AutoEQ's `ParametricEQ.txt` is) and JSON.
  Codes map per SPEC §5.3: `LP`/`HP` become `LPQ`/`HPQ` at Q = 1/√2, `LSQ`/`HSQ` become
  `LSC`/`HSC` (D22), `BW Oct` becomes Q by the cookbook. Shelves given by slope are refused with
  a message rather than converted from an assumed default. Unreadable lines are reported by number
  and the rest still parse.
- **T1/T2 never write.** The connect page calls `pull` and nothing else from the bridge. The
  device is identified once, by the client's `matchDevice` over the index; the protocol is
  `protocolFor(profile)`, or for an unknown HID device `guessProtocol(vendorId)`, shown as
  experimental. A read-back is checked with `validate` against the chosen profile, plus the band
  count when the protocol reports it; every discrepancy is a finding, with a prefilled
  "wrong constraint" issue. An unknown device gets a prefilled "new device" issue whose text the
  user edits before it leaves the page (the PII review of INSPECTOR §6). Issue forms are prefilled
  by their field ids; the profile itself never goes in a URL here.
- **Tests.** The pure modules (parsing, search, slot rows, violation text, connect helpers) are
  unit-tested from the root Vitest run; `npm run check` runs `svelte-check`. The connect flow was
  exercised headlessly against a fake WebHID device replaying the KT Micro Chu 2 capture, which
  reproduced D33's open finding (Q 7 read back against the profile's 5).

**Rejected:** hash routing (ugly, unshareable-looking links, for no gain over the 404 fallback);
prerendering a page per profile at build time (couples the app's deploy to the data's, and the
SPA reads the data anyway); a UI component library (plain Svelte and Tailwind are enough so
far); fetching profiles one by one for search (the bundle is small, and feature filters need the
profiles).
*2026-10-03:* `/edit/<id?>` (T4, D35) and `/docs` (the consumer guide) are built. The connect page
gained the evidence export with its PII review, and hands a reviewed read-back to the editor.

### D35. Inspector editor, submission and evidence files (accepted, 2026-10-03)
The T4 tier of INSPECTOR §2, and the evidence files of INSPECTOR §6 for what T2 can observe.
- **The editor edits authoring files**, not published profiles: what a pull request changes is
  `data/profiles/<brand>/<id>.json`, with its `extends`. Bases are never published, so the editor
  reads authoring files from the repository itself: from the local checkout through the dev
  server (`/data/`), and from `main` on `raw.githubusercontent.com` in production. Which bases
  exist comes from the published profiles' inherited sources (`via`), so no listing API is needed.
- **Checks are CI's.** The editor runs `packages/build`'s layout check and `validateSources` (Ajv
  over the bundled schemas, flatten, semantic rules) on the file and the files it extends, and
  `checkDatabase` against the bundle, as the user types. Issues carry lines, and a click selects
  the line.
- **Files are formatted like the repository's.** The form writes through Prettier (standalone,
  loaded on demand) with the repository's options, in the repository's key order, so a submitted
  file passes `npm run lint`; the test suite checks that this reproduces every file in `data/`
  byte for byte.
- **Submission is a link** (D19). A new file opens GitHub's "new file" page with the text in the
  URL; GitHub forks for people without write access. An existing file, or one too long for a
  URL (~8 KB), opens the edit or new-file page with the text on the clipboard. An issue with the
  file in it is the fallback. The app never calls GitHub's API.
- **Evidence files** record what the inspector saw, in the format of INSPECTOR §6. A read (T2)
  records the read-back and its findings. Before export, every string in the file is shown and
  can be changed or removed (the PII review); serial numbers and Bluetooth addresses are never
  read. Files are named `<date>-<6 hex of their SHA-256>.json` under `evidence/<profile id>/`.
  A pull request carries the profile; the evidence file is attached to it and committed by a
  maintainer (or both go in one commit, with git).
- **A read-back is `community` evidence.** It shows values the device holds, not the limits of
  what it accepts, so it supports widening a domain but can't verify one. SPEC §10's `community`
  row now says "without counting evidence" and names it. `evidence-missing` (a repository layout
  rule) now covers every source whose ref is under `evidence/`, not only probes and measurements.
- **Connect → editor.** The connect page hands the reviewed evidence file and the read-back to the
  editor in `sessionStorage`. The editor cites the file in `meta.sources` and re-checks the
  read-back against the profile as it changes. For a device the database lacks, it starts a
  profile with the device's USB identity as its `match` and the band count it returned.

**Rejected:** calling the GitHub API to open pull requests (needs a token or a backend, D19);
publishing authoring files and bases in the data channel (they aren't part of the format, and
consumers would see them); counting a read-back toward `community-verified` (one read says
nothing about bounds); a new source kind for read-backs (a format change that buys nothing over
`community` with an evidence file); a full schema-driven form (per-slot overrides, variants, rules
and laws are clearer in JSON, which stays the source of truth).

### D36. Format v1 frozen (accepted, 2026-10-03)
The owner froze the format as v1 (format `1.0`) at the end of Phase 4. SPEC.md (renamed from
SPEC-DRAFT.md) is now the v1 definition; it changes only by additive minors (SPEC §15), and
anything else needs v2 under a new prefix.
- **Exit criteria waived in part, by the owner.** PLAN's Phase 4 exit asked for ≥ 10 profiles at
  `community-verified` or better across every hard case, and a real HID device going connect →
  read → validate → prefilled PR. At the freeze, two profiles were verified (RME ADI-2 DAC FS,
  PEQ and Bass/Treble), and real devices (several Walkplay units) were identified and read, while
  the full flow ran only against a replayed capture. The owner judged that no further format
  change was needed. What the gate was meant to catch, a format gap found in real use, can still
  be fixed by a minor if it is additive.
- **Channels.** `/v1/` is built from `main` beside `/next/`. `/next/` keeps being served with the
  same data, so client 0.1.x (which defaults to it) keeps working; its profiles point at its own
  schema copy. The client defaults to `/v1/` from 0.2.0, the inspector reads `/v1/`, and releases
  attach `/v1/`'s `bundle.json`.
- **Still to do after the freeze:** the npm data package `@potatosalad775/eqcaps` (D32), and the
  verified profiles and real-hardware runs that Phase 4 carried (PLAN §7).

**Rejected:** dropping `/next/` at the freeze (breaks every 0.1.x client's default); keeping the
file name SPEC-DRAFT.md (a frozen definition called a draft misleads readers; links inside the
repository were updated, and old links to the file on GitHub break).

---

## Open questions for the owner

A new question gets a number, a recommendation and an entry here.

### Q11. Compact USB match entries? (open, 2026-10-02)
devicePEQ identifies Walkplay-chip devices as "vendor id in this list, product id in that list".
The format can only spell that as one entry per pair, which makes the index about 5× larger than it
needs to be and claims thousands of pairs that don't exist (D31).
**Recommendation:** leave the format as it is for now. 32 KB gzipped is acceptable, and the right
fix is data: as devices get identified, give them their real (vendor id, product id) and drop
pairs from the group profiles. If the index grows past ~100 KB gzipped, allow `productId` to be
an array in a `usb` entry (a v1 minor, additive). Alternatives: allow both `vendorId` and
`productId` arrays (more compact, but keeps encoding the non-existent pairs), or drop the group
profiles (loses most Walkplay devices).

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
