# EQ Constraint Profile Format: v1

> **Status: frozen as v1 (format 1.0) on 2026-10-03** ([DECISIONS D36](DECISIONS.md)). This file is
> the single place the format is defined. From here on it changes only by minors that add
> (§15); anything else needs v2. Published under `/v1/`.
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
| **Written value** | A field's value as the engine is told it, in canonical units. Domains, rules and validation are about written values. |

**Units are fixed:** `freq` in Hz, `gain` and `preamp` in dB, and `q` dimensionless as defined by
the RBJ Audio EQ Cookbook for the filter type. Profiles never carry device-native units. Authors
fold in every conversion that depends only on the value itself: bandwidth in octaves → Q, raw
register values → dB. If the native grid becomes non-uniform after conversion, enumerate it with
`values`. How the engine's filters sound is out of scope (§8): domains hold what the engine is
told, as its own software means it, and a difference between that and the filter it produces is
never folded in, even a constant one (DECISIONS D39).

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
  "preamp": { },                         // §9
  "channels": "linked",                  // §9
  "protocol": { },                       // §9, hardware only
  "meta": { }                            // §10
}
```

| Field | Req. | Notes |
| --- | --- | --- |
| `schemaVersion` | ✔ | `"1.<minor>"` |
| `id` | ✔ | `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 64 chars, conventionally `<brand>-<model>[-<engine>]`. **Permanent public API.** |
| `kind` | ✔ | `software` profiles describe app EQs (Equalizer APO, Wavelet, Poweramp…). They have no `match` and are selected by id. |
| `device` | ✔ | `brand`, `model` required; `aliases` (marketing names, regional names) optional, used for search only. `group: true` marks a group profile (§3); hardware only, default `false`. |
| `engine` | – | Free label ("PEQ", "Graphic EQ", "Line out"). |
| `match` | hw | §3 |
| `bandCount` | ✔ | `null` only for `kind: software`. |
| `band` | ✔ | After merging with `bands`, every slot MUST define `types`, `freq`, `q`, `gain`. |
| `bands` | – | §5.2 |
| `rules` | – | default `[]` |
| `preamp` | ✔ | §9; `{ "mode": "unknown" }` is allowed and honest. |
| `channels` | – | default `"linked"` |
| `protocol` | – | §9; hardware only. How the device bridge drives the device. |
| `meta` | ✔ | §10 |

Keys starting with `x-` are extensions. They are allowed anywhere and ignored by consumers. Any
other unknown key fails CI validation, but **consumers MUST NOT reject** a profile for unknown keys
(forward compatibility, §15).

The structural rules are in `schema/v1/profile.schema.json` (published files) and
`schema/v1/source.schema.json` (authoring files, §11). Authoring files point `$schema` at the
source schema by relative path. The build replaces it with the published URL above.

## 3. Identity and matching (`match`)

Entries are OR-ed; fields within one entry are AND-ed. A field may list several values, and then
holds if any of them matches.

```jsonc
"match": {
  "usb": [
    { "vendorId": "0x2972", "productId": "0x0047" },
    { "vendorId": "0x2972", "productName": "FIIO FX17 " },     // exact, trailing space is real
    { "vendorId": ["0x0a12", "0x2972"], "productName": ["FIIO BTR17", "BTR17"] }  // 4 combinations
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
- `vendorId`, `productId`, `productName`, `name` and `namePrefix` take one value or a non-empty
  list of distinct values. An entry with lists stands for every combination of its fields'
  values: the entry above matches both names under both vendor ids. Writing it as four entries
  means the same.
- USB ids are lowercase 4-digit hex strings. A `usb` entry MUST have `vendorId` plus at least one
  of `productId` / `productName`. Vendor-only matching is too broad, because chip vendors like
  Walkplay ship under dozens of brands.
- A `bluetooth` entry MUST have `name` or `namePrefix`. `serviceUuid` alone is never sufficient.
  UUIDs are written in lowercase canonical form.
- `productName` and `name` compare exactly (case- and whitespace-sensitive).
- **Specificity** (higher wins): vid+pid+name = 4, vid+pid = 3, vid+name = 3, bt name = 2,
  bt namePrefix(+uuid) = 1, by the fields the entry has, whether they list one value or several.
  At equal specificity a profile that isn't a group profile beats a group profile. On a remaining
  tie, the consumer presents a choice and never picks silently.
- `firmware` compares by dotted-numeric order: split on non-digits, compare components numerically,
  missing components = 0. If the device's firmware is unknown, `firmware` is ignored and ties are
  resolved by choice. `firmware` has at least one bound, and when it has both, `min` MUST be less
  than `max`; otherwise no firmware matches.
- CI rejects two non-deprecated profiles whose match entries have a combination in common (the
  same fields with the same values) and whose firmware ranges overlap, unless their `engine`
  labels differ.

**Group profiles.** A profile with `device.group: true` stands for several products that its match
can't tell apart: devices sharing a chipset's firmware scheme, or a default product name that many
brands ship. Its `brand` and `model` name the group ("Walkplay", "SchemeNo16 devices"), not a
product. A profile for one of those products wins over the group: by specificity when its entry
is more specific (typically adding the product name), and otherwise because the group yields at
equal specificity (a product matched by vendor id and name ties with a group matched by vendor id
and product id). A consumer MAY tell the user that
the matched profile is generic and that their exact model isn't listed. A device profile for a
group member SHOULD extend the base the group extends rather than the group itself, since a group
shrinks or is deprecated as its members get their own profiles. `group` is never inherited (§11).

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

Whether an engine's filters match these definitions is out of scope (§8). So are coefficient
quantization and biquads computed by the bridge at an assumed sample rate; both belong to the
bridge.

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
  `in`. A condition on a null or missing field is false. Comparisons use the §4 tolerance: `eq`
  holds if `near(x, c)`, `gt` if `x > c` and not `near(x, c)`, `gte` if `x > c` or `near(x, c)`
  (`lt`, `lte` alike). A gainless type's `gain` counts as 0 (§5.3).
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

Rules apply to written values. A filter is **active** if its type uses gain and `gain ≠ 0` (not
`near(gain, 0)`), or if its type is gainless.

Unknown rule types: a consumer MUST tell the user that the profile has rules it cannot enforce. On
the hardware write path it MUST NOT present the result as device-conformant, though it MAY write
after explicit confirmation.

Candidates for v1.x, not in v1: `maxResponse` (peak of the combined response plus preamp ≤ X dB,
which needs filter math in every engine) and a gain budget. There is deliberately no general
expression language (DECISIONS D11).

## 8. Realization (not in v1)

A profile says which values an engine accepts, not how the filters it builds from them sound. Some
engines are reported to build a different filter from the cookbook meaning of the values they
take, by a constant factor (a band placed ×0.9775 off the frequency sent) or by one that depends on
another field (a Q that narrows as gain grows)
([prior-art §2.1](research/prior-art.md#21-realization-compensation-devicepeq-upstream)). v1
records neither: such behaviour changes with firmware and vendor customization, only acoustic
measurement shows it, and vendor apps don't correct for it. Domains hold what the engine is told
(§1), and consumers send the values the user asks for. A reported quirk may be noted in
`meta.notes` (DECISIONS D39).

## 9. Preamp, channels and protocol

```jsonc
"preamp": { "mode": "manual", "gain": { "min": -12, "max": 0, "step": 0.5 } }
"preamp": { "mode": "auto" }       // the device computes its own headroom
"preamp": { "mode": "none" }       // no preamp control; the app should warn on boost
"preamp": { "mode": "unknown" }    // e.g. seeded data
```

`channels`: only `"linked"` (one filter set drives both channels) in v1. `"independent"` is
reserved for per-channel engines.

**Protocol (`protocol`).** Which handler of the device bridge (`packages/device-bridge`) drives the
device, and the settings that differ between the devices one handler drives. Hardware only. The
engine never reads it (§13), and it never describes the wire itself: frame layouts, commands and
wire grids are the handler's (D42).

```jsonc
"protocol": {
  "handler": "fiio-usb-hid",                     // required: a bridge handler id
  "options": { "reportId": 1, "saveCommand": "0x21" }, // the handler's settings for this device
  "presets": [{ "id": 0, "name": "Jazz" }, { "id": 160, "name": "USER1" },  // EQ memories
              { "id": 240, "name": "BYPASS", "bypass": true }],
  "disconnectOnSave": false,                     // the device drops the connection after a save
  "baudRate": 57600,                             // serial devices, where the default doesn't fit
  "experimental": true                           // the protocol is unconfirmed for this device
}
```

- `handler` and the keys of `options` are the bridge's vocabulary, documented in its README. CI
  checks every profile's `protocol` against the bridge's handlers.
- `presets` ids are the device's own preset numbers, unique within the list. They are unrelated to
  the profile's filter slots (§5).
- `bypass: true` marks the preset that turns the EQ off: it holds no filters, and selecting it is
  how the device's EQ is switched off. At most one preset is marked. An app offers it as an off
  switch, not as a memory to write filters to.
- A consumer that doesn't know the handler, or an option, MUST treat the device as having no
  protocol it can drive (never guess one), and MUST NOT reject the profile for it (§15).
- A hardware profile without `protocol` is one no handler drives (the RME ADI-2 series is
  controlled over MIDI SysEx).

## 10. Provenance (`meta`)

```jsonc
"meta": {
  "status": "community-verified",        // draft | community-verified | maintainer-verified | deprecated
  "replacedBy": "some-other-id",         // required iff deprecated
  "sources": [
    { "kind": "vendor-app", "ref": "JDS Labs Core app 1.2, EQ page limits",
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
CI rejects it in authoring files. For `measurement` sources, `ref` is the evidence file's path
relative to `data/`: `evidence/<profile id>/<file>.json`. Other kinds may cite an evidence file
too, such as a guided read of the vendor's app (`vendor-app`, INSPECTOR §3) or a read-back
(`community`), and any `ref` that starts with `evidence/` must be such a path. Otherwise `ref` is
free text or a URL.

| Source `kind` | Meaning | Counting |
| --- | --- | --- |
| `vendor-docs` | Published spec / manual / SDK | ✔ |
| `vendor-app` | Observed in the vendor's own app (UI limits, captured traffic), described in `ref` or recorded in an evidence file (a guided read) | ✔ |
| `measurement` | Acoustic measurement of the device's response, showing which values take effect. `ref` points to the measurement data in `data/evidence/`. | ✔ |
| `handler-code` | Inferred from a device-bridge encoder (wire limits only) | ✘ |
| `community` | Reported without counting evidence, such as a device's read-back of the values it holds (INSPECTOR §2 T2), which says nothing about limits | ✘ |

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
| `maintainer-verified` | A maintainer checked it personally, on their own hardware or against vendor docs | ≥ 1 counting source with `by`. The maintainer approving the change confirms that `by` is a maintainer. |
| `deprecated` | Superseded. Still served, so the id keeps resolving. | `replacedBy` |

`sources` is always non-empty. The verification levels are ordered
`draft` < `community-verified` < `maintainer-verified`. A consumer that only needs a yes/no treats
both `*-verified` values as verified.

## 11. Inheritance (authoring files only)

Source files under `data/` MAY use:

- `"abstract": true`. The file is a base only. It is never published and needs no `match` or `device`.
- `"extends": "<id>"`. Start from that profile and apply this file's keys on top: top-level keys
  replace; `band` and `protocol` merge per key (§5.2 rule), so a base can name the handler and a
  device add its presets; `bands` merge by index: for each slot this file overrides, its keys
  replace the base's keys for that slot, again per key, and the base's overrides of other slots
  stay. `match`, `device`, `meta` and `id` are **never inherited**,
  because provenance of the base doesn't transfer silently. `meta.sources` of the base are copied
  into the published file, after the file's own, with `"via": "<id of the file that declared
  them>"`. They are shown for context and never count toward the profile's status (§10).
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

## 13. Engine semantics

The reference implementation is `packages/core` (TypeScript, zero dependencies). Ports to other
languages implement this section and pass the conformance vectors (§13.8).

Apps hold filters that describe the response the user wants. The operations fit together like this:

- **Writing to an engine:** `fit` (§13.6) → `complete` (§13.7) → the bridge encodes the written
  values.
- **Reading from an engine:** the bridge decodes written values.
- **Editing:** `validateList` (§13.4) flags problems without changing anything.

Common to every operation:

- A filter is `{ type, freq, q, gain }` in canonical units (§1). Profiles are valid (§2–§11); on
  anything else the result is unspecified.
- **Normalized filters.** A gainless type's `gain` is 0 wherever an operation reads or returns
  it, conditions on `gain` included (§5.3). Unknown types (§15) count as gain-using, so their gain
  is kept and checked.
- **Evaluation order.** A slot's fields are evaluated `type` first, then `freq`, `q` and `gain` in
  topological order of the slot's dependency graph: the variant edges of §6, taken per slot after
  merging. Fields with no path between them keep the order `freq`, `q`,
  `gain`.
- **Tolerance.** Every comparison uses `near` (§4): `a < b` means `a < b` and not `near(a, b)`, and
  `a ≤ b` means `a < b` or `near(a, b)`.

### 13.1 `resolveSlot(profile, i, filter?) → EffectiveSlot` (exact)

1. Merge `band` with the override for `i` (§5.2). When `bandCount` is `null`, every `i ≥ 0` is the
   template; otherwise `i < bandCount`.
2. If `filter` is given, select variants per §6 using the filter's own values.
3. Return `{ label?, types, freq, q, gain, locked }`: the domains, plus
   `locked: { type, freq, q, gain }`, true where exactly one value is allowed (a single type, or a
   freq-locked domain in the sense of §5.4).

### 13.2 `project(value, domain, field) → value` (exact)

- **Range:** `clamp(x, min, max)`.
- **Stepped:** `c = clamp(x, min, max)`, `k = floor(c/step + 0.5)`, `v = k·step`; if `v > max` then
  `v = (k−1)·step`, else if `v < min` then `v = (k+1)·step` (with tolerance, so a `v` that is
  `near` a bound stays). Implementations SHOULD normalize output to 10 decimal places. Write
  `floor(x + 0.5)`, not a language's `round`: their half-way behaviour differs.
- **Set:** clamp to the first and last value, then take the nearest value. Distance is `|ln(a/b)|`
  for `freq` and `q` and `|a − b|` for `gain` and `preamp`. Ties (within tolerance) go to the lower
  value.
- **Locked:** the value.
- **NaN** projects as the field's neutral value would: 0 for `gain` and `preamp`, 1 for `q`, and
  the geometric centre `√(min·max)` of the domain's bounds for `freq`. Infinities clamp.
- **Type:** keep it if allowed, otherwise use the first entry of the slot's `types`.

### 13.3 (not in v1)

Reserved: v1 has no realization (§8), so there is nothing to map between written and realized
values.

### 13.4 `validate(profile, slots, preamp?) → Violation[]` (normative, exact)

Input: an **already-assigned** array of **written** filters `(Filter | null)[]`, where entry `i`
is slot `i` and `null` is empty. Its length may differ from `bandCount`. `preamp` is in dB; it is
left out when the app has none. Validation is exact and identical across implementations because it
doesn't depend on assignment, so the output, order included, is normative:

1. **Slots**, in slot order, for each entry `i < bandCount` (every entry when unbounded) that
   holds a filter:
   - type: `type-not-allowed` (with `allowed: types`) if the slot doesn't allow it; otherwise
     `unknown-type` if it isn't a v1 code (§5.3, §15).
   - then `freq`, `q` and `gain` (`gain` only for gain-using types), each against its effective
     domain, with variants resolved against the filter's own values. Codes: `out-of-range`
     (range or stepped, outside the bounds), `off-grid` (stepped, inside the bounds),
     `not-in-set`, `locked`; `allowed` is the domain. A non-finite value fails its domain.
2. `too-many-bands`, once, if an entry at index `≥ bandCount` holds a filter. Such entries aren't
   checked otherwise.
3. **Rules**, in profile order. A violation names the slot where the rule breaks, with
   `field: 'freq'`, `code: 'rule-violated'` and `rule`, in slot order within each rule:
   - `ascendingFrequency`: walk slots `0 … bandCount−1` with a lower bound, initially none. A
     filter must lie above the bound (strictly, unless `strict` is false), and becomes the bound.
     An empty slot gets the neutral filler of §13.7, whose `freq` domain is resolved against the
     filler's fields evaluated before `freq`. The lowest value of that domain above the bound
     becomes the new bound. For a range whose `min` is below the bound, that's the bound itself,
     still exclusive when strict. If the domain has no value above the bound, the slot breaks and
     the bound stays. When unbounded, empty entries are skipped: `complete` leaves them out.
   - `minSpacing`: sort the active filters by `freq` (ties by slot). Each adjacent pair whose
     `log2` ratio is less than `octaves` breaks at the higher of the two.
   - An unknown rule type gives `unknown-rule` with its `rule`.
4. **Preamp**, if given: in `manual` mode, against the `gain` domain; in `none` mode, anything but
   0 is `locked` with `allowed: { value: 0 }`; in `auto` and `unknown` mode, it isn't checked.

```ts
type Violation = {
  slot: number | null;               // the slot at fault; null for too-many-bands, unknown-rule, preamp
  field: 'type' | 'freq' | 'q' | 'gain' | 'preamp' | null;
  code: 'type-not-allowed' | 'unknown-type' | 'out-of-range' | 'off-grid' | 'not-in-set' | 'locked'
      | 'too-many-bands' | 'rule-violated' | 'unknown-rule';
  rule?: string;                     // rule-violated, unknown-rule
  allowed?: Domain | string[];       // type and domain codes: what would have been valid
  filter?: number;                   // validateList only: index of the input filter
};
```

`validateList(profile, filters, preamp?)` takes the app's filters and runs `assign` +
`validate`. A violation about a slot also carries `filter`, the index of the input filter assigned
to it, and each active filter that got no slot adds a `too-many-bands` violation with its `filter`.
It is the convenience API apps call while editing. Not normative, because it inherits `assign`.

### 13.5 `assign(profile, filters) → { slots, unassigned, slotOf }`

Maps a list of written filters onto slots. Inactive filters (§7) are dropped first. `slots` has
`bandCount` entries (one per assigned filter when unbounded), `unassigned` lists the active
filters that got no slot, and `slotOf[k]` is the slot of filter `k`, or `null`.

- **Normative property:** if an assignment exists in which every filter's type is allowed and all
  fields are in-domain, `assign` MUST return such an assignment.
- **Reference algorithm:** if all slots are identical (the homogeneous fast path), keep list order,
  or frequency order under `ascendingFrequency`. Otherwise, min-cost bipartite matching
  (Hungarian, O(n³), fine up to the ~128 slots of large graphic EQs). The cost of a filter in a
  slot is how far projecting it onto the slot moves it: `|log2|` of the `freq` and `q` ratios plus
  `|Δgain| / 6`, plus a large penalty for a disallowed type. Ties are settled by moving filters to
  lower free slots and restoring list order wherever that costs nothing. Under
  `ascendingFrequency`, when the matched filters' projected frequencies don't ascend, a
  frequency-ordered matching (dynamic programming over filters × slots) replaces it, unless only
  the unordered one is valid.
- **More filters than slots:** the least significant are left out: smallest `|gain|` first,
  gainless filters last, later filters first on ties. A filter that fits only by changing its type
  is left out before one that fits.
- Exact output is **informative**: other implementations may pick a different valid assignment.

### 13.6 `fit(profile, filters, preamp) → FitResult`

```ts
type FitResult = {
  slots: (Filter | null)[];      // written values: what to send to the engine
  preamp: number;
  changes: Change[];             // where the result differs from what was wanted
  unassigned: Filter[];          // wanted filters that got no slot
  slotOf: (number | null)[];     // slot of wanted filter k; null if inactive, flat or unassigned
  feasible: boolean;             // validate(slots, preamp) = []
};
type Change = {
  filter: number | null;         // index of the wanted filter; null for the preamp
  slot: number | null;           // null for the preamp, and for a filter projected flat
  field: 'type' | 'freq' | 'q' | 'gain' | 'preamp';
  wanted: number | string; written: number | string;
};
```

Input: the app's filters, i.e. the response the user wants, and its preamp.

1. `assign` the filters.
2. Per slot, starting again from the wanted filter: project the type. Then project each field, in
   evaluation order, onto its domain resolved against the fields already final. A filter whose gain projects to 0
   is flat: its slot is left empty, and a `gain` change with `slot: null` reports it.
3. Rules. `minSpacing`: walk the active filters by ascending freq; if a gap is
   too small, move the higher filter to the lowest freq its domain allows at or above
   `prev · 2^octaves`, and re-evaluate the fields after `freq`. If that doesn't get it far
   enough, leave the filter as it is; the result is infeasible. `ascendingFrequency`: if the result
   breaks it, redo steps 2–3 with a frequency-ordered assignment, and take that one only if it keeps
   at least as many filters and has fewer violations. Rule compliance is never bought by
   silently dropping a filter.
4. Project the preamp: `manual` projects onto its `gain` domain, `none` gives 0, and `auto` and
   `unknown` keep the value.

`changes` compares each wanted filter with its written result, field by field, then the preamp.

**Normative properties**, enforced by property tests and conformance vectors. With `F = fit(x)`:

- Sound: `F.feasible ⇔ validate(F.slots, F.preamp) = []`.
- Safe: every type and value in `F.slots`, and `F.preamp`, is in its domain. Only
  `rule-violated`, `unknown-rule` and `unknown-type` violations can remain.
- Faithful: `validateList(x) = [] ⇒ F.slots` holds exactly the active filters of `x` (within ε,
  in slot order), with no changes and nothing unassigned.
- Idempotent: `fit(F.slots)` (its non-empty slots) has the same `slots`, `preamp` and `feasible` as
  `F`, and, when `F` is feasible, no changes.
- `fit` never increases the number of active filters.

Some choices above (which assignment wins under `ascendingFrequency`) depend on the input, so one
pass over its own output can choose differently. The reference repeats steps 1–4 on its own
output until the slots repeat an earlier pass (at most 32 passes), and composes the
mapping from wanted filters to slots. Usually that is a fixpoint. On a profile whose rules can never
be met it can be a cycle; the reference then takes the pass in the cycle with the fewest
violations, then the one whose filters are closest to the wanted ones (a min-cost matching
of the two as multisets), then the first in slot order. Idempotence holds by construction: fitting
that result's filters walks the same cycle, the choice depends only on its members, and
the result is at distance 0 from them.

`fit` does **not** approximate curves. Folding a parametric curve onto a graphic EQ well means
re-optimizing against the target response (AutoEQ's job), using the per-slot domains this format
provides.

### 13.7 `complete(profile, slots) → { filters, warnings }` (hardware write path)

Returns exactly `bandCount` written filters (the non-null ones when unbounded). Filled slots pass
through unchanged, and each empty slot gets a **neutral** filler, its fields in evaluation order:

- type: `PK` if allowed, else the first gain-using v1 type in `types`, else `AP` (flat magnitude),
  else the first type;
- gain: `project(0, gain)`; 0 for a gainless type;
- q: `project(1.0, q)`;
- freq: the locked value if locked. Otherwise, under `ascendingFrequency`, a value between its
  neighbours: each run of empty slots is spread evenly in log frequency between the filters around
  it (or the domain bounds), within what the slot's domain and the slots after it allow.
  Otherwise, the geometric centre of the domain, projected.

`warnings` holds `{ slot, code }`: `not-neutral` when the filler is active (the slot can't take
0 dB, or allows only gainless types), and `no-room` when no frequency satisfies
`ascendingFrequency` (the filler then takes its default frequency).

**Properties:** fillers are in their domains, neutral unless a warning says otherwise, and if
`validate(slots)` reports no `ascendingFrequency` violation, neither does
`validate(complete(slots).filters)`.

### 13.8 Conformance

`conformance/v1/<op>.json`, one file per operation:
`{ description, vectors: [{ description, profile, op, input, expect }] }`. `profile` is a path
under `conformance/v1/profiles/` without `.json`, or an RFC 7386 merge patch over
`profiles/base.json` (or over the file its `"$base"` names). `conformance/v1/README.md` defines
`input` and `expect` per operation.

- **Exact ops:** `resolveSlot`, `project`, `validate`. Output must match
  within ε, the order of violations included.
- **Property ops:** `assign`, `fit`, `complete`. The vector gives the input and a few facts about
  it (`expect`); the check is the properties above plus those facts, not a fixed output.

An implementation is conformant for a schema minor version if it passes every vector for it.

`conformance/v1/profiles/` holds **format** conformance, for validators rather than engines:
`examples/` (the §12 examples as complete profiles, all valid) and `cases/` (one or more per rule
of §2–§11, each listing the issue codes it must produce, or none). Its `README.md` defines the
case format. The issue codes are listed in `ISSUE_CODES` of `packages/core`.

### 13.9 Helpers (informative)

`packages/core` also exports `isGraphic(profile)` (§5.4), `describe(profile)` (English summaries
of slots, preamp and rules for UIs) and `unsupported(profile)`, which lists the rule types and
filter types this engine version doesn't know, so a consumer can meet §7 and §15.

## 14. Published artifacts

Each channel holds the files below. `/v1/` is the format's channel, and the only one served. A
future major gets its own (§15).

| Path | Content |
| --- | --- |
| `index.json` | `{ schemaVersion, dataVersion, generatedAt, profiles: [{ id, kind, brand, model, aliases?, group?, engine?, status, replacedBy?, match?, protocol?, path, sha256, bytes }] }`, one entry per profile, deprecated ones included, sorted by id. It includes `match` and `protocol`, so clients can identify and drive a device without fetching every profile. `path` is relative to the index. |
| `profiles/<id>.json` | One flattened profile. |
| `bundle.json` | `{ schemaVersion, dataVersion, generatedAt, profiles: [...] }`: every non-deprecated profile in one file, for apps that embed a snapshot (Android). |
| `schema/profile.schema.json` | The JSON Schema. |
| `conformance/` | Fixtures and vectors (§13.8). |

`dataVersion` = `YYYY.MM.DD-<short git sha>`, from the commit the data was built from.
`schemaVersion` of the index and the bundle is the format version the build implements. `sha256`
is the hex SHA-256 of the profile file's bytes, so profiles are cacheable by it. A profile's
`$schema` points at the schema of its channel.

A client treats every artifact leniently (§15): it ignores a document whose major version it
doesn't know, ignores entries and profiles it can't read, and never lets a failure to load reach
the host app: the database enhances an app and never blocks it. The reference client is `packages/client`.

## 15. Versioning and compatibility

- **Major** (`v1` → `v2`): new URL prefix. The old prefix stays frozen and served for ≥ 12 months.
- **Minor** (`1.0` → `1.1`): additive only (new optional fields, rule types, filter types). Each profile's `schemaVersion` states the minimum it needs.
- Consumers run **lenient** structural checks at runtime, never the strict CI schema, so newer
  minors don't break older apps. Unknown keys are ignored. Unknown **rule** types and **filter**
  types are surfaced to the user (§7), never silently dropped.
