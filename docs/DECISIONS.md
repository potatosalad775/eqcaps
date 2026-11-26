# Decisions

The design decisions that shape eqcaps today, each with its main reason. Numbers are stable: code
comments and other docs cite them (`D39`). The decisions since superseded or removed are listed
under [Archived](#archived), with where the full log of the build-out is kept.

To change a decision, edit its entry here with a dated note, and update [SPEC.md](SPEC.md) in the
same change if the format is affected. A new decision takes the next free number (D56). The rules
agents follow are in [AGENTS.md](../AGENTS.md); this file is the record of why.

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

*2026-11-22:* codegen also writes the schema's lists of allowed values as constants in `core`
(`FILTER_TYPES`, `PREAMP_MODES`, `CONTROL_KINDS`, `CONTROL_ROLES`, `SOURCE_KINDS`, `STATUSES`),
and code that needs one at run time imports it. **Why:** they were typed again by hand where a
form lists its options or a lenient reader its known values (the bridge's roles and kinds, the
editor's source kinds, statuses and preamp modes), with nothing tying a copy to the schema; a new
control role took an edit in two places and a rule in AGENTS.md to remember the second.

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

*2026-11-11:* a device profile no longer has to be carved out of a group. The `match-collision`
check skips a pair of profiles when exactly one is a group profile, so a device may claim the same
vendor and product id the group lists. **Why:** the tie was already resolved at run time (the
group yields), and the carve-outs only repeated the group's vendor list once per device, which
grew with every device that got its own profile. Two groups, or two devices, still collide. A
consumer that ignores the tie-break falls back to offering a choice, never a silent pick.

### D44. The bypass preset is marked in the data; protocol-family bases
`"bypass": true` marks the preset that turns EQ off. `walkplay-hid` and `fiio-usb-hid` are bases
holding what every device on that protocol shares; shape bases extend them.

### D48. Writable presets are marked in the data: format 1.1 (2026-10-10)
`writable: true` marks user memories, so an app never writes over a built-in curve. Once any preset
in a list is marked, the unmarked ones are built-in; with none marked the data doesn't say. The
first additive minor.

### D49. Device controls: format 1.2 (2026-10-28)
`protocol.controls` lists a device's settings besides the EQ (volume, output gain, DAC filter,
upsampling, USB mode, sound modes, lights, tone, amplifier class, mic gain, channel balance, and
since 2026-11-11 a headset's noise control, microphone noise reduction and prompt tones, since
2026-11-21 mute, input, output, a one-value balance, polarity, crossfeed and display brightness),
because they change what the device plays and whether its EQ applies. Like presets, the data
says which values the device takes and the handler knows how to send them: ids are each
handler's vocabulary, values are the device's own numbers, and an optional closed `role` lets
apps present them alike. Since 2026-11-21 every control in `data/` has a role unless it is a
setting only its vendor has (a test lists those): an app translates a control by its role, so one
left without shows the vendor's English label in every language. A control can depend on another
control (`when`, one level deep) and on firmware (unknown firmware: absent), mark values at which
the EQ stops applying (`disablesEq`), and mark writes that reconnect the device. Opt-in:
`pull`/`push` never touch controls, apps write one only when the user changes it, and never raise
a volume on their own. The bridge refuses unlisted values and absent controls, reads each write
back, and can read the device's firmware so apps can choose between firmware-split profiles. The
inspector reads controls at most and never writes them (invariant 9). First data: the Fosi Audio
DS3, from Fosi's web control center.

### D53. A device's other EQs are listed in its profile: format 1.3 (2026-11-20)
Qudelix's devices run a user EQ on top of a headphone EQ, each with its own values, switch and
memories, over one connection. `protocol.eqs` lists the EQs besides the one the profile
describes, each with the handler's id for it, the vendor's label, its band count and its own
presets; everything else in the profile holds for it. The bridge takes the EQ per operation
(`eq` on `pull` and `push`, and on the switch, the current preset and the band count), so one
connection drives them all, and core's `eqProfile` gives the engine the profile of one. Checked
on a 5K and a 5K Plus first: both EQs read and written, neither touching the other.
Rejected: a profile per EQ sharing the match under different `engine` labels (SPEC §3), which
ties at every connect, so the user is asked which EQ before anything is read; and a handler
option or a switch held by the bridge, which is session state posing as device data and leaves
the profile's band count wrong for the 5K Plus's 20-band headphone EQ. The list sits in `protocol`
because its ids are the handler's vocabulary, like controls, and the index already carries
`protocol`; the engine still never reads it. It covers EQs that differ in band count and presets
only: one with other filter types or domains still needs its own profile. The device's mode that
swaps both EQs for one larger EQ (Qudelix's single-EQ mode) is not modelled: the handler drives that
EQ as the profile's own and reports its band count.

*2026-11-21:* the bridge no longer takes the EQ per operation: it hands out the device viewed as
one EQ. `openDevice` gives it viewed as the EQ the profile describes, and `eq(id)` as a listed
one, over the same connection and queue: that EQ's `pull`, `push`, switch, presets and band
count, and its `slots` and `perChannel` in `capabilities`. The firmware, the controls and closing
are the device's from every view. **Why:** `eq` reached the operations three ways (in the
request, as a trailing argument, after an optional one), every per-EQ fact was a branch on "own or
listed" in the session and again in `capabilities`, and both callers that drove two EQs (uniPEQ
and the Qudelix tests) had written the same adapter to bind it. A view holds no state, so it is
not the switch rejected above, and "which EQ" is still said by the app, once. A handler gives its
capabilities for each EQ, which replaces `perChannelEqs`. Breaking for the bridge on npm; the
format, core and client are unchanged.

### D54. Independent left and right channels: format 1.4 (2026-11-21)
`channels: "independent"`, the value v1 reserved for it, says an EQ holds a filter set and a
preamp for each output channel, left and right, each with the profile's band count, domains and
rules. The engine is unchanged: an app runs it once per channel. An app that knows only linked
EQs still drives such an EQ by writing both channels alike, so older apps lose nothing: their
client accepts any `1.x` and ignores the value. The bridge takes the right channel as `right` on
a push and returns it on a pull, where the handler drives the channels apart (`perChannel`); a
push with `right` to any other handler is refused rather than written to both channels. First
data: Topping's DX5 II, whose app edits the channels apart and which stores them apart (seen on
a maintainer's unit). Only a stereo pair is described; an EQ of more channels (the Qudelix T71's
surround EQ, crossover drivers) stays out. Left for later: a `channels` of its own for an EQ in
`protocol.eqs`, which Qudelix's headphone EQ needs (two channels under a one-channel user EQ).

*2026-11-21:* done the same day, as format 1.5 (D55).

### D55. A listed EQ has channels of its own: format 1.5 (2026-11-21)
An EQ in `protocol.eqs` may say `channels`, which replaces the profile's for that EQ; left out, it
has the profile's, as before. Qudelix's devices need it: the user EQ the profile describes has one
channel, and the headphone EQ listed beside it holds left and right apart (Qudelix's app edits
them alike or apart, and a maintainer's 5K kept a band written to one channel off the other).
"Channels apart" is a property of one EQ, not of the device. An app that knows only 1.4 or
earlier takes the profile's `channels` for the listed EQ and writes both of its channels alike,
which SPEC §9 allows, so older apps lose nothing; their client accepts any `1.x` and ignores the
key. The bridge says for each listed EQ whether its handler drives the channels apart
(`perChannel` in `capabilities.eqs`) and refuses `right` for an EQ where it doesn't, as D54 does
for the profile's own. Rejected: marking the whole profile independent, which is wrong for the
one-channel user EQ, and a profile of its own for the headphone EQ, which D53 rejected for the
same device.

### D57. A control can be a setting of one EQ: format 1.6 (2026-11-22)
A control may say `eq`: `true` for the EQ the profile describes, or the id of one listed in
`protocol.eqs`. It keeps an id of its own, so a setting each EQ has is one control per EQ
(`headroom`, `headroomSpk`), read and written through the device like any other; the bridge has
no per-EQ control call. Qudelix's devices need it: each of their EQs has a headroom, and the
user EQ a crossfeed held with its preset, while the DAC filter and the output power are the
device's. With ids alone an app could not tell which EQ a headroom belongs to, and two rows
under one translated name would sit among the device's settings. With `eq` an app puts the
control where that EQ is edited, so its place says whose it is, and reads it again when that
EQ's preset changes. The handler says when a device's mode lacks the EQ (a control's read may
answer "not there now"), since no other control names the mode. `true` stands for the profile's
own EQ because that EQ has no id anywhere else (D53). The role `headroom` comes with it: a
fixed cut a device applies with an EQ, which an app working out a preamp against clipping should
be able to recognise. An app that knows only 1.5 or earlier shows such a control among the device's
settings under its name, so older apps lose nothing; their client accepts any `1.x` and ignores
the key. Rejected: controls called with the EQ of the operation, as `pull` and `push` are, with
one id for every EQ's headroom: `readControls()` gives one value per id, so every reader of it
would have had to learn views; and a `when` on a mode control, since the EQ mode is not offered
as a control (it changes which EQs exist, which a control cannot say).

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

*2026-11-21:* the hard path is one operation, `plan` (D56), which is `fit` + `complete` for each
channel a write carries. Enforcement is still the consumer's: an app decides when to write and
whether to show the plan first, and the bridge's `push` takes any written values.

### D15. Normative vs informative engine behaviour; conformance vectors
`project`, `resolveSlot` and `validate` are exact across languages. `assign`, `fit` and `complete`
are normative only through their properties (sound, faithful on valid input, idempotent, safe).
Ports prove themselves against `conformance/v1/`. No port is scheduled: every known consumer runs
TypeScript. *2026-11-21:* `plan` (D56) is normative through its properties too.

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

### D56. The write recipe is an engine operation: `plan` (2026-11-21)
`plan(profile, wanted, { writesPreamp, perChannel, held })` in `core` gives what a write sends:
`fit`, then `complete` with what the device holds as hints, for each channel that is written
(SPEC §13.10, vectors in `conformance/v1/plan.json`). It writes the right channel apart only where
the profile's channels are independent, the write drives them apart and one is wanted, and it
sends a preamp only where the write carries one and the mode is `manual` or `unknown` (SPEC §9).
**Why:** "the recipe every app follows" existed only as prose and README snippets, so the
bridge's README and recipe test, uniPEQ and modernGraphTool had each assembled it, and they had
come apart: the README and the test sent the preamp for `manual` only, which refuses a push on a
handler that writes none and leaves an `unknown` device on its old preamp while the bands boost;
the apps sent it for `manual` and `unknown` where the handler writes one, which is the rule kept,
as the one that has run on hardware. Formats 1.3, 1.4 and 1.5 each had to be learned by every
copy, and the bridge's recipe test never pushed a listed EQ or a right channel. It lives in
`core` because it is pure and made only of `fit` and `complete`; what it needs from the write
path is two yes-or-no facts, which the bridge's `capabilities` state under the same names, so no
bridge type enters `core` and the engine still never reads `protocol` (D2). An app's change
report (what moved, clip risk, whether to ask first) stays the app's, built from each channel's
`fit` result. Rejected: a package above `core`, `client` and the bridge for it, which about
thirty lines don't need; and a `push` that takes only a plan, which D12 leaves to the consumer.

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
transports. Nothing in `schema/`, `data/`, `core` or `client` depends on it. Since then, the
handlers follow the vendors' own apps where one is known (D50).

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
*2026-11-12:* how a vendor app was read stays out of the repository (D52).

### D26. No upstream coordination
`data/` was seeded once from devicePEQ, modernGraphTool and AutoEQ (D31, archived) and is
maintained here by hand. Upstream changes are reviewed as diffs and taken over manually.
*2026-11-12:* the Walkplay groups' `match.usb` is the exception: a script refreshes it from the
vendor's own product catalog (D51).

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

*2026-11-22:* two things an architecture review proposed and withdrew, so they aren't proposed
again. **A codec returns bare frames**, not frames tagged with what each is (a band, a save).
Each handler's `push` sits in the file of the codec that wrote the bytes and reads them by the
same named constants, so the knowledge is already in one place; a tag would change every codec,
its tests and an app's demo device to rename a handful of one-line checks. Where a `push` counts
frame positions instead (KT Micro, Topping), it gets a step list of its own, as Moondrop's has.
**A handler's per-connection state is keyed by the transport**, in the handler's module, not held
by the bridge device. Several devices are opened on one transport in turn (an app reads the
firmware, then opens the device it will drive; the inspector opens one per profile picked), and
the state is what lets the later ones use the handshake the first one made.

### D50. The vendor's own app is the reference (2026-11-01)
What a handler sends (frames, order, commits, saves, delays) and what the data says (ranges,
types, presets, controls) follow the vendor's own app, read for facts only (D25). Where the bridge
or a profile disagrees with it, they change to match, without waiting for a recording. devicePEQ
`0617f38` is the fallback where no vendor app is known, and its differences go in the notes. A
deviation from the app is made only where the app is plainly broken, and the notes say so.
Behaviour only one vendor's app has is a handler option, so other brands on the handler keep
theirs. **Why:** the app is how the firmware is meant to be driven. devicePEQ's guesses, kept
"until a recording confirms", were wrong more than once: its Walkplay commit carried two of the
chip's factory-reset commands, which reset a Tanchjim Space II's DAC settings on every write, and
neither Walkplay's, NICEHCK's nor Tanchjim's app sends them. D39's 2026-10-28 note is the same
rule for unit conversions.

### D51. Walkplay's groups are generated from its product catalog (2026-11-12)
Walkplay's app has a product catalog: vendor id, product id, `SchemeNo`, brand and model of every
product. `data/catalogs/walkplay.json` keeps a trimmed
snapshot of it, facts only (D25), CC0 like the rest of `data/` and not published under `/v1/`.
The `match.usb` of the ten Walkplay group profiles is generated from the snapshot, one entry per
vendor id with its real product ids, and is not edited by hand. What the catalog doesn't list, and
only devicePEQ `0617f38` does, is kept by hand in the snapshot's `extra` list. The snapshot is
refreshed by the maintainer's fetch script, kept outside this repository (D52), run by hand or by
the maintainer's scheduled watcher (2026-11-26 below), never in CI; `npm run data:walkplay`
regenerates the groups from the snapshot, and CI checks that they match it. A device profile still
beats its group on the same pair (D43).
**Why:** the groups matched every vendor id with every product id of a scheme, a cross product of
which about 80 of 1501 pairs exist for SchemeNo16. The real pairs are known, so the groups can say
what exists, and a refresh is a diff someone reads: a new scheme needs a base chosen by hand, a
named product may deserve its own profile (D37), and `main` deploys `/v1/` on every push.

*2026-11-26:* the fetch also runs on a schedule, on the maintainer's machine, in a vendor watcher
kept outside this repository (D52). The watcher also reads the vendors' own web apps for devices
no profile matches. It drafts a profile only where the app drives a device like others of its
brand that all extend one base, and it leaves every other case to a person. It never pushes to
`main`: it opens or updates one draft pull request from the branch `auto/vendor-watch`, its
profiles are `draft`, and the maintainer reviews it before merging. It never runs in CI.
**Why:** by hand, a refresh waited for someone to remember it. The reasons above still hold with a
pull request in between: a daily request is one app launch's traffic, a person still reads the
diff and chooses the bases, and nothing deploys until it is merged.

### D52. How a vendor app was read stays out of the repository (2026-11-12)
The repository holds the facts read from vendor apps and names the app, its version and the date
it was read. How it was read does not belong here: the tools and steps used, the scripts that
refresh such data, the procedure for reading an app, and any vendor material are the maintainer's
and are kept outside this repository (`../eqcaps_private`). A script that needs them lives there
too and writes facts into this repository (the Walkplay catalog snapshot, D51). The repository
builds, checks and tests without that repository. A `vendor-app` source ref names the app, its
version or build, its URL or package id, and in plain words what was read; never a name from
inside the app. The same holds for plans, code comments and test names: say what the app does.
Recordings and captures carry what the device and the app's screen showed, and no vendor address.
One exception: the WebHID recorder's adapters (`tools/userscripts/`) name the page state they must
find in a vendor web app to record a session, the minimum a contributor's recorder needs, and stay
public. **Why:** publishing how an app was read adds nothing a consumer of the data needs, and
vendors may object to it even when the facts themselves are theirs to be read. The cost is that
only the maintainer can refresh such data, so a plan still says which app and version was read,
and when.

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

*2026-11-22:* the bridge names the reading side. `openReader` gives a device with its reads only
(`pull`, `currentSlot`, `eqEnabled`, `slots`, `bandCount`, `firmware`, `readControls`), on every
EQ's view, and the inspector opens devices with nothing else: it no longer imports `openDevice`
to strip the writes itself. **Why:** the inspector's own copy picked five members by hand, so it
lacked `firmware` and `readControls`, which reading a device's firmware and controls needs, and a
write added to the bridge was kept out only by that list. The bridge's test now fails when a new
member of a device is placed on neither side.

### D41. Guided reads
The user changes the EQ in the vendor's own app, step by step, and the inspector reads back after
each step. The vendor app's limits become a `vendor-app` source whose `ref` is the evidence file,
which records the full read-back per step so a reviewer can recompute every conclusion
(INSPECTOR §3).

## Archived

Decisions that no longer apply. Their numbers are not reused, and a citation of one says
"archived". The full log of the build-out (2026-10-02 to 2026-10-10), with what each decision
rejected and its dated amendments, and the build-out plan beside it, were kept under docs/history
until v0.6.0 and are in the repository's history:
[decisions.md](https://github.com/potatosalad775/eqcaps/blob/v0.6.0/docs/history/decisions.md),
[plan.md](https://github.com/potatosalad775/eqcaps/blob/v0.6.0/docs/history/plan.md).

### D23. Seed data is imported and marked draft (archived)
Done once, on 2026-10-02; `data/` has been edited by hand since (D26).

### D29. Domains are written values; realization laws are profile data (archived)
Superseded by D39.

### D31. Seed import: what was taken and how (archived)
The importer was removed on 2026-10-04.

### D38. Probe mode: engine, strategy and evidence (archived)
Removed the day it was accepted, with the `probe` source kind (D40).
