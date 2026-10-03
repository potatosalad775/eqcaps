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
*2026-10-03:* neither: `compensate2X` corrects a firmware quirk, not a unit, and realization left
the format. Nothing corrects quirks (D39).
*2026-10-03, later:* narrowed by D42. The per-device settings (handler, `reportId`, slot ids,
`baudRate`, `disconnectOnSave`) moved into the profile's `protocol` block, so a new device needs
no bridge release. The line now runs between data and code: the wire format (frames, commands,
scheme numbers, grids) stays in the bridge's handlers, and the engine never reads `protocol`. A
software-EQ app ignores the block as it ignores `match`.

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
Coefficient quantization stays out of scope. *2026-10-03:* realization is out of scope too (D39).
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
*2026-10-03:* part 1 no longer folds in constant factors such as KTMicro's ×2 or Walkplay's
×0.9775: they are firmware quirks, not units. Part 2 is withdrawn: `realization`, its laws,
`toRealized` and `toWritten` are gone from the format, which v1 never published with (D39).

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
(D29). *2026-10-03:* `toRealized`/`toWritten` removed again; the exact ops are `project`,
`resolveSlot` and `validate` (D39).
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
  ×0.9775). *2026-10-03:* not those either (D39).
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
  `compensate2X` a 2 Hz grid), per D29. *2026-10-03:* taken out again, along with the seeded
  `realization` blocks (D39). The script now writes the compensation settings as quirk warnings
  in the notes; it isn't re-run.
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
  *2026-10-04:* the seed wrote one match entry per (vendor id, product id or name) pair, 7,521 in
  all. They are now written as list-valued entries (D43), 117 in all, matching the same pairs. A
  device matched by name ties with its group at specificity 3 when the capture's exact pair isn't
  the one it is read under; the group now yields (D43).
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
  (D29). *2026-10-03:* `freqScale` is gone; codecs write the frequency as given (D39).
- **Push takes written values**, one per band in band order, normally `fit` then `complete`; the
  bridge does no fitting of its own, so INSPECTOR §4's raw push is the only push. The preamp is
  written only when given (Nothing sends it with the bands, so it is 0 when left out). A `preamp`
  or `slot` the write can't carry (`writesPreamp`, `writesSlot`) is an `invalid-request`: dropped
  silently, it would look applied.
- **Pull returns written values** in band order, `null` for a band that is off or unset, plus
  the preamp and slot where the protocol reports them. Protocols that read band by band take the
  count from the caller or the profile (`needsBandCount`). A chosen `slot` is refused where the
  protocol reads only the current preset (`readsSlot`), rather than answered with the current one.
- **Protocols are keyed by profile id.** *2026-10-03, superseded by D42:* profiles carry their
  protocol, and the table is gone. `PROTOCOLS` maps each hardware profile to its handler,
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
  range, grid or types, is listed. *2026-10-03:* the `freqScale` check is gone with `freqScale`
  (D39).
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
*2026-10-03, superseded by D42:* protocols are in the profiles, inherited from their base, so a
device profile under a group has its own through the base it extends.
*2026-10-03, later:* a device profile under a group (D37) has no protocol entry of its own: the
device also matches the group, whose protocol drives it. `protocolForMatches(matches)` returns the
protocol of the most specific matched profile that has one, so apps keep a single identity
answer (the client's matches) and contributors add devices with a data file alone. CI checks that
every hardware profile has a protocol, its own or one whose profile's match covers every entry of
its match, and checks the profile against that protocol's codec as for table entries.
*2026-10-03:* not every hardware profile has a protocol any more. The RME ADI-2 DAC FS profiles
(from RME's manual) describe a device controlled over MIDI SysEx, which no handler speaks. The
protocol test lists such profiles by id, so a missing protocol is always a decision.
*2026-10-03, later:* the owner recorded the vendor web apps of a NiceHCK PureAural
(app.nicehck.cn) and an OSHUN DECO writing 10 bands (WebHID traffic of their own devices). Both
compute coefficients exactly as the bridge does (RBJ, Q2.30, at 96 kHz, at the frame's own
frequency, no 0.9775 factor), but write differently from devicePEQ's convention, which the bridge
follows: band frames carry the preamp at byte 34 (bridge: 0) and 0 (OSHUN) or 3 (PureAural) at
byte 35 (bridge: preset 101); the PureAural uses `0x21` at byte 2 (bridge and OSHUN: `0x18`); the
save is `0a 04 00 00 ff ff`, then the preamp (OSHUN), or `0a…`, `01`, preamp, `04` (PureAural),
where the bridge sends `05 00`, `17 00`, `0a … 00`, `01 01 00`. `80 0c` answers a firmware
version (`"0.3"`, `"0.4"`). The bridge's 10-band writes left the PureAural unchanged. Its app
offers far more than Walkplay's (gain level, amplifier class, volume, mic gain, balance), so it
is treated as its own device, not a Walkplay variant. Protocol options from these captures and
device profiles for both are for a later session.
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
*2026-10-03, later:* Connect's outcome follows the match. Against a group profile (D37) it offers
"Add my device" first: a new profile extending the group's base (SPEC §3), prefilled with the
device's USB identity and the evidence, so only brand, model and id are left to write. The
protocol comes from that base (D42), so the new profile needs no code. Group profiles carry a
badge in search, on their page and in the match list.

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
  read → validate → prefilled PR. At the freeze, no profile was verified, and real devices
  (several Walkplay units) were identified and read, while the full flow ran only against a
  replayed capture. The RME ADI-2 DAC FS profiles (PEQ and Bass/Treble), written from RME's
  manual, were briefly marked `community-verified` and set back to `draft` the same day: nobody
  had reviewed them or tried them on a device, and they rest on assumptions the manual doesn't
  settle. The owner judged that no further format
  change was needed. What the gate was meant to catch, a format gap found in real use, can still
  be fixed by a minor if it is additive.
- **Channels.** `/v1/` is built from `main` beside `/next/`. `/next/` keeps being served with the
  same data, so client 0.1.x (which defaults to it) keeps working; its profiles point at its own
  schema copy. The client defaults to `/v1/` from 0.2.0, the inspector reads `/v1/`, and releases
  attach `/v1/`'s `bundle.json`.
- **Still to do after the freeze:** the npm data package `@potatosalad775/eqcaps` (D32), and the
  verified profiles and real-hardware runs that Phase 4 carried (PLAN §7).

*2026-10-03, amended before first publication:* `device.group` (D37) joined format 1.0 rather
than a 1.1 minor. Nothing had been published under `/v1/` yet, and a new format's first profiles
declaring 1.1 would only confuse.
*2026-10-03, amended again before first publication:* `realization` left format 1.0 (D39), for the
same reason.
*2026-10-03, amended before first publication:* the evidence-ref rule covers every `ref` that
starts with `evidence/` (D41), for the same reason.
*2026-10-04, amended before first publication:* match fields take lists, and group profiles yield
at equal specificity (D43); presets may be marked `bypass` (D44). Same reason.
*2026-10-04, later:* **`/next/` is dropped.** Nobody uses client 0.1.x, the only reader of
`/next/`, and keeping it meant a second build with match lists expanded (D43) for no one. The
build writes `/v1/` only, the next deploy stops serving `/next/`, `NEXT_URL` leaves the client
(0.2.0), and 0.1.0 of `core` and `client` is deprecated on npm. A 0.1.x client still running
finds no data and matches nothing, which it handles like being offline (invariant 8). This
reverses the rejection below.
**Rejected:** dropping `/next/` at the freeze (breaks every 0.1.x client's default); keeping the
file name SPEC-DRAFT.md (a frozen definition called a draft misleads readers; links inside the
repository were updated, and old links to the file on GitHub break).

### D37. Group profiles are marked in the data (accepted, 2026-10-03)
Some profiles stand for many products their match can't tell apart: Walkplay's per-scheme
profiles (vendor/product id pairs from devicePEQ, D31), the chip-named Walkplay profiles whose
product names ("CS43131 HiFi Audio DSP", "ES9039 ") are firmware defaults that white-label
dongles of many brands report, and KT Micro's KT0211L group. `device.group: true` says so (SPEC §2,
§3), and the index carries it.
- **Why data, not a guess.** "The device reports a product name and the matched entry has none"
  also fires on device profiles that must match by ids (RME's product name carries the serial
  number), and misses groups matched by a shared name. Every consumer would re-derive it
  differently.
- **Matching doesn't change.** A device profile with a more specific entry wins by specificity.
  The flag lets apps tell the user the match is generic, and lets the inspector offer to add the
  device rather than only to fix the group.
  *2026-10-04, superseded by D43:* matching does change: at equal specificity a group profile
  yields to a device profile. A device matched by name ties with a group matched by product id
  (both 3), which happened for 109 of the 210 (vendor id, product id, name) combinations the seeded
  device profiles claim.
- **Device profiles extend the group's base**, not the group: groups shrink as devices get their
  own profiles (Q11) and may be deprecated.
- **Hardware only** (the schema forbids it on software profiles, which are selected by id), and
  never inherited, like the rest of `device`.
- 17 seeded profiles are marked: the ten `walkplay-schemeno*-devices`, the six chip-named Walkplay
  profiles, and `kiwi-ears-kt0211l-devices`.

**Rejected:** inferring groups from match shape (above); a top-level field or a `kind` value (a
group is still one hardware engine, and `kind` already means hardware vs software); the names
`generic` (sounds like a quality judgement) and `family` (suggests a chipset family, while some
groups are a firmware scheme or a shared product name).

### D38. Probe mode: engine, strategy and evidence (accepted, 2026-10-03; removed, D40)
*2026-10-03:* removed the same day, with the `probe` source kind (D40). Kept as the record of what
was built and why.
T3 of INSPECTOR §3: experiments that push test values and read them back to learn what a device
accepts, then restore the user's EQ and confirm it.
- **Where it lives (owner's choice).** The engine is plain TypeScript in the inspector,
  `apps/inspector/src/lib/probe/`: planner, inference, engine, derivation, comparison, evidence
  and a `FakeDevice`. It drives anything with the bridge's `pull`/`push` and capabilities
  (`ProbeIO`), so a `BridgeDevice` and the fake are interchangeable. The bridge gains only offline
  codec analysis: `analyzeCodec(protocol)` (band counts a write takes, coded types, each field's
  wire range and resolution as a domain, null for unbounded floats) and `handlerCodeUrl`.
- **Handler-code drafts (owner's choice).** No script writes `handler-code` sources into `data/`.
  A device the database lacks, taken to the editor from Connect without a probe, starts from its
  protocol's wire limits, cited as `handler-code` at the app's commit; float fields the wire
  doesn't bound keep the editor's placeholders, and the notes say so.
- **Every slot at once, with a canary.** Each push carries one test value per band. Each band
  also flips a "canary" field (gain, else Q) between two values it was seen to keep, so a band
  that took the write is told from one that refused it, whatever happened to the test value. A
  push where no canary landed is repeated with one band left out: if that band's canary lands,
  bands are refused one by one and the push stands; if not, the device refuses whole writes, and
  from then on bands are probed one at a time, each starting from the bounds the band before it
  ended on (two writes per bound when bands agree).
- **Steps first, then bounds, then a check.** Steps are inferred from values just off each band's
  base (they stay inside partitioned windows): the largest known step or GCD of stored values
  that explains every pair, rounding to nearest or truncating; a float wire storing values as
  sent is continuous. A pair stored at the edge of its band and moved further than the candidate
  grid's rounding may be a clamp and may go unexplained. Bounds are searched from a hint (the
  matched profile's bound, or the previous band's), then the search limit, then common values
  (±12 dB, 20 Hz…), then the grid. After the bounds, values spread across each band's window
  check the grid; clamps are then known exactly (stored at a bound, sent past it). A finer grid
  re-searches the bounds; none at all (a set the device snaps to) becomes a sweep. Value-list
  wires (Edifier) are swept directly.
- **Search limits.** Gain and preamp ±30 dB, Q 0.01–100, frequency 1 Hz–40 kHz, each within the
  wire. A bound the device accepts at the limit is reported as "at least", in the notes.
- **Band count** by codes: gains −1 to −4 dB, one base-4 digit of the band's index per push plus
  one push changing every band, over the bands that read back (reads past the count are searched
  first, without retries). Bands are counted from the first while each read back its own code.
  The count is exact when reads stop or the device reports it, otherwise "at least".
- **Order after the windows.** A device that wants ascending bands makes each band's window stop
  at its neighbours' frequencies when probed band by band; that pattern is the rule (strict when
  one step short), and the first band's minimum and the last band's maximum then stand for all.
  Otherwise descending frequencies inside the shared window tell kept (no rule), sorted
  (`reorders`, emitted as a rule so read-backs stay in step) or refused (then two equal
  frequencies tell strictness). Frequency test values ascend with the band index throughout.
- **Conditions:** the window again with a +2 dB boost and with each other kept type; different
  windows become variants (types with equal windows merge into `in`). Bands alike so far are
  checked on the first and last band only, and all of them if those two disagree.
- **Silent resets** show as fields nobody changed (base or canary) changing on half the bands or
  more. INSPECTOR §3.5 says "reported, not interpreted"; the engine reports each one and also
  re-tests the bands of that write one by one, counting the value that reset the device as
  refused. Without that, a reset to 0 dB reads as a clamp at 0 dB.
- **Backup and restore.** The backup is read before the first write, shown and downloadable
  while the probe runs. Restore is attempted after any write, on every path (done, stopped,
  failed), retried once, and confirmed by reading back; a band that was off is restored flat and
  counts as restored if it reads back off or at 0 dB. A failed restore keeps the backup open on
  screen with instructions. Devices that disconnect on save aren't probed: there is no automatic
  reconnection yet (INSPECTOR §3.1).
- **Derivation.** Per-band findings become a template plus grouped overrides (each key's most
  common value), variants, the ordering rule and the preamp. What wasn't probed (a quick probe's
  Q, frequency and types) comes from the matched profile, else the wire, and the notes say which.
  `constraintDiff` compares profiles by what they accept, not how they're written.
- **Evidence.** INSPECTOR §6's file, with `probe` (mode, writes, why it stopped), `backup`,
  `backupRestored`, the experiments' pushes and conclusions, `derivedProfile` (constraints only:
  the profile cites the file, so the file can't cite the profile) and `notes`. Filters in pushes
  are `[type, freq, q, gain]` tuples, one push per line; read evidence is unchanged. The PII
  review skips what the app generated (pushes, conclusions, backup, derived constraints). A
  profile cites it as a `probe` source, which counts (SPEC §10); a fix or a new profile gets the
  derived constraints, overriding what it extends.
- **Safety UX** (INSPECTOR §3.4): preconditions listed, planned writes shown, a hearing checkbox
  and a second confirmation before the first write, ≥ 100 ms between writes, a stop button that
  restores, EQ commands only. The page asks to stay in front: browsers throttle background tabs'
  timers, which stretches a probe from seconds to many minutes.
- **Tests.** `FakeDevice` puts a real codec in front of firmware that accepts what a profile says
  (clamping or refusing, coercing types, refusing whole writes, NAKs, silent resets, sorting,
  disconnecting). Probes derive the seeded Walkplay profile, every hard case (type- and
  frequency-partitioned, stepped, graphic, value set on a float wire, conditional, both ordering
  behaviours), the JDS Labs profile, and lossless firmware over five codecs; every failure path
  restores or says it couldn't; and a fast-check property over random firmware (partitions,
  boost windows, all failure modes) passed 2000 cases. Typical writes over those: clamping 53,
  refusing 90, whole-write or resetting devices about 100 (clamping) to 260 (refusing), at most
  about 600 for twelve refusing bands. The connect page was run end to end in Chrome against a
  fake WebHID device speaking the Walkplay protocol: full probe in 68 writes (estimate 132), EQ
  restored and verified, a preamp range different from the seeded profile found, and the result
  taken to the editor as a new profile.

*2026-10-03, after the first real devices:* the owner probed a NiceHCK PureAural and an
OSHUN DECO (Walkplay protocol), which changed four things.
- **Devices that don't check what they're sent.** Both kept every value up to the search limits
  in every field. Walkplay writes carry the bridge's biquad coefficients plus a copy of the band's
  parameters, and read-back returns that copy, which the firmware stores without checking. A
  field taken at both search limits now says nothing: the matched profile's range is kept, with
  a note. When that holds for every field probed, the derivation is `unchecked`: the notes start
  with a warning, the page says so, and the evidence file is cited as `community`, not `probe`.
- **Band count by the largest write that lands.** The PureAural's 10- and 16-band writes changed
  nothing while 8-band writes were kept, yet its vendor app writes 10 bands. So when a write
  changes nothing, smaller writes are tried (the profile's count, then halving), one push each,
  each with values the bands don't hold yet. The count found is reported with the write limit
  ("may be the device, or the way this protocol writes"), never as the device's count, and the
  restore writes a size that was seen to land. Reads past the count can return stale buffers
  (Walkplay answers carry bytes of earlier answers), so reads answering is no proof of bands.
- **No conditions from limits.** Two windows that both reach the search limits are the same.
- **Readable output.** Notes and differences are grouped across bands ("in every band", "bands
  1–4, 6"); reads that go unanswered are retried twice (0.5 s, 1.5 s) before the probe stops.
Tested with a `FakeDevice` that ignores writes over 8 bands and one that drops every ninth read.
Write counts are unchanged.

**Rejected:** the engine in the bridge or a package of its own (owner's choice: the inspector,
INSPECTOR §5); a script writing `handler-code` sources into `data/` (owner's choice); probing
each band separately from the start (×bands writes for every device, not only the few that need
it); whole-set detection by an extra known-good write per push (the canary costs nothing);
inferring steps from values spread over the spectrum before the windows are known (partitions
clamp them into fake grids); reading a reset as a clamp, or stopping at the first one; treating a
band count that reads stop at as "at least".
**Open:** the exit's real-hardware runs (three handler families; the owner has Walkplay units;
on Walkplay a probe settles the band count and stored grid, not ranges),
reconnection for devices that disconnect on save (KT Micro), conditional Q and gain domains (only
frequency windows are probed), and whether a group member's file should keep only the constraints
that differ from its base.

### D39. No calibration: the format describes what a device is told, not how it sounds (accepted, 2026-10-03)
The owner read a CrinEar Protocol Micro (USB `0x3302:0xc20f`, Walkplay SchemeNo11) with the
inspector. It showed 48.88, 195.5, 488.75 … Hz where the official Walkplay app and CrinEar's own
app show 50, 200, 500 …. The device stores 50, 200, 500 …; the profile had devicePEQ's ×0.9775
folded into its domains (D29 part 1), so the codec scaled every value it read and wrote.
- **Domains hold the value the engine is told**, as its own software means it, in canonical
  units. Unit conversions (register value → dB, octaves → Q) are still folded in. A difference
  between the value sent and the filter heard is never folded in, constant or not (SPEC §1, §8).
- **Realization leaves the format.** `realization` and its laws (`gainScaledQ`,
  `nyquistScaledQ`, `shelfFrequencyShift`) are gone from the schema, and `toRealized`/`toWritten`
  from core (SPEC §8 and §13.3 are kept as stubs, so section numbers don't move). `fit` returns
  written slots only, and `Change.realized` is now `Change.written`. The issue codes
  `law-conflict` and `design-rate-too-low` and their cases are gone; a case pins that
  `realization` fails the schema. Nothing had been published under `/v1/` yet (D36); core 0.1.0
  on npm has these exports, and its next release, 0.2.0, drops them.
- **Quirks are warnings.** A reported quirk goes in `meta.notes`, starting "Reported quirk, not
  corrected (D39):", saying what was reported and by whom.
- **Codecs write the value as given.** `freqScale` is gone from the Walkplay and KT Micro codecs.

**Why:**
- The evidence is thin. SchemeNo11's ×0.9775 and Q law come from one EPZ TP13 measured at two
  frequencies, applied by devicePEQ to 135 product ids; its comments derive a design rate
  (about 49152 Hz) its config contradicts (96000). The JCally KT02H20 profile halved frequencies
  while devicePEQ's own capture of that device was recorded with the halving off.
- Firmware versions and vendor customization change such behaviour without notice, and nothing
  the project collects except acoustic measurement sees it: read-back, probes and vendor apps all
  see the value sent. A domain with a factor folded in could be marked verified by a probe that
  never saw the factor.
- Vendor apps don't correct. A correction applied to firmware that doesn't need it makes the
  sound worse, where the user can't see why.
- The same holds for the laws that depend on another field: the evidence is devicePEQ's
  configuration, never a measurement in this repository, and a consumer running `fit` would change
  what it sends on their account.
- The cost was real (a closed set of laws in the schema, two exact ops, written and realized
  filters in `fit`, codec options, fractional grids, provenance in two places, a "You hear"
  column) and no consumer depended on it yet.

**Changes:** `realization` removed from 7 profiles (FiiO KA17 and QX13 `gainScaledQ`; Fosi Audio
DS3 `gainScaledQ` and `shelfFrequencyShift`; the SchemeNo11 group, Walkplay CS43131, EPZ TP13 and
Moondrop Quark2 `nyquistScaledQ`). The last four lost their 0.9775 Hz grid and the KT02H20 its
2 Hz grid; all take their base's 20 Hz–20 kHz in 1 Hz. Their notes carry the reported quirks. The
recorded SchemeNo11 captures now read round frequencies (1000, 10000, 20000 Hz, where they read
977.5, 9775, 19550), and one capture's band no longer falls outside its profile.
The fit vector for a long cycle of passes relied on `shelfFrequencyShift`; it was replaced by a
law-free profile that needs 9 passes, found by a random search.
**Rejected:** a constant `freq` scale law (still a correction, still visible only to measurement,
still firmware-dependent); keeping the laws in the format with no data using them (a feature
nobody can fill honestly, and dead weight in every port); keeping the seeded laws marked
unmeasured (a consumer that runs `fit` still changes what it sends).

### D40. The inspector never writes to a device; guided reads replace the probe (accepted, 2026-10-03)
The owner probed a CrinEar Protocol Micro (Walkplay SchemeNo11, 8 bands) with the D38 engine. The
backup read 14 bands, since reads past the count answer, so the band-count experiment wrote 14,
then 11 to 13. Every write past 8 bands corrupted what bands 1–10 read back (`x-wire-*` types,
43557 Hz, ±90–120 dB), while a write of 8 read back exactly. The search counted a write as landed
when any band kept its value, and bands 11–13 store whatever they're sent, so it was fooled. The
restore then wrote 13 bands, the last size tried, and failed; the owner had to repair the EQ in the
vendor app. Fixes were drafted (cap writes at the profile's count, require the first band, restore
at a size seen to read back exactly) and dropped for this decision.
- **No writes.** The inspector calls the bridge's `pull` only. The probe engine
  (`src/lib/probe/`), `ProbeWizard.svelte`, the probe handoff and the probe evidence fields are
  removed. The bridge keeps `push` for apps, and `analyzeCodec`, which the editor's wire-limit
  drafts use.
- **No `probe` source kind.** It named evidence only the probe made. v1 is not published yet, so
  it leaves the format: SPEC §10, the schema, and `COUNTING_SOURCE_KINDS`; the evidence-ref rule
  covers `measurement` only. Conformance cases that used it use `measurement`.
- **Guided reads (T3), planned** (INSPECTOR §3, PLAN Phase 5): the user changes the EQ in the
  vendor's app as the inspector asks, and the inspector reads back after each step. The vendor
  app keeps every value inside its own limits, and those limits are `vendor-app` evidence.

**Why:**
- The risk falls on the user's hardware and hearing, and every firmware quirk is a new failure
  mode. The tests could only cover the quirks already known.
- What a probe learns is what firmware stores, not what it handles: Walkplay stores anything
  (D38's own finding), so probes there learned band counts, which is what broke this device.
- The vendor app's limits are the better evidence for a profile: they are what the vendor
  supports, and they count already (SPEC §10).
- It removes the largest piece of the inspector (about 3,900 lines) and its safety gate, and
  invariant 9 becomes "the inspector never writes".

**Open, for the guided-read session:** how a guided read is cited (`vendor-app` with an evidence
file `ref`, which extends the evidence-ref rule, or a kind of its own; a format change to make
before `/v1/` is published); its evidence file's shape; and whether the vendor's web app and the
inspector can hold the same HID device at once (INSPECTOR §3.4).
**Rejected:** keeping the probe with the drafted fixes (they close this failure, not the next
firmware's); keeping it behind a developer flag (code nobody runs rots, and the risk is the same
for whoever enables it); keeping the `probe` source kind for a future tool (nothing produces it).
*2026-10-03:* the open questions are answered in D41.

### D41. Guided reads: cited as `vendor-app`, one experiment per step, the device shared (accepted, 2026-10-03)
The owner settled D40's open questions before `/v1/` was first published.
- **Citation.** A guided read is a `vendor-app` source whose `ref` is its evidence file. The
  evidence-ref rule (SPEC §10, `evidence-ref-invalid`) now covers any source whose `ref` starts with
  `evidence/`, whatever its kind; `measurement` refs must still be evidence files, and other kinds
  may still describe what was seen in text ("JDS Labs Core app 1.2, EQ page limits"). CI already
  checked that every `evidence/` ref exists, whatever its kind. This makes the rule stricter, so it
  joins format 1.0, as D37 and D39 did.
- **Evidence file.** The T2 file (INSPECTOR §6), plus a `vendorApp` block (`name`, `version`,
  `platform`, typed by the user and shown in the PII review), and one experiment after the first
  `read` per step: the instruction, the band, field and what was asked, the **full** read-back,
  what changed since the previous read, and the conclusion (a bound, a step, a type code). A
  skipped step is recorded as skipped; a redone step is a new experiment, and the last one counts.
  The final `restore` step lists what differs from the first read. The file ends with the
  `constraints` the steps established and `notChecked`. `evidenceVersion` stays 1: the file isn't
  part of the format, and a T2 file is unchanged.
- **Sharing the device.** Checked on a CrinEar Protocol Micro (Walkplay, `0x3302:0xc20f`) with
  Walkplay's web app (`peq.szwalkplay.com`), Chrome 154 on macOS: the vendor tab and the inspector
  held the device open at once, in either order (the vendor app disconnected and reconnected while
  the inspector held it). The vendor app writes on every change, with no save step, and the
  inspector's reads saw each change at once: band 1 gain 0 → 3 → 10 (the app's maximum, matching
  the group profile) → 0, and the final read matched the first exactly. The vendor app showed no
  errors after the inspector's reads. The owner changed the preamp by hand during the run, which
  a read showed as a change outside the step, so change detection reports every change, not
  only the asked one.
  The page therefore keeps its connection when the vendor app is in another tab, and still
  supports the worst case (a phone or desktop app): one read per step, reconnecting a granted
  device without the chooser and checking its identity.

*2026-10-03, later:* the first guided read (CrinEar Protocol Micro, Walkplay's web app) showed
that an app's buttons don't always show its grid: the ± buttons moved gain and Q by 0.1, while a
typed value reached the device at the wire's 1/256 resolution. The grid check now decides it
(INSPECTOR §3.3): an app that passes typed values through gets the wire's step and the bounds the
device holds; without a typed value, the app's step stands, since nothing the vendor offers sends
finer values. Conclusions in the evidence file are the values as read; the interpretation is in
`constraints` and `notes`.
**Why:** the evidence is the vendor app's limits whichever way they were seen, so a new kind
would add an enum value consumers must handle without telling them anything the file doesn't;
full read-backs let a reviewer recompute every conclusion and see that the other bands stayed
put, at about 10 KB for a whole run.
**Rejected:** a `guided-read` source kind (a kind only our tool produces, which D40 removed `probe`
for); requiring every `vendor-app` ref to be an evidence file (most vendor-app evidence is a
manual reading of the app's UI, with nothing to file); storing only the changed values per step
(smaller, but a reviewer can't check that nothing else moved).

### D42. Profiles name their protocol; the bridge has no per-device table (accepted, 2026-10-03)
Adding a device the bridge already speaks to meant a line in the bridge's `PROTOCOLS` table
(`src/protocols.ts`, from devicePEQ's per-device configs) and so a bridge release before any app
could drive it, although its profile was already on the CDN. Of the table's 95 entries, about 60
only repeated what the profile's base already said (every profile under a `walkplay-peq-*` base
used `walkplay-hid`, every `moondrop-peq-*` one `moondrop-usb-hid`, with no exception); the other
~35 held real per-device settings (FiiO preset slots, report ids and save commands, KT Micro band
registers, disconnect on save). D37 helped only devices that match a group profile.
- **`protocol` in the profile.** A hardware profile MAY carry `protocol`: the bridge handler id,
  the handler's `options` for this device, its `presets` (EQ memories, id and name),
  `disconnectOnSave`, `baudRate` and `experimental` (SPEC §9). The engine never reads it. It is
  inherited like `band`, merged per key, so a base names the handler (and the presets every
  device under it shares) and a device file adds only what differs. Every table entry moved into
  the data; the protocols the bridge derives from the data equal the table's, entry for entry.
- **The bridge reads it.** `protocolOf(profile or index entry)` checks the block against the
  handlers the installed bridge has: an unknown handler (data newer than the bridge) or an option
  the handler doesn't take gives undefined, never a guess. `protocolForMatches` takes the client's
  matches and returns the first drivable one, as before. `protocolFor(id)` and `PROTOCOLS` are
  gone. Options that are wire numbers may be written as hex strings (`"0x21"`), as USB ids are.
  The handler vocabulary (ids and options) is the bridge's, documented in its README, and checked
  by the bridge's tests over every profile; the format defines only the envelope.
- **The index carries `protocol`**, so an app drives a matched device and filters a browser
  chooser from `index.json` alone, offline from the bundle too (invariant 8).
- **Invariant 2 restated.** Profiles still never say *how* to talk to a device: no frame layouts,
  command bytes, scheme numbers or wire grids. Those stay in the bridge's handlers. What moved is
  the per-device *selection* of a handler and its settings, which is a fact about the device like
  its USB identity, and which the bridge can't know without a release.
**Why:** a device on a known protocol is now a data file only: a contributor (or the inspector's
"Add my device") writes the profile, CI checks it against the codec, and the deployed bridge
drives it once the data is published. A new bridge release is needed only for a new handler,
which is new code anyway. Inheritance removes the 60 redundant entries rather than moving them.
*2026-10-04:* the "EQ off" preset is no longer a handler option (`disabledPresetId`,
`disabledSlot`) but a `bypass` mark on the preset itself (D44), and the Walkplay and FiiO USB HID
bases share a protocol-family base (D44).
**Rejected:** a `device.platform` field mapped to handlers in the bridge (removes the redundant
entries, but FiiO's per-device slots and options would still need a release); generating the
table from the profiles' bases at build time (still a release per device, and couples the bridge
build to authoring files); separate protocol files beside the profiles (two files and a second
inheritance mechanism per device); defining every handler's options in the profile schema (ties
the format to the bridge's handler list; the bridge validates its own vocabulary).

### D43. Match fields take lists; group profiles yield at equal specificity (accepted, 2026-10-04)
devicePEQ identifies a chip family as "vendor id in this list, product id in that list" (19 Walkplay
vendor ids, up to 135 product ids per firmware scheme). Format 1.0 could only spell that as one
entry per pair, so the seed (D31) wrote 7,521 USB entries, 2,565 of them in one profile, and
match data was 334 KB of the 376 KB `index.json` every app downloads. Q11 deferred it.
- **Lists.** `vendorId`, `productId`, `productName`, `name` and `namePrefix` take one value or a
  non-empty list of distinct values (SPEC §3). A field holds if any listed value matches, and an
  entry stands for every combination of its fields' values: lists are notation, not new
  semantics. Specificity counts the fields an entry has, as before. The collision check expands
  entries and compares combinations (`expandUsbMatch`, `expandBluetoothMatch` in core).
- **The data.** Every profile's entries were regrouped by product key and vendor set and checked to
  expand to exactly the pairs they replace: 7,521 entries became 117, the index 376 KB → 61 KB and
  the bundle 488 KB → 161 KB.
- **Groups yield.** At equal specificity a non-group profile beats a group profile (`device.group`,
  D37); a tie between two device profiles or two groups is still a choice. Before, a device
  profile matched by vendor id and name (3) tied with its scheme group matched by vendor id and
  product id (3) whenever the device was read under a vendor id other than its capture's: 109 of
  the 210 such combinations in the seed were ambiguous. Now all 210 resolve to the device.
- **`/next/` stays single-valued.** Client 0.1.x reads `/next/` and compares fields with `===`, so a
  list would silently match nothing. The build writes that channel with `--single-valued-match`.
  The bridge's chooser and the inspector read lists.
  *2026-10-04, later:* `/next/` is dropped instead (D36), and the flag with it.
**Why:** the pairs a list claims are the same pairs the expanded entries claimed (most of which
don't exist, D31); the format just stops making that cost 5× the index. Lists in every field,
not only `productId` as Q11 suggested, because name variants (`"FIIO BTR17"`, `"BTR17"`) under
FiiO's two vendor ids are the same shape. The tie was a consequence of the same encoding: a
group's pairs reach into vendor ids its members' captures never used.
**Rejected:** named vendor sets defined once and referenced from entries (a second mechanism, and
`match` is never inherited, D3); inheriting `match` from bases (provenance of identity shouldn't
transfer silently, SPEC §11); ranking `productId` above `productName` (the order is arbitrary, and
groups match by name too: "CS43131 HiFi Audio DSP"); dropping the group profiles (loses most
Walkplay devices).

### D44. The bypass preset is marked in the data; protocol-family bases (accepted, 2026-10-04)
Two leftovers of devicePEQ's per-device configs, after D42.
- **`bypass` on a preset.** devicePEQ names the preset that turns the EQ off in a handler option
  (`disabledPresetId`) beside the preset list, which on 18 of 21 devices already held that
  preset ("BYPASS", "Close EQ"); on 3 the id wasn't in the list. A preset now says it with
  `"bypass": true` (SPEC §9), at most one per list (schema `maxContains`). Apps learn which preset
  is the off switch without knowing handler options, and the bridge passes it to the handlers
  that switch EQ off by preset (`fiio-usb-hid`, `ktmicro-usb-hid`) instead of an option; others
  refuse a bypass preset. The three missing presets were added as "Close EQ", the name other FiiO
  models give it, noted as assumed.
- **Protocol-family bases.** The shape bases came from devicePEQ's `peqConstraintsConfig.json`
  (`walkplayPeq8Band10dBFullShelves`) and each repeated its vendor's wire grids, preamp and,
  since D42, its handler. `walkplay-hid` and `fiio-usb-hid` now hold those, and the shape bases
  extend them with only band count, types and what differs (FiiO's wide gain, presets). The
  handler's `handler-code` source moved with them. Single-shape vendors keep one base.
- **Device files inherit `kind` and `schemaVersion`**, and the seed's per-device boilerplate note
  ("Seeded from devicePEQ…") is gone: `draft` and the inherited `handler-code` sources say it.
  Apart from the bypass marks, the flattened profiles are unchanged except for notes and the
  order of inherited sources.
**Rejected:** merging preset lists by id across `extends` (FiiO lists differ in order, names and
gaps, so it would need a way to delete entries, which costs more than the 341 entries it saves);
keeping `disabledPresetId` beside a `bypass` mark (two ways to say one thing).

---

## Open questions for the owner

A new question gets a number, a recommendation and an entry here.

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
| Q10 Written vs realized values | domains are written values; realization laws in profiles from v1 (removed again, D39) | D29, D39 |
| Q11 Compact USB match entries (answered 2026-10-04) | lists in every match field, in format 1.0 | D43 |
