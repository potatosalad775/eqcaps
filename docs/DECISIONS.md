# Decisions

The design decisions that shape eqcaps today, each with its main reason. Numbers are stable: code
comments and other docs cite them (`D39`). The full log, with what was rejected, dated amendments
and the decisions since superseded or removed (D23, D29, D31, D38), is archived in
[history/decisions.md](history/decisions.md).

To change a decision, edit its entry here with a dated note, and update [SPEC.md](SPEC.md) in the
same change if the format is affected. A new decision takes the next free number (D49).

---

## Scope

### D1. Standalone, vendor-neutral project
The format, data, engine, distribution and inspector live in their own repository; every app is
one consumer among several. A format owned by one app gets shaped by that app's UI.

### D2. Constraint data ≠ wire format
Profiles say which values an engine accepts. How bytes are laid out on the wire (frames, commands,
scheme numbers, wire grids) is the device bridge's handler code. A profile may name the handler
that drives it and that handler's per-device settings (D42); the engine never reads them.

### D3. Profiles are device-keyed; sharing through `extends`
One profile per EQ engine, so lookups are device-first. Chip families share an `abstract` base
through `extends`, which the build flattens, so consumers never resolve indirection.

### D16. Software EQ targets are first-class
`kind: software` profiles (Poweramp, Spotify, USB Audio Player Pro, …), with `bandCount: null`
allowed. Apps target software EQs as often as hardware.

### D27. Android consumer: a Capacitor app on the TypeScript stack
uniPEQ is a SvelteKit + Capacitor app, so it runs the TypeScript engine and bridge from npm and
embeds a `bundle.json` snapshot for offline use. USB goes through a native plugin that stays
protocol-free (enumerate, open, reports or transfers, close); all device logic stays in the
bridge's codecs. That is why the bridge's transports have no browser types. On Android the plugin
claims a HID interface the kernel already holds with `force`.

---

## Format

### D4. Template + override, replace-merge
A slot override replaces a key, never deep-merges it: a merged `{min,max}` + `{step}` would make a
grid nobody wrote (SPEC §5.2).

### D5. Domain forms and tolerance
Grids of 1/14, 1/3 and 1/4096 exist, so equality uses a tolerance. Non-uniform grids are
enumerated with `values`, which covers lookup tables, ISO bands and log grids at once (SPEC §4).

### D6. Variants: per-field first match, acyclic
An evaluation order and an acyclic dependency graph make projection deterministic in any language
(SPEC §6).

### D7. No `mode`
"Graphic" is derived (every slot's frequency is fixed), which also covers hybrids.

### D8. Slot assignment is an explicit operation
Apps hold filter lists; engines have slots. `assign` maps one onto the other, by order on
homogeneous engines and by matching otherwise: JDS Labs fills by type, partitioned devices by
frequency (SPEC §13.5).

### D11. Closed rule set, no expression language
v1 has `ascendingFrequency` and `minSpacing`. New rules arrive as minors with defined semantics;
unknown rules are surfaced, never ignored. An expression language would have to be implemented
identically everywhere.

### D13. JSON Schema is the structural source of truth
`profile.schema.json` is hand-written; `scripts/codegen.ts` derives `source.schema.json` and the
TS types, and `npm run check` fails on drift. Every language can read JSON Schema. A semantic
validator in `core` covers what the schema can't, and Ajv lives in `packages/build` so `core` has
no dependencies. Format fixtures are RFC 7386 merge patches over one valid profile.

### D14. Published files are flat; consumers are lenient
`extends` is resolved at build time. Consumers ignore unknown keys and never run the strict CI
schema, so new minors don't break old apps.

### D17. Provenance
`meta.sources[]` says where each claim comes from, by kind. Handler code shows only what the wire
carries, which can differ from what firmware accepts, so users need to know which kind of claim
they're trusting. Evidence files live in `data/evidence/`.

### D22. Filter types are Equalizer APO's codes
`PK LSC HSC LPQ HPQ BP NO AP`, with RBJ semantics, so Equalizer APO and AutoEQ text maps 1:1.
`LSC`/`HSC` are shelves by centre frequency, the cookbook's f0. modernGraphTool's and devicePEQ's
`LSQ`/`HSQ` are converted at the boundary, never in profiles.

### D28. Verification levels and governance
`draft`, `community-verified` (a contributor supplied counting evidence and a maintainer reviewed
it), `maintainer-verified` (a maintainer checked it on their own hardware or against vendor docs).
Sources inherited through `extends` never count. Every merge needs one maintainer's approval;
`schema/`, `docs/SPEC.md`, `packages/core/` and `.github/` also need a code owner. There's no
maintainer list: the approving maintainer checks `by`. Rules in SPEC §10.

### D36. Format v1 frozen (2026-10-03)
SPEC.md is the v1 definition. It changes only by additive minors (SPEC §15); anything else waits
for v2 under a new URL prefix. `/v1/` is the only channel served; the pre-freeze `/next/` was
dropped on 2026-10-04 along with client 0.1.x.

### D37. Group profiles are marked in the data
`device.group: true` marks a profile that stands for many products its match can't tell apart
(Walkplay firmware schemes, chip-named white-label dongles). Apps can say a match is generic, and
the inspector offers to add the device. Device profiles extend the group's base, not the group.

### D39. No calibration: profiles hold what a device is told
Domains hold the value the engine is told, as its own software means it. Unit conversions are
folded in; a difference between that and what the filter sounds like is not, constant or not.
Reported quirks go in `meta.notes` as warnings. **Why:** the evidence for corrections was thin,
firmware changes them without notice, only acoustic measurement can see them, and vendor apps
don't correct. A correction applied to firmware that doesn't need it makes the sound worse.

*2026-10-28:* the vendor's app comes first. Where it converts a value on the way to the device,
that conversion is the wire format: the handler does the same, as a `protocol` option on the
profiles of the devices the app converts for (D42), and the domain stays in the app's units.
Tanchjim's app sends its Zero, One and Tanya DSP half the frequency (`freqUnit: 2` on
`ktmicro-usb-hid`). A correction no vendor app makes is still only a note. **Why:** the vendor's
app is how the device is meant to be driven; a conversion it applies is one its firmware expects.

### D42. Profiles name their protocol
A hardware profile may carry `protocol`: the bridge handler, its options, its presets, and
transport details (SPEC §9). It is inherited from the base, so a device on a protocol the bridge
already speaks is a data file only, with no bridge release. The handler vocabulary belongs to the
bridge and is checked by its tests; the format defines only the envelope.

### D43. Match fields take lists; group profiles yield at equal specificity
`vendorId`, `productId`, `productName`, `name` and `namePrefix` take one value or a list, and an
entry stands for every combination (SPEC §3). This cut the index from 376 KB to 61 KB. At equal
specificity a device profile beats a group profile.

### D44. The bypass preset is marked in the data; protocol-family bases
`"bypass": true` marks the preset that turns EQ off. `walkplay-hid` and `fiio-usb-hid` are bases
holding what every device on that protocol shares; shape bases extend them.

### D48. Writable presets are marked in the data: format 1.1 (2026-10-10)
`writable: true` marks user memories, so an app never writes over a built-in curve. Once any preset
in a list is marked, the unmarked ones are built-in; with none marked the data doesn't say. The
first additive minor.

### D49. Device controls: format 1.2 (2026-10-28)
`protocol.controls` lists a device's settings besides the EQ (volume, output gain, DAC filter,
upsampling, USB mode, sound modes, lights, tone), because they change what the device plays and
whether its EQ applies. Like presets, the data says which values the device takes and the handler
knows how to send them: ids are each handler's vocabulary, values are the device's own numbers,
and an optional closed `role` lets apps present them alike. A control can depend on another
control (`when`, one level deep) and on firmware (unknown firmware: absent), mark values at which
the EQ stops applying (`disablesEq`), and mark writes that reconnect the device. Opt-in:
`pull`/`push` never touch controls, apps write one only when the user changes it, and never raise
a volume on their own. The bridge refuses unlisted values and absent controls, reads each write
back, and can read the device's firmware so apps can choose between firmware-split profiles. The
inspector reads controls at most and never writes them (invariant 9). First data: the Fosi Audio
DS3, from Fosi's web control center.

---

## Engine

### D9. Measurement-name binding lives in the consumer
The database carries hardware identity and `aliases`. Mapping a measurement or a graph-tool entry
to a profile is each app's job, because naming differs per database.

### D10. Auto-apply policy (consumer guidance)
Auto-apply only for a connected device with a unique match at specificity ≥ 3; suggest otherwise;
never silently rewrite user filters, and keep "unlimited" one click away.

### D12. Enforcement is consumer policy
Soft path: `validateList` while editing. Hard path: `fit` + `complete` before every device write.

### D15. Normative vs informative engine behaviour; conformance vectors
`project`, `resolveSlot` and `validate` are exact across languages. `assign`, `fit` and `complete`
are normative only through their properties (sound, faithful on valid input, idempotent, safe).
Ports prove themselves against `conformance/v1/`. No port is scheduled: every known consumer runs
TypeScript.

### D30. Engine semantics pinned down by the reference implementation
Where SPEC left room, the reference engine settled it, and SPEC §6–§8 and §13 now say so: exact,
ordered `validate` output; `ascendingFrequency` checked on the completed slots without running
`complete`; `project(NaN)` gives the neutral value; `fit` never trades a filter for a rule and
iterates to a fixpoint (breaking cycles deterministically); `complete` returns warnings. Vectors
are generated by `scripts/conformance.ts`; unit tests pin hand-computed values independently.

### D45. fit writes flat bands
A flat filter is a band, not nothing: `fit` keeps flat filters in slots the active ones left, so
the device holds the bands the user wrote, as vendor apps do.

### D46. complete takes hints
Apps that can read the device pass what it holds as `hints`; empty slots keep that layout, written
flat, instead of neutral fillers.

### D47. Fillers spread out and sit on nominal frequencies
Without a hint, `complete` spreads fillers over the gaps between filled slots and snaps them to
ISO 266 one-third-octave frequencies, so a read-back shows a sensible layout.

---

## Tooling and distribution

### D18. Static hosting plus npm
GitHub Pages serves the inspector at `/` and the data at `/v1/`, with CORS open. `core`, `client`
and `device-bridge` are on npm; releases attach `bundle.json`. No server, no database.

### D19. Contributions via GitHub only
The inspector builds prefilled pull-request and issue links; CI gates merges. No submission
backend: it would need a bot token, moderation and abuse handling.

### D20. The device bridge lives here
Taken from devicePEQ (0BSD) at commit `0617f38`, refactored into codec + session behind portable
transports. Nothing in `schema/`, `data/`, `core` or `client` depends on it.

### D21. Tech stack
npm workspaces, TypeScript strict, Vitest + fast-check, Ajv, Svelte 5, Prettier + ESLint, the same
as modernGraphTool. Markdown is hand-wrapped at 100 columns and not run through Prettier. Scripts
are TypeScript run directly by Node ≥ 22.18.

### D24. Name and home
**eqcaps** ("EQ capabilities"), under the owner's accounts: `github.com/potatosalad775/eqcaps`,
`potatosalad775.github.io/eqcaps`, npm `@potatosalad775/eqcaps-{core,client,device-bridge}`. If a
move ever becomes likely, put a custom domain in front before more apps hard-code the data URL.

### D25. Licenses: code MIT, data CC0-1.0
Code (`packages/`, `apps/`, `scripts/`) is MIT. `data/`, `schema/`, `conformance/` and every
published JSON file are CC0-1.0, so any app, closed-source ones included, can embed the data
without attribution plumbing. Inbound = outbound, stated in CONTRIBUTING and the PR template.
devicePEQ (0BSD), modernGraphTool (MIT) and AutoEQ (MIT, facts only) impose nothing further.
Nothing is copied from devicePEQ's captured vendor bundles or reverse-engineered vendor notes
(`fiio-js-capture/`, `walkplayJS/`, `walkplayPreprocessor/walkplay.js`, `Q5K/`,
`bluetooth_tools/`); facts learned from them may become data with a `community` source.

### D26. No upstream coordination
`data/` was seeded once from devicePEQ, modernGraphTool and AutoEQ (D31, archived) and is
maintained here by hand. Upstream changes are reviewed as diffs and taken over manually.

### D32. Data pipeline, client and releases
`packages/build` validates `data/` (with file and line, annotated in PR diffs) and publishes
`/v1/`. The client caches with TTL + ETag, takes an embedded snapshot, and reports failures only
through `onError`, never throwing into the app. Releases run locally (`npm run release`) so npm
can prompt for 2FA.
*2026-10-26:* no data package. Apps read the data from `/v1/` or embed `bundle.json` from a
GitHub Release.

### D33. Device bridge: transports, codecs and sessions
Handlers see two transport interfaces (HID and stream), never browser APIs. A handler is a pure
codec (`encode`, `decode`, `wire`) plus a session that does the I/O. Codecs write exactly what
they're given, rounded onto the wire grid; anything the wire can't carry is a `BridgeError` before
anything is sent. Push takes written values (apps run `fit` + `complete` first); pull returns
them. Tests decode recorded device answers and round-trip every codec, rather than reproducing
devicePEQ's bytes. Where the bridge deliberately differs from devicePEQ is listed in the archive.

### D34. Inspector: a static SvelteKit SPA on the same origin as the data
adapter-static, never server-rendered; `404.html` is the SPA fallback, so profile links are real
paths. It reads `/v1/` through the client. Testable logic lives in plain `.ts` under `src/lib/`.

### D35. Inspector editor, submission and evidence files
The editor edits authoring files read from the repository and runs CI's own checks as you type;
output is formatted byte-for-byte like `data/`. Submission is a GitHub link. Evidence files get a
PII review before export. A read-back is `community` evidence: it shows values a device holds, not
its limits.

### D40. The inspector never writes to a device
It calls the bridge's `pull` only. A probe that wrote test values was built and removed: on a real
device, writes past its band count corrupted its stored EQ, and every firmware quirk is a new risk
to hardware and hearing. Writing is for apps, through `fit` + `complete`.

### D41. Guided reads
The user changes the EQ in the vendor's own app, step by step, and the inspector reads back after
each step. The vendor app's limits become a `vendor-app` source whose `ref` is the evidence file,
which records the full read-back per step so a reviewer can recompute every conclusion
(INSPECTOR §3).
