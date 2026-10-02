# EQ Constraint Profile Format: v1 draft

> **Status: draft, not frozen.** This file is the single place the format is defined. Until the
> freeze (end of Phase 4, see [PLAN.md](PLAN.md)) it is published under `/next/`, not `/v1/`.
> MUST / SHOULD / MAY are used as in RFC 2119. Rationale for each choice is in
> [DECISIONS.md](DECISIONS.md), and the evidence is in [research/prior-art.md](research/prior-art.md).

## 1. Concepts

| Term | Meaning |
| --- | --- |
| **Profile** | Describes one *EQ engine*: the set of filter configurations it accepts. A device with two independent EQs (say a PEQ and a 10-band graphic) has two profiles. |
| **Slot** | One band position of the engine, index `0 … bandCount-1`. |
| **Filter** | `{ type, freq, q, gain }`. An app holds a *list of filters* that describes the response the user wants; an engine has *slots*. `assign` maps one onto the other (§13.5). |
| **Domain** | Allowed values of one numeric field (§4). |
| **Variant** | A conditional override of a slot's domains, selected by a predicate on the filter's own fields (§6). |
| **Rule** | A constraint spanning more than one slot (§7). |
| **Written value** | A field's value as the engine takes it, in canonical units. Domains, rules and validation are about written values. |
| **Realized filter** | The cookbook filter the engine actually produces from written values. It equals the written filter unless the profile has realization laws (§8). |

**Units are fixed:** `freq` in Hz, `gain` and `preamp` in dB, and `q` dimensionless as defined by
the RBJ Audio EQ Cookbook for the filter type. Profiles never carry device-native units. Authors
fold in every conversion that depends only on the value itself: bandwidth in octaves → Q, raw
register values → dB, a constant factor the engine always applies. If the native grid becomes
non-uniform after conversion, enumerate it with `values`. A deviation that depends on another field
isn't a unit; it's a realization law (§8, DECISIONS D29).

## 2. Top level

```jsonc
{
  "$schema": "https://potatosalad775.github.io/eqcaps/v1/schema/profile.schema.json",
  "schemaVersion": "1.0",                // minimum format version this profile needs
  "id": "jds-labs-element-iv",
  "kind": "hardware",                    // hardware | software
  "device": { "brand": "JDS Labs", "model": "Element IV", "aliases": ["Element 4"] },
  "engine": "PEQ",                       // optional label; required when several profiles share a match
  "match": { },                          // §3, hardware only
  "bandCount": 12,                       // integer >= 1, or null = unbounded (software only)
  "band": { },                           // §5 slot template
  "bands": [ ],                          // §5 per-slot overrides
  "rules": [ ],                          // §7
  "realization": { },                    // §8
  "preamp": { },                         // §9
  "channels": "linked",                  // §9
  "meta": { }                            // §10
}
```

| Field | Req. | Notes |
| --- | --- | --- |
| `schemaVersion` | ✔ | `"1.<minor>"` |
| `id` | ✔ | `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 64 chars, conventionally `<brand>-<model>[-<engine>]`. **Permanent public API.** |
| `kind` | ✔ | `software` profiles describe app EQs (Equalizer APO, Wavelet, Poweramp…). They have no `match` and are selected by id. |
| `device` | ✔ | `brand`, `model` required; `aliases` (marketing names, regional names) optional, used for search only. |
| `engine` | – | Free label ("PEQ", "Graphic EQ", "Line out"). |
| `match` | hw | §3 |
| `bandCount` | ✔ | `null` only for `kind: software`. |
| `band` | ✔ | After merging with `bands`, every slot MUST define `types`, `freq`, `q`, `gain`. |
| `bands` | – | §5.2 |
| `rules` | – | default `[]` |
| `realization` | – | §8; absent = unknown |
| `preamp` | ✔ | §9; `{ "mode": "unknown" }` is allowed and honest. |
| `channels` | – | default `"linked"` |
| `meta` | ✔ | §10 |

Keys starting with `x-` are extensions. They are allowed anywhere and ignored by consumers. Any
other unknown key fails CI validation, but **consumers MUST NOT reject** a profile for unknown keys
(forward compatibility, §15).

The structural rules are in `schema/v1/profile.schema.json` (published files) and
`schema/v1/source.schema.json` (authoring files, §11). Authoring files point `$schema` at the
source schema by relative path. The build replaces it with the published URL above.

## 3. Identity and matching (`match`)

Lists are OR-ed; fields within one entry are AND-ed.

```jsonc
"match": {
  "usb": [
    { "vendorId": "0x2972", "productId": "0x0047" },
    { "vendorId": "0x2972", "productName": "FIIO FX17 " }      // exact, trailing space is real
  ],
  "bluetooth": [
    { "name": "EH13" },
    { "namePrefix": "FiiO EH1" },
    { "serviceUuid": "00001101-0000-1000-8000-00805f9b34fb", "namePrefix": "W830" }
  ],
  "firmware": { "min": "1.2", "max": "2.0" }                     // optional; min inclusive, max exclusive
}
```

- A `match` has at least one `usb` or `bluetooth` entry.
- USB ids are lowercase 4-digit hex strings. A `usb` entry MUST have `vendorId` plus at least one
  of `productId` / `productName`. Vendor-only matching is too broad, because chip vendors like
  Walkplay ship under dozens of brands.
- A `bluetooth` entry MUST have `name` or `namePrefix`. `serviceUuid` alone is never sufficient.
  UUIDs are written in lowercase canonical form.
- `productName` and `name` compare exactly (case- and whitespace-sensitive).
- **Specificity** (higher wins): vid+pid+name = 4, vid+pid = 3, vid+name = 3, bt name = 2,
  bt namePrefix(+uuid) = 1. On a tie, the consumer presents a choice and never picks silently.
- `firmware` compares by dotted-numeric order: split on non-digits, compare components numerically,
  missing components = 0. If the device's firmware is unknown, `firmware` is ignored and ties are
  resolved by choice. `firmware` has at least one bound, and when it has both, `min` MUST be less
  than `max`; otherwise no firmware matches.
- CI rejects two non-deprecated profiles with an identical match entry and overlapping firmware
  ranges, unless their `engine` labels differ.

Measurement or graph names (e.g. a phone_book entry) are **not** part of matching. Binding a
measurement to a profile is the consuming app's concern (DECISIONS D9).

## 4. Domains

Every numeric field (`freq`, `q`, `gain`, `preamp.gain`) uses exactly one form:

| Form | JSON | Allowed values |
| --- | --- | --- |
| Range | `{ "min": 20, "max": 20000 }` | closed interval |
| Stepped range | `{ "min": -6, "max": 6, "step": 0.25 }` | `{ k·step : k ∈ ℤ } ∩ [min, max]`, grid anchored at 0 |
| Set | `{ "values": [31, 62, 125, 250] }` | listed values; ascending, unique, non-empty |
| Locked | `{ "value": 1.41 }` | exactly one value; UIs render the field read-only |

Semantic rules (checked by the validator, not expressible in JSON Schema):

- `min ≤ max`, `step > 0`, `freq` and `q` values `> 0`.
- For stepped ranges, `min` and `max` MUST lie on the grid. This keeps snapping unambiguous.
- Grids that aren't anchored at 0, or aren't uniform (1/12-octave, ISO ⅓-octave, lookup tables),
  MUST use `values`. Tooling can generate these.

**Tolerance.** All membership tests use `ε = 1e-9` relative:
`near(a, b) ⇔ |a − b| ≤ ε · max(1, |a|, |b|)`. A value is on a grid if `near(x/step, round(x/step))`.
This is what makes non-decimal steps like `1/14` (written `0.07142857142857142`) work.

## 5. Slots

### 5.1 Slot object

```jsonc
{
  "label": "Lowshelf 1",                 // optional UI hint
  "types": ["LSC"],                      // allowed filter types, non-empty, in preference order
  "freq": { "min": 20, "max": 20000 },
  "q":    { "min": 0.1, "max": 10, "step": 0.01 },
  "gain": { "min": -12, "max": 12, "step": 0.1 },
  "variants": [ ]                        // optional, §6
}
```

### 5.2 Template and overrides

`band` applies to every slot. Each `bands[]` entry overrides it for one or more slots:

```jsonc
"bands": [
  { "index": 0, "types": ["LSC"], "freq": { "min": 20, "max": 300 } },
  { "index": [1, 2, 3, 4, 5, 6, 7, 8], "label": "Peaking" }
]
```

- `index` is an integer or an array of integers, each `< bandCount`. Each slot is overridden at most once.
- **Merge is per key, replace.** An override's `freq` replaces the template's `freq` as a whole:
  there is no deep merge of `min`/`max`/`step`. `variants` also replace as a whole.
- When `bandCount` is `null`, `bands` MUST be empty (all slots are the template).

### 5.3 Filter types

| Code | Filter (RBJ cookbook) | `freq` is | Uses `gain` |
| --- | --- | --- | --- |
| `PK` | peaking | f0 (center) | yes |
| `LSC` | low shelf, Q-parameterized | f0 (shelf midpoint) | yes |
| `HSC` | high shelf, Q-parameterized | f0 (shelf midpoint) | yes |
| `LPQ` | 2nd-order low-pass | f0 | no |
| `HPQ` | 2nd-order high-pass | f0 | no |
| `BP` | band-pass, 0 dB peak | f0 (center) | no |
| `NO` | notch | f0 (center) | no |
| `AP` | all-pass | f0 | no |

Every type takes `q`. Every code is also an Equalizer APO filter code with the same parameters, so
Equalizer APO and AutoEQ text maps 1:1. Equalizer APO's `LSC`/`HSC` take the shelf's center
frequency, which is the cookbook's f0. Its `LP`/`HP` (fixed Q) have no code of their own here:
write `LPQ`/`HPQ` with `q` locked. modernGraphTool's `LSQ`/`HSQ` are `LSC`/`HSC`. Some tools give
shelves a slope S instead of a Q; convert with the cookbook's `1/Q = sqrt((A + 1/A)(1/S − 1) + 2)`.

For gainless types, `gain` is ignored by validation and treated as 0. Vendor-specific types use
`x-<name>` and are treated as "unknown type" by consumers (§15).

When an engine's filters deviate from these definitions by a known law, `realization` (§8)
describes it. Out of scope for v1: coefficient quantization, and biquads computed by the bridge at
an assumed sample rate. Both belong to the bridge.

### 5.4 Graphic EQs need no mode

A slot is **freq-locked** if its `freq` is `{ value }` or a single-element `{ values }`. A profile is
a graphic EQ iff every slot is freq-locked, and consumers derive `isGraphic` from that. Hybrids,
such as fixed centers with adjustable Q, need nothing special.

## 6. Variants (conditional domains)

```jsonc
"variants": [
  { "when": { "gain": { "gt": 0 } },              "freq": { "min": 200, "max": 8000 } },
  { "when": { "type": { "in": ["LSC", "HSC"] } }, "q":    { "value": 0.707 } }
]
```

- `when` (required) maps fields (`type`, `freq`, `q`, `gain`) to conditions, and all of them must
  hold. Numeric conditions are `eq`, `gt`, `gte`, `lt`, `lte`; several in one object are AND-ed
  (`{ "gt": 0, "lte": 6 }`), and each condition object has at least one. `type` supports `eq` and
  `in`. A condition on a null or missing field is false.
- A variant may define `freq`, `q`, `gain`. It may not define `types`.
- **Selection is per field, first match wins.** The effective domain of field F is the F of the
  first variant, in array order, whose `when` holds and which defines F. If there is none, it is
  the slot's own F.
- **No cycles.** Draw an edge A → F for each variant whose `when` references A and which defines F.
  The graph MUST be acyclic, and no variant may reference a field it defines. Engines evaluate
  fields in topological order (`type` always first), so every predicate sees an already-final value.

## 7. Rules (cross-slot)

v1 has a closed set:

| `type` | Parameters | Meaning |
| --- | --- | --- |
| `ascendingFrequency` | `strict` (bool, default `true`) | On the **completed** slot array (§13.7, fillers included), `freq[i] < freq[i+1]` (`≤` when not strict). |
| `minSpacing` | `octaves` (> 0) | Any two **active** filters are at least `octaves` apart: `abs(log2(f_a / f_b)) >= octaves`. |

Rules apply to written values. A filter is **active** if its type uses gain and `gain ≠ 0`, or if
its type is gainless.

Unknown rule types: a consumer MUST tell the user that the profile has rules it cannot enforce. On
the hardware write path it MUST NOT present the result as device-conformant, though it MAY write
after explicit confirmation.

Candidates for v1.x, not in v1: `maxResponse` (peak of the combined response plus preamp ≤ X dB,
which needs filter math in every engine) and a gain budget. There is deliberately no general
expression language (DECISIONS D11).

## 8. Realization

Domains describe written values (§1). Most engines then build exactly the cookbook filter those
values describe. Some don't: their Q, or a shelf's frequency, comes out different by an amount
that depends on another field
([prior-art §2.1](research/prior-art.md#21-realization-compensation-devicepeq-upstream)).
`realization` records that, so consumers can show what the listener actually gets and compensate
before writing (§13.3).

```jsonc
"realization": {
  "laws": [
    { "law": "gainScaledQ", "types": ["PK", "LSC", "HSC"] },
    { "law": "shelfFrequencyShift", "types": ["LSC", "HSC"], "designRate": 48000 }
  ],
  "sources": [{ "kind": "measurement", "ref": "evidence/fosi-audio-ds3/2026-10-12-9f3e.json",
                "date": "2026-10-12", "by": "github-handle" }]
}
```

Laws form a closed set. In each formula `f`, `q` and `gain` are the filter's **written** values,
`A = 10^(|gain|/40)`, and gainless types count as `gain = 0`.

| `law` | Parameters | Changes | Realized value | `types` allowed |
| --- | --- | --- | --- | --- |
| `gainScaledQ` | – | `q` | `q / A` | `PK`, `LSC`, `HSC` |
| `nyquistScaledQ` | `designRate` | `q` | `q · cos(π·f / designRate)` | any |
| `shelfFrequencyShift` | `designRate` | `freq` | `(designRate/π) · atan(tan(π·f / designRate) · d)`, with `d = √A` for `LSC` and `1/√A` for `HSC` | `LSC`, `HSC` |

`designRate` (Hz) is the sample rate the engine designs its filters at. It's a fixed property of
the part, not the rate being streamed.

- Every law lists its `types` explicitly (non-empty) and applies only to filters of those types.
- When several `q` laws apply to a type, their factors multiply. At most one `freq` law applies to
  a type.
- `designRate` MUST be greater than twice the `freq` maximum of every slot the law can apply to.
- Laws add dependencies: `gain → q` under `gainScaledQ`, `freq → q` under `nyquistScaledQ`, and
  `gain → freq` under `shelfFrequencyShift`. Together with the variant edges of §6, the graph MUST
  stay acyclic. The graph is checked per slot (after merging, §5.2), and a law adds its edge only
  in slots whose `types` include one of the law's types.
- A constant factor, such as a frequency the engine always realizes ×0.9775, is not a law. It
  depends only on the value itself, so authors fold it into the domains (§1).

**Provenance.** Probes and read-back see written values, so they can't show realization; only a
measurement can. `realization` therefore carries its own `sources` (non-empty, source objects as in
§10), and `meta.status` doesn't cover it. The realization is **measured** iff `sources` has a
`measurement` source without `via`.

- No `realization` key means *unknown*: consumers treat the engine as exact, and may say so.
- `"laws": []` with a measurement source records an engine that was measured and found exact.

A consumer that doesn't recognize a law MUST tell the user that the predicted response may be off.
Written values stay valid either way, so an unknown law never blocks a device write.

## 9. Preamp and channels

```jsonc
"preamp": { "mode": "manual", "gain": { "min": -12, "max": 0, "step": 0.5 } }
"preamp": { "mode": "auto" }       // the device computes its own headroom
"preamp": { "mode": "none" }       // no preamp control; the app should warn on boost
"preamp": { "mode": "unknown" }    // e.g. seeded data
```

`channels`: only `"linked"` (one filter set drives both channels) in v1. `"independent"` is
reserved for per-channel engines.

## 10. Provenance (`meta`)

```jsonc
"meta": {
  "status": "community-verified",        // draft | community-verified | maintainer-verified | deprecated
  "replacedBy": "some-other-id",         // required iff deprecated
  "sources": [
    { "kind": "probe", "ref": "evidence/jds-labs-element-iv/2026-09-30-a1b2c3.json",
      "firmware": "1.4", "date": "2026-09-30", "by": "github-handle" },
    { "kind": "handler-code", "ref": "https://github.com/jeromeof/devicePEQ/blob/<sha>/…",
      "date": "2026-10-02" }
  ],
  "contributors": ["github-handle"],
  "notes": "Free text. Explain anything surprising."
}
```

A source has `kind`, `ref` and `date` (`YYYY-MM-DD`). `firmware` is optional. `by` is the GitHub
handle of whoever produced the evidence; it's optional, except where `maintainer-verified` relies
on it. Handles compare case-insensitively, as on GitHub. `via` is set only by the build (§11), and
CI rejects it in authoring files. For `probe` and `measurement` sources, `ref` is the evidence
file's path relative to `data/`: `evidence/<profile id>/<file>.json`.

| Source `kind` | Meaning | Counting |
| --- | --- | --- |
| `probe` | Inspector push → pull round-trip. `ref` points to an evidence file in `data/evidence/`. | ✔ |
| `vendor-docs` | Published spec / manual / SDK | ✔ |
| `vendor-app` | Observed in the vendor's own app (UI limits, captured traffic) | ✔ |
| `measurement` | Acoustic measurement of the realized response. `ref` points to the measurement data in `data/evidence/`. | ✔ |
| `handler-code` | Inferred from a device-bridge encoder (wire limits only) | ✘ |
| `community` | Reported without evidence | ✘ |

A vendor app's UI limits can be narrower than what the firmware accepts. Edifier's app restricts
each band to a frequency window the device doesn't enforce, for example. `vendor-app` evidence
therefore proves a safe subset of the domain, not necessarily all of it.

**Status.** It records who checked the evidence, as well as what evidence exists (DECISIONS D28).
A counting source is one whose kind is marked ✔ and that has no `via`: evidence about a base or a
sibling device doesn't verify this one.

| `status` | Meaning | CI requires |
| --- | --- | --- |
| `draft` | Not checked against the device or vendor material: seeded, inferred from handler code, or reported without evidence | — |
| `community-verified` | A contributor checked it and supplied evidence. A maintainer reviewed the evidence but didn't reproduce it. | ≥ 1 counting source |
| `maintainer-verified` | A maintainer checked it personally, on their own hardware or against vendor docs | ≥ 1 counting source whose `by` is listed in `MAINTAINERS` |
| `deprecated` | Superseded. Still served, so the id keeps resolving. | `replacedBy` |

`sources` is always non-empty. The verification levels are ordered
`draft` < `community-verified` < `maintainer-verified`. A consumer that only needs a yes/no treats
both `*-verified` values as verified. `meta.status` covers everything except `realization`, which
carries its own sources (§8).

## 11. Inheritance (authoring files only)

Source files under `data/` MAY use:

- `"abstract": true`. The file is a base only. It is never published and needs no `match` or `device`.
- `"extends": "<id>"`. Start from that profile and apply this file's keys on top: top-level keys
  replace; `band` merges per key (§5.2 rule); `bands` merge by index: for each slot this file
  overrides, its keys replace the base's keys for that slot, again per key, and the base's
  overrides of other slots stay. `match`, `device`, `meta` and `id` are **never inherited**,
  because provenance of the base doesn't transfer silently. `meta.sources` of the base are copied
  into the published file, after the file's own, with `"via": "<id of the file that declared
  them>"`. They are shown for context and never count toward the profile's status (§10).
- `realization` is inherited like any other top-level key. Its sources are marked `via` too, so an
  inherited realization counts as unmeasured (§8).
- `schemaVersion` of the published file is the highest one in the chain, because it states what
  the flat profile needs (§15).

Chains are allowed (at most 4 `extends` hops) with no cycles. **Published profiles MUST NOT
contain `extends` or `abstract`.** The build flattens them, so consumers never implement
inheritance. A file with `extends` needs `id`, `meta` and (unless abstract) `device`; everything
else may be inherited. A file with neither `extends` nor `abstract` is a complete profile.

## 12. Examples

### A. Edifier W830NB: value set, odd steps (from handler code)

```jsonc
{
  "schemaVersion": "1.0", "id": "edifier-w830nb", "kind": "hardware",
  "device": { "brand": "Edifier", "model": "W830NB" },
  "match": { "bluetooth": [{ "namePrefix": "EDIFIER W830NB" }] },
  "bandCount": 4,
  "band": {
    "types": ["PK"],
    "freq": { "values": [20, 50, 75, 76, 77, 100, 150, 175, 200, 400, 500, 1000, 1500,
                         2000, 3000, 3078, 4000, 5000, 6000, 8000, 10000] },
    "q":    { "min": 0.5, "max": 5, "step": 0.07142857142857142 },
    "gain": { "min": -6, "max": 6, "step": 0.25 }
  },
  "preamp": { "mode": "none" },
  "meta": { "status": "draft",
    "sources": [{ "kind": "handler-code", "ref": "devicePEQ edifierUsbSerial.js", "date": "2026-10-02" }],
    "notes": "Write-only device. The frequency list is the handler's lookup table of captured samples, not the device's set: upstream protocol notes report 1 Hz granularity and 20 Hz-20 kHz on every band, with per-band windows imposed only by the vendor app. The bluetooth namePrefix is a placeholder until confirmed." }
}
```

### B. JDS Labs Element IV: type-partitioned slots

```jsonc
{
  "bandCount": 12,
  "band": { "types": ["PK"], "freq": { "min": 20, "max": 20000 },
            "q": { "min": 0.1, "max": 10 }, "gain": { "min": -12, "max": 12 } },
  "bands": [
    { "index": [0, 1],   "types": ["LSC"], "label": "Lowshelf" },
    { "index": [10, 11], "types": ["HSC"], "label": "Highshelf" }
  ]
}
```

`assign` puts LSC filters into slots 0–1, PK into 2–9 and HSC into 10–11, which is exactly what the
handler does by hand today.

### C. Partitioned frequency windows (Nothing-style; values illustrative)

```jsonc
{
  "bandCount": 4,
  "band": { "types": ["PK"], "q": { "min": 0.5, "max": 3, "step": 0.1 },
            "gain": { "min": -6, "max": 6, "step": 0.5 } },
  "bands": [
    { "index": 0, "types": ["LSC", "PK"], "freq": { "min": 20,   "max": 200 } },
    { "index": 1,                         "freq": { "min": 200,  "max": 1000 } },
    { "index": 2,                         "freq": { "min": 1000, "max": 4000 } },
    { "index": 3, "types": ["PK", "HSC"], "freq": { "min": 4000, "max": 20000 } }
  ],
  "rules": [{ "type": "ascendingFrequency" }]
}
```

### D. Gain-dependent frequency window (AirPods-style; values illustrative)

```jsonc
"band": {
  "types": ["PK"],
  "freq": { "min": 20, "max": 20000 },
  "gain": { "min": -12, "max": 12, "step": 0.5 },
  "q":    { "min": 0.5, "max": 4 },
  "variants": [{ "when": { "gain": { "gt": 0 } }, "freq": { "min": 200, "max": 8000 } }]
}
```

### E. 10-band graphic, hybrid-capable

```jsonc
{
  "bandCount": 10,
  "band": { "types": ["PK"], "q": { "value": 1.41 }, "gain": { "min": -10, "max": 10, "step": 1 },
            "freq": { "value": 1000 } },
  "bands": [ { "index": 0, "freq": { "value": 31 } }, { "index": 1, "freq": { "value": 62 } } ]
  // … one override per slot
}
```

### F. Chip family base plus device (authoring form)

```jsonc
// data/bases/walkplay-scheme16.json
{ "abstract": true, "id": "walkplay-scheme16", "schemaVersion": "1.0", "kind": "hardware",
  "bandCount": 10,
  "band": { "types": ["PK", "LSC", "HSC"], "freq": { "min": 20, "max": 20000, "step": 1 },
            "q": { "min": 0.1, "max": 10 }, "gain": { "min": -10, "max": 10 } },
  "preamp": { "mode": "manual", "gain": { "min": -12, "max": 0 } },
  "meta": { "status": "draft", "sources": [{ "kind": "handler-code", "ref": "…", "date": "2026-10-02" }] } }

// data/profiles/truthear/truthear-keyx.json
{ "extends": "walkplay-scheme16", "id": "truthear-keyx", "schemaVersion": "1.0", "kind": "hardware",
  "device": { "brand": "Truthear", "model": "KEYX" },
  "match": { "usb": [{ "vendorId": "0x3302", "productName": "KEYX" }] },
  "meta": { "status": "draft", "sources": [{ "kind": "handler-code", "ref": "…", "date": "2026-10-02" }] } }
```

(Vendor ids and model strings in F are placeholders until the importer fills real ones.)

### G. Software target, unbounded

```jsonc
{ "id": "equalizer-apo", "kind": "software", "device": { "brand": "Equalizer APO", "model": "Parametric" },
  "bandCount": null,
  "band": { "types": ["PK", "LSC", "HSC", "LPQ", "HPQ", "BP", "NO", "AP"],
            "freq": { "min": 1, "max": 24000 }, "q": { "min": 0.01, "max": 100 }, "gain": { "min": -30, "max": 30 } },
  "preamp": { "mode": "manual", "gain": { "min": -30, "max": 30 } } }
```

### H. Realization laws (Fosi-style; values illustrative)

```jsonc
{
  "bandCount": 10,
  "band": { "types": ["PK", "LSC", "HSC"], "freq": { "min": 20, "max": 20000, "step": 1 },
            "q": { "min": 0.1, "max": 10 }, "gain": { "min": -12, "max": 12, "step": 0.1 } },
  "realization": {
    "laws": [
      { "law": "gainScaledQ", "types": ["PK", "LSC", "HSC"] },
      { "law": "shelfFrequencyShift", "types": ["LSC", "HSC"], "designRate": 48000 }
    ],
    "sources": [{ "kind": "community", "ref": "devicePEQ compensation.js, Fosi Audio DS3 config",
                  "date": "2026-10-02" }]
  }
}
```

A PK filter written as `q: 4, gain: -12` sounds like Q ≈ 2. To get a real Q of 4 at −12 dB, write
Q ≈ 8 (`toWritten`). The domain allows at most 10, so the realized Q tops out at about 5 at ±12 dB.
The only source is `community`, so the realization counts as unmeasured.

## 13. Engine semantics

The reference implementation is `packages/core` (TypeScript, zero dependencies). Ports to other
languages implement this section and pass the conformance vectors (§13.8).

Apps hold filters that describe the response the user wants. The operations fit together like this:

- **Writing to an engine:** `fit` (§13.6) → `complete` (§13.7) → the bridge encodes the written
  values.
- **Reading from an engine:** the bridge decodes written values → `toRealized` (§13.3).
- **Editing:** `validateList` (§13.4) flags problems without changing anything.

### 13.1 `resolveSlot(profile, i, filter?) → EffectiveSlot`

1. Merge `band` with the override for `i` (§5.2).
2. If `filter` is given, select variants per §6 using the filter's current values.
3. Return `{ types, freq, q, gain }` as domains, plus `locked` flags per field.

### 13.2 `project(value, domain, field) → value` (exact)

- **Range:** `clamp(x, min, max)`.
- **Stepped:** `c = clamp(x, min, max)`, `k = floor(c/step + 0.5)`, `v = k·step`; if `v > max` then
  `v -= step`; if `v < min` then `v += step`. Implementations SHOULD normalize output to 10 decimal
  places. Write `floor(x + 0.5)`, not a language's `round`: their half-way behaviour differs.
- **Set:** the nearest value. Distance is `|ln(a/b)|` for `freq` and `q` and `|a − b|` for `gain`
  and `preamp`. Ties go to the lower value.
- **Locked:** the value.
- **Type:** keep it if allowed, otherwise use the first entry of the slot's `types`.

### 13.3 `toRealized(profile, filter) → Filter`, `toWritten(profile, filter) → Filter` (exact)

`toRealized` maps written values to the filter the engine actually produces. `toWritten` is its
inverse: the values to write so that the engine produces the given filter. Both are the identity
when the profile has no `realization`, or when no law applies to the filter's type.

- `toRealized`: `type` and `gain` are unchanged. `freq` goes through the `freq` law, if any. `q` is
  multiplied by every `q` law's factor, each evaluated on the written values.
- `toWritten`: `type` and `gain` are unchanged. Invert the `freq` law first, since it needs only
  `gain`: `f = (designRate/π) · atan(tan(π·f_r / designRate) / d)`. Then divide `q` by the product
  of the `q` factors, evaluated at the written `freq` just computed.

Neither function projects, so results may fall outside the domains. `fit` (§13.6) handles that.

### 13.4 `validate(profile, slots, preamp) → Violation[]` (normative, exact)

Input: an **already-assigned** array of **written** filters `(Filter | null)[]` of length
`bandCount` (or any length when unbounded). Validation is exact and identical across implementations because it doesn't
depend on assignment. For each non-null slot: type allowed; each field a member of its effective
domain, with variants resolved against the filter's own values. Then rules, then preamp.

```ts
type Violation = {
  slot: number | null;               // null = profile-level (rule, preamp, band count)
  field: 'type' | 'freq' | 'q' | 'gain' | 'preamp' | null;
  code: 'type-not-allowed' | 'out-of-range' | 'off-grid' | 'not-in-set' | 'locked'
      | 'too-many-bands' | 'rule-violated' | 'unknown-rule' | 'unknown-type';
  rule?: string;                     // for rule codes
  allowed?: Domain | string[];       // what would have been valid
};
```

`validateList(profile, filters, preamp)` takes the app's filters and runs `toWritten` + `assign` +
`validate`, adding `too-many-bands` for unassigned filters. It is the convenience API apps call
while editing. Not normative, because it inherits `assign`.

### 13.5 `assign(profile, filters) → { slots, unassigned }`

Maps a list of written filters onto slots. Inactive filters (§7) are dropped first.

- **Normative property:** if an assignment exists in which every filter's type is allowed and all
  fields are in-domain, `assign` MUST return such an assignment.
- **Reference algorithm:** if all slots are identical (the homogeneous fast path), keep list order.
  Otherwise, min-cost bipartite matching (Hungarian, O(n³), fine up to the ~128 slots of large
  graphic EQs). The cost is the sum of normalized projection distances per field, plus a large
  penalty for a disallowed type. Ties break by (filter index, slot index).
- Exact output is **informative**: other implementations may pick a different valid assignment.

### 13.6 `fit(profile, filters, preamp) → FitResult`

```ts
type FitResult = {
  slots: (Filter | null)[];      // written values: what to send to the engine
  realized: (Filter | null)[];   // toRealized(slots): what the listener gets
  preamp: number; changes: Change[]; unassigned: Filter[]; feasible: boolean;
};
```

Input: the app's filters, i.e. the response the user wants.

1. `toWritten` each filter, then `assign`.
2. Per slot, starting again from the wanted filter: project the type. Then, for each field in
   topological order (§6 variant edges plus §8 law edges), compute its written value from the
   wanted value and the fields already final, and project it onto its domain resolved against those
   fields.
3. Rules, on written values. `minSpacing`: walk active filters by ascending freq; if a gap is too small, move the
   higher filter up to `prev · 2^octaves` and re-project it; if it still violates, mark infeasible
   and leave the filter as is. `ascendingFrequency`: re-run assignment with filters ordered by freq,
   then check again.
4. Project preamp.

`changes` compares each wanted filter with its realized result.

**Normative properties**, enforced by property tests and conformance vectors. With `F = fit(x)`:

- Sound: `F.feasible ⇒ validate(F.slots) = []`.
- Faithful: `validateList(x) = [] ⇒ F.realized = x` (within ε), with no changes.
- Idempotent: `fit(F.realized) = F`.
- `fit` never increases the number of active filters.

Without `realization`, `toWritten` and `toRealized` are the identity, so valid input comes back
unchanged and `fit(fit(x)) = fit(x)`.

`fit` does **not** approximate curves. Folding a parametric curve onto a graphic EQ well means
re-optimizing against the target response (AutoEQ's job), using the per-slot domains this format
provides. Optimizers SHOULD evaluate candidates through `toRealized`, so they aim at the response
the listener gets.

### 13.7 `complete(profile, slots, preamp) → Filter[]` (hardware write path)

Returns exactly `bandCount` written filters, filling empty slots with a **neutral** filter:

- type: the first gain-using type in `types` (prefer `PK`);
- gain: `project(0, gain)` (if that isn't 0, the slot can't be neutral, so emit a warning);
- freq: the locked value if locked; otherwise, under `ascendingFrequency`, a value strictly between
  its neighbours within the domain; otherwise the geometric centre of the domain, projected;
- q: `project(1.0, q)`.

### 13.8 Conformance

`conformance/v1/*.json`: `{ description, profile, op, input, expect }`.

- **Exact ops:** `resolveSlot`, `project`, `toRealized`, `toWritten`, `validate`. Output must match
  within ε.
- **Property ops:** `assign`, `fit`, `complete`. The vector gives the input; the check is the
  properties above, not a fixed output.

An implementation is conformant for a schema minor version if it passes every vector for it.

`conformance/v1/profiles/` holds **format** conformance, for validators rather than engines:
`examples/` (the §12 examples as complete profiles, all valid) and `cases/` (one or more per rule
of §2–§11, each listing the issue codes it must produce, or none). Its `README.md` defines the
case format. The issue codes are listed in `ISSUE_CODES` of `packages/core`.

## 14. Published artifacts

| Path | Content |
| --- | --- |
| `/v1/index.json` | `{ schemaVersion, dataVersion, generatedAt, profiles: [{ id, kind, brand, model, engine, status, match, path, sha256, bytes }] }`. It includes `match`, so clients can identify a device without fetching every profile. |
| `/v1/profiles/<id>.json` | One flattened profile. |
| `/v1/bundle.json` | Every non-deprecated profile in one file, for apps that embed a snapshot (Android). |
| `/v1/schema/profile.schema.json` | The JSON Schema. |
| `/v1/conformance/` | Vectors. |

`dataVersion` = `YYYY.MM.DD-<short git sha>`. Profiles are cacheable by `sha256`.

## 15. Versioning and compatibility

- **Major** (`v1` → `v2`): new URL prefix. The old prefix stays frozen and served for ≥ 12 months.
- **Minor** (`1.0` → `1.1`): additive only (new optional fields, rule types, filter types,
  realization laws). Each profile's `schemaVersion` states the minimum it needs.
- Consumers run **lenient** structural checks at runtime, never the strict CI schema, so newer
  minors don't break older apps. Unknown keys are ignored. Unknown **rule** types, **filter** types
  and **realization laws** are surfaced to the user (§7, §8), never silently dropped.
