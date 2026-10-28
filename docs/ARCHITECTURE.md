# Architecture

How eqcaps is put together: what each part does, how data flows from a contributor to an app, and
the rules that keep the parts apart. The format itself is defined in [SPEC.md](SPEC.md); the
reasons behind each choice are in [DECISIONS.md](DECISIONS.md).

## 1. Goal

One shared, vendor-neutral answer to a question every EQ app has:

> *Which filter configurations does this EQ engine (a hardware DSP or a software EQ) actually
> accept?*

That covers band count, filter types per slot, frequency/Q/gain domains with quantization and
value sets, conditional domains, cross-band rules, preamp, device identity and provenance. eqcaps
is four things:

1. **A format**: [SPEC.md](SPEC.md), JSON Schema, conformance vectors.
2. **A database**: community-maintained profiles, validated in CI, published as static JSON.
3. **A reference engine**: `resolveSlot`, `validate`, `assign`, `fit` and `complete` in
   TypeScript, portable by spec.
4. **Tools around it**: a device bridge that reads and writes EQ on hardware, and the
   [inspector](INSPECTOR.md) web app for browsing, checking devices and contributing.

Out of scope: per-channel (L/R) EQ, how filters actually sound (D39), coefficient quantization,
a submission backend, and non-EQ device features (DAC filters, mic gain…).

## 2. Consumers

| Consumer | Uses |
| --- | --- |
| [uniPEQ](https://unipeq.com) ([source](https://github.com/potatosalad775/uniPEQ)): SvelteKit + Capacitor hardware PEQ app, web and Android | `core`, `client` and `device-bridge` from npm, an embedded `bundle.json`, its own native USB transport on Android (D27) |
| The inspector (this repo) | everything, `pull` only (D40) |
| Any other app | the `/v1/` JSON and schema (CC0), or the npm packages |

## 3. System overview

```
             contributors                                    apps
                  │                                            ▲
   ┌──────────────▼──────────────┐   PR    ┌──────────────────┐ │ fetch (CORS, static)
   │ Inspector (static SPA)      │────────▶│ GitHub repo      │ │ or npm + embedded bundle
   │  browse · identify · read   │         │  data/  schema/  │ │
   │  guided read · edit/submit  │         │  evidence/       │ │
   │   uses: core, client,       │         └────────┬─────────┘ │
   │         device-bridge       │                  │ CI: validate, collisions,
   └─────────────────────────────┘                  │     conformance, build
                  ▲                                 ▼           │
                  │                       ┌─────────────────────┴──┐
                  └───── same origin ─────│ GitHub Pages            │──▶ npm (code packages)
                                          │  /          inspector   │──▶ GitHub Release
                                          │  /v1/       data        │     (bundle.json)
                                          └─────────────────────────┘
```

## 4. Repository layout

```
eqcaps/
├── docs/                         SPEC, ARCHITECTURE, DECISIONS, INSPECTOR, plans/, research/, history/
├── schema/v1/
│   ├── profile.schema.json       published (flat) profiles; hand-written
│   └── source.schema.json        authoring files (adds extends / abstract); generated
├── data/
│   ├── profiles/<brand>/<id>.json
│   ├── bases/<id>.json           abstract bases: protocol families and shapes
│   └── evidence/<id>/<date>-<hash>.json
├── conformance/v1/
│   ├── *.json                    engine vectors, one file per op (generated)
│   └── profiles/                 format fixtures: SPEC examples + a case per validation rule
├── packages/
│   ├── core/                     types, semantic validator, engine (zero deps, sync)
│   ├── client/                   fetch and cache index/profiles/bundle; matchDevice()
│   ├── build/                    Ajv validation, cross-profile checks, publishing, data CLI
│   └── device-bridge/            transports, codecs and sessions; browser transports in ./browser
├── apps/inspector/               SvelteKit SPA (adapter-static)
├── tools/userscripts/            WebHID recorder for vendor web apps (recordings for bridge tests)
└── scripts/
    ├── codegen.ts                source.schema.json + TS types from profile.schema.json
    ├── conformance.ts            engine vectors in conformance/v1/
    ├── data-format.ts            formats data/ like the inspector writes it
    ├── release.ts                npm publish, tag and GitHub Release (run locally)
    └── sample-consumer.ts        fetch, match and fit against the built data, as an app would
```

## 5. Package boundaries

```
schema/v1 ──codegen──▶ core ◀──┬── client
                               ├── build          (+ Ajv)
                               └── device-bridge
apps/inspector ──▶ core, client, build, device-bridge
apps           ──▶ core, client (+ device-bridge to drive hardware)
```

- **`core`** has zero dependencies and no environment types (no DOM, no Node). Everything else
  builds on it.
- **`client`** reads `fetch` and timers from `globalThis`, so it runs in browsers, Node and
  WebViews. It never throws into the host app: every failure means "no constraints" and goes to
  `onError`.
- **`build`** holds Ajv and everything CI runs. The inspector's editor uses it in the browser to
  run CI's own checks.
- **`device-bridge`** knows how to talk to a device, not what the device accepts or which device
  it is. Nothing in `schema/`, `data/`, `core` or `client` depends on it (D2, D20).

## 6. Invariants

Changing one of these needs a DECISIONS entry.

1. **Vendor-neutral format.** Nothing app-specific in profiles: no measurement names, no app
   store ids, no UI concepts (D1, D9).
2. **Constraint data ≠ wire format.** Profiles say which values are accepted, never how bytes are
   laid out. A profile's `protocol` only selects a bridge handler and its settings (D42); the
   engine never reads it.
3. **Canonical units, written values.** Hz, dB, RBJ-cookbook Q. Domains describe the values the
   engine is told. Nothing models or corrects how its filters sound (D39).
4. **Profile ids are permanent public API.** A rename is `deprecated` + `replacedBy`.
5. **Published files are flat.** `extends` and `abstract` exist only in authoring files (D14).
6. **JSON Schema is the structural source of truth.** TS types are generated from it (D13).
7. **`project`, `resolveSlot` and `validate` are exact** across languages; `assign`, `fit` and
   `complete` are normative through their properties (D15).
8. **Apps must work without the CDN.** The database enhances an app and never blocks it.
9. **The inspector never writes to a device** (D40).

## 7. Data flow

1. **Authoring.** A profile is a JSON file under `data/profiles/`, usually extending a base in
   `data/bases/` that holds a protocol family's wire grids, preamp and handler. Contributors
   write it by hand or in the inspector's editor.
2. **Validation** (`npm run data:validate`, and CI on every PR): repository layout, JSON Schema,
   the semantic rules of SPEC (each with an issue code and a conformance case), cross-profile
   rules such as match collisions, and the bridge's tests checking every hardware profile against
   its protocol's codec.
3. **Build** (`npm run data:build`): flatten `extends`, then write `profiles/<id>.json`,
   `index.json` (with `match` and `protocol`, so apps identify and drive a device from the index
   alone), `bundle.json`, the schema and the conformance files to `dist/site/v1/` (SPEC §14).
4. **Deploy**: after CI passes on `main`, GitHub Pages serves `/v1/` and the inspector at `/`.
5. **Consume**: the client fetches and caches the index, bundle and profiles, or answers from an
   embedded snapshot when offline.

## 8. Writing EQ to a device

The recipe every app follows (D12, D33):

```
identity ──client.matchDevice──▶ profile ──protocolForMatches──▶ bridge session
filters ──fit──▶ slots ──complete(hints: what the device holds)──▶ written values ──push──▶ device
```

- `fit` projects the user's filters onto what the profile accepts. It is sound (every value it
  writes is in its domain) and idempotent.
- `complete` fills every remaining slot, keeping the device's own layout when given `hints`.
- The bridge's codec rounds onto the wire grid and refuses, with a `BridgeError`, anything the
  wire can't carry. It never clamps or converts, so a value either goes out as asked or not at all.

While editing, apps run `validateList` and flag problems without rewriting anything.

## 9. Device bridge

- **Transports.** Handlers see only `HidTransport` and `StreamTransport` (`src/transport.ts`).
  WebHID, Web Serial and Web Bluetooth implementations are in `./browser`, typed structurally; a
  native app supplies its own.
- **Handlers** are a pure codec (`encode`, `decode`, `wire`) plus a session that does the I/O. 16
  protocols, from devicePEQ `0617f38`.
- **Protocols are data.** A profile names its handler, options and presets (D42), inherited from
  its base, so a new device on a known protocol needs no bridge release. `src/protocols.ts`
  checks the block against the handlers and holds per-vendor guesses for devices without a
  profile, marked experimental.
- **Tests** decode recorded device answers (`test/captures/`), round-trip every codec on its wire
  grid, and run the write recipe for every profile.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| Most profiles are seeded drafts | `status` is visible to apps; guided reads (`vendor-app` evidence) make verification a guided flow; "wrong constraint" issue form |
| Wrong data writes bad EQ to a device | apps always run `fit` on the write path; device firmware usually clamps anyway |
| The format meets a gap in real use | additive minors (SPEC §15), otherwise v2 under a new prefix |
| A device's filters sound different from the values it's told | out of scope (D39); reported quirks are warnings in `meta.notes` |
| Device features are Chromium-only on the web | browsing and editing work everywhere; the inspector explains instead of hiding |
| Public URLs move | ids are permanent; a custom domain goes in front before any move (D24) |

## 11. Roadmap

Work in progress has a plan in [plans/](plans/).

- **More verified profiles.** Two are `maintainer-verified` (CrinEar Protocol Micro, EarAcoustic
  OSHUN DECO), both from guided reads. The RME drafts' notes list what to check.
- **Guided reads with a phone or desktop vendor app.** The inspector reconnects a granted device
  for each step; this path hasn't run on hardware yet (INSPECTOR §3.4).
- **NiceHCK PureAural.** Its own profile (not a Walkplay variant), and the write differences its
  and the OSHUN DECO's vendor apps showed as protocol options, with the captures as tests. Whether
  the OSHUN DECO's bands 11–16 do anything needs a measurement.
- **Qudelix 5K reads.** The USB handler can only write, and devicePEQ's writes are reported
  unstable. A capture of the vendor app's USB traffic would settle both.
- **Smaller group profiles.** As devices are identified, give them device profiles with their
  real ids and drop the pairs from the groups, most of which don't exist.
- **modernGraphTool** adopting `core` and `client` in place of its own constraint model.
