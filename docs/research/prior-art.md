# Prior art and evidence

What existing code and data say about real EQ constraints. Collected 2026-10-02 from
`../modernGraphTool` (commit `fd55b9f8`), `jeromeof/devicePEQ` (local clone `../devicePEQ`, commit
`0617f38`, 2026-08-26) and `jaakkopasanen/AutoEq` (master). This file is the evidence behind the
format decisions in [DECISIONS.md](../DECISIONS.md).

## 1. Existing constraint models

| Source | Shape | Per-slot? | Steps / sets? | Conditional? | Device identity? | Provenance? |
| --- | --- | --- | --- | --- | --- | --- |
| modernGraphTool `EqConstraintPreset` | one global `freq/q/gain` range, `allowPk/Lsq/Hsq`, `mode: graphic \| parametric` | graphic bands only (freq+q) | no | no | no (derived at runtime from `DeviceModelConfig`) | no |
| modernGraphTool `DeviceModelConfig` | `minGain/maxGain/maxFilters/supportsLSHSFilters/supportsPregain`, mixed with protocol fields (`reportId`, `schemeNo`, `baudRate`, slots…) | no | no | no | HID `productName`, `productId` groups | no |
| devicePEQ `peqConstraintsConfig.json` (v1.1.0) | 36 *shape-named* profiles (`peq10Band12dBFullShelves`, `walkplayPeq8Band10dBPkOnly`, …) referenced by 80 `deviceNames` / 10 `deviceGroupNames`, and by device models via `peqConstraintsRef` + per-model `peqConstraintsOverride`; `min/maxGain`, `maxFilters`, `min/maxQ`, `supportsLS/HS/LP/HP/BP/Notch/AllPass/BandStop/ConstantQFilter`, `deviceHandlesPregain`, `supportsManualGlobalGain`, `supportsRead`; non-EQ `extras` (DAC filter, mic gain…) | no | no | no | by device name | no |
| AutoEQ `PEQ_CONFIGS` | `filter_defaults` + `filters[]` (per-filter `type`, fixed `fc`/`q` or `min_/max_fc`, `min_/max_q`, `min_/max_gain`) + optimizer settings. Includes software targets (Spotify, Poweramp, Neutron, USB Audio Player Pro) and devices (Qudelix 5K, miniDSP, Moondrop Free DSP) | **yes** (template + per-filter) | no | no | no | no |

Takeaways:

- Everyone has converged on "band count + gain range + which types". That is the 80% case and must
  stay trivial to author.
- AutoEQ independently arrived at **template + per-slot override**, which validates the draft's
  `band` / `bands[]` structure.
- Nobody models quantization, value sets, conditional domains, cross-band rules, firmware scoping or
  provenance. That gap is the reason for this project.
- devicePEQ names profiles by *shape* and lets devices point at them. That's an implicit form of
  inheritance. We want the same sharing (≈70 Walkplay-chip devices have identical constraints) but
  keyed by device, via `extends` (see SPEC §11). devicePEQ has since added per-model overrides
  (`peqConstraintsRef` + `peqConstraintsOverride`, 106 refs), which is base + override, the same
  shape as `extends`.
- AutoEQ and devicePEQ are both natural **consumers** of a neutral format, not only sources.

## 2. What the device handlers actually encode

The real constraints often live only inside a handler's encoder, as a scale factor, a clamp, or a
lookup table. Survey of `modernGraphTool/src/lib/device-peq/handlers/`, plus handlers that exist
only upstream in devicePEQ (marked *upstream*):

| Handler | Transport | Slots | Read-back | freq on the wire | gain on the wire | Q on the wire | Notable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fiio-usb-hid | HID | 5 or 10 by model | yes | uint16, 1 Hz | ×10 signed → 0.1 dB | ×100 → 0.01 | ~28 model entries, mostly ±12 dB |
| fiio-usb-serial / spp / ble | serial, SPP, BLE | 10 (EH11/13) | yes | uint16, 1 Hz | ×10 → 0.1 dB, ±20 dB | ×100 → 0.01 | |
| walkplay-hid | HID | 5–10 by model | yes (read rounds gain/Q to 0.1) | uint16, 1 Hz | ×256 → 1/256 dB **plus client-computed biquad coefficients** (×2³⁰) | ×256 | **asymmetric gain** ranges per model: −12/+6, −12/+3, −10/+10; ~67 devices matched only by `productId` group |
| moondrop-usb-hid | HID | — | yes (read floors gain to 0.1) | uint16 | 1/256 + client biquad | 1/256 | |
| moondrop-old-fashioned | HID | — | yes | — | int8 ×10 → **[−12.8, +12.7]** | int16 ×1000 | encoding range itself is asymmetric |
| moondrop-edge | SPP | 5 | yes | uint16 | ×60 → 1/60 dB, stored in the *next* band's bytes | ×4096 | |
| ktmicro-usb-hid | HID | — | yes | uint16; halved when `compensate2X` → 2 Hz effective | ×10 → 0.1 dB | ×1000 | sample-rate quirk handled in protocol layer |
| qudelix-usb-hid | HID | — | — | uint16 | ×10 → 0.1 dB | ×100 | experimental |
| topping-usb-hid | HID (unregistered) | — | — | 1 Hz, min 1 | ×2 → **0.5 dB** | ×10000 | |
| fosi-audio-usb-hid | HID feature reports | 10 | yes | float32 | float32 | float32 | |
| jds-labs-usb-serial | serial JSON | **12 = 2 LS + 8 PK + 2 HS** | yes | JSON number | JSON, ±12 | JSON | **type-partitioned slots**; handler assigns filters to slots *by type*, not position; neutral fillers differ per slot type (LS 100 Hz/0.707, PK 1 kHz/1.0, HS 10 kHz/0.707). `maxFilters: 10` in its config is wrong for this device. |
| nothing-usb-serial | SPP | 8 | yes (read rounds gain 0.1, Q 0.01) | float32 | float32 | float32 | wire is unconstrained; any frequency partitioning is **firmware-side and invisible in code** |
| rita-usb-serial | SPP | 12 | yes | uint16, 1 Hz | ×100 → 0.01 dB, ±15 | ×100, min 0.01 | |
| earfun-usb-serial | SPP | 10 | **no (write-only)** | ×3 → **1/3 Hz** | ×100/3 → **0.03 dB** | — | |
| edifier-usb-serial (W830NB) | SPP | 4 | **no (write-only)** | **21-entry lookup table**: 20, 50, 75, 76, 77, 100, 150, 175, 200, 400, 500, 1k, 1.5k, 2k, 3k, 3078, 4k, 5k, 6k, 8k, 10k | ×4 → **0.25 dB**, clamped ±6 | ×14 → **1/14**, clamped 0.5–5 | the table is captured samples, not the device's set (§2.2) |
| conexant-usb-hid (*upstream*) | HID | 9 (defaults at 31 Hz … 8 kHz) | **no** (pull returns defaults) | raw Hz | ×256 → 1/256 dB **plus client-computed biquads** for 4 sample rates | ×256 | Moondrop FreeDSP / Echo-B |
| airoha (Audeze Maxwell) | SPP, BLE | **exactly 10 required** | yes | ×100 → 0.01 Hz | ×100 → 0.01 dB | ×100 | |
| wiim-network | HTTP JSON | 10 | yes | JSON | JSON, ±12 | JSON | modes LSQ/PK/HSQ/Off |
| luxsin-network | HTTP | 10 | yes | JSON | JSON, ±12 | JSON | |

"—" = not checked. Values are from encoder code, i.e. what the **wire format can represent**, not
necessarily what the **firmware accepts**. The two can differ, and only hardware round-trips or
vendor documentation can tell them apart.

### 2.1 Realization compensation (devicePEQ upstream)

Upstream devicePEQ measured (with REW, §5) devices that **realize a different filter from the one
written to them**, and its handlers now compensate on write and undo it on read
(`devicePEQ/compensation.js`). The laws are configured per device model, always as
realized ÷ requested:

| Law | Realized ÷ requested | Configured for | Notes |
| --- | --- | --- | --- |
| Q `rbjGain` | `1/A`, A = 10^(\|gain\|/40) | FiiO QX13, FiiO KA17, Fosi Audio DS3 | measured on peaking filters |
| Q `constant` | fixed ratio (e.g. 0.701) | none yet | |
| Q `cosNyquist` | `cos(π·f/designFs)` | Walkplay SchemeNo11 group | `designFs` is the rate the firmware designs biquads at. Upstream's comments derive ≈ 49 152 from measurements (ratio 0.87 at 8 kHz, 0.52 at 16 kHz), but the shipped config sets 96 000. Unresolved upstream. |
| freq `ratio` | constant factor (0.9775) | Walkplay SchemeNo11 group | upstream's comments attribute it to the same clock mismatch (48 000 / 49 152 ≈ 0.977). KTMicro's legacy `compensate2X` is factor 2. |
| freq `shelfSqrtA` | shelf frequency moves by √A in the prewarped domain (LSC up, HSC down) | Fosi Audio DS3 | |
| shelf `peakingAlpha` | devicePEQ reads the shelf parameter as slope S; the device takes it as Q | FiiO QX13 | **not a deviation in our terms.** Upstream's derived formula is exactly the cookbook's Q ↔ S identity, so the QX13 builds an exact RBJ Q-shelf (`LSC`/`HSC`). |

**How far off, if nothing corrects.** This compares the intended RBJ filter with the filter each law
predicts. Each value is the largest magnitude difference in dB over 20 Hz–20 kHz at 48 kHz
([realization-error.py](realization-error.py)):

| Family (law) | Gentle PK (±3–6 dB, Q 1) | Big PK (±12 dB, Q 2–4) | Narrow treble PK (−6 dB, Q 4, 8–12 kHz) | Shelves (+4–6 dB, Q 0.7) | 7-filter preset |
| --- | --- | --- | --- | --- | --- |
| FiiO QX13 / KA17 (`rbjGain`, peaking only) | 0.3–1.0 | 3.5 | 1.0 | 0 | 0.6 |
| Fosi Audio DS3 (`rbjGain` + `shelfSqrtA`) | 0.3–1.0 | 3.5 | 1.0 | 0.6–1.3 | 1.3 |
| Walkplay SchemeNo11 (`ratio` + `cosNyquist`) | 0.1–0.2 | 0.7–1.4 | 0.9–1.7 | 0.1–0.5 | 0.6 |
| KTMicro `compensate2X` (already corrected by the wire codec) | 2.2–4.3 | 10.6–11.6 | 6.0 | 3.5–3.6 | 7.1 |

The preset is a typical AutoEQ-style IEM correction: LSC 105 Hz +6 dB, PK at 180 Hz, 1.5 kHz,
3.2 kHz, 6 kHz and 8.5 kHz (±2–5 dB, Q 0.9–4), and HSC 10 kHz +2.5 dB. Walkplay ranges cover both
designFs values. In short, gentle presets land within about 1 dB, while large or narrow
corrections don't. The figures inherit the laws' own uncertainty: few measurements, and an
inconsistent SchemeNo11 constant.

The laws read more like **different filter conventions** than defects. `rbjGain` is consistent with
a peaking Q defined at different bandwidth points, `shelfSqrtA` with putting the frequency at the
shelf's corner instead of its midpoint, and `peakingAlpha` is a slope-vs-Q mix-up on the host side.
Measured against our RBJ definitions, all but `peakingAlpha` still change the sound.

In eqcaps (DECISIONS D29, SPEC §8): `rbjGain` → `gainScaledQ`, `cosNyquist` → `nyquistScaledQ`,
`shelfSqrtA` → `shelfFrequencyShift`. Q `constant` and frequency `ratio` are value-only
conversions, folded into domains and applied by the codec. `peakingAlpha` has no counterpart.

Consequences:

- Compensation needs headroom, so the **achievable** range depends on other fields. Under `rbjGain`,
  a device with wire Q ≤ 10 realizes at most Q ≈ 5 at ±12 dB. devicePEQ exposes this as
  `maxRealisableQ(gain)`.
- Read-back returns *stored* values. Probes and read-back see written values, not realized ones.
- modernGraphTool's TS port has none of this except KTMicro's `compensate2X`.
- Resolved by DECISIONS D29: domains describe written values, and the laws are profile data. They
  describe the engine's DSP, not how to talk to it.

### 2.2 Three layers of limits (Edifier W830NB)

devicePEQ's protocol notes (`bluetooth_tools/cli_tools/EDIFIER_*.md`) separate three limits that
can all differ:

1. **Vendor app UI:** Edifier ConnectX restricts each of the 4 bands to its own frequency window.
2. **Firmware:** accepts 20 Hz–20 kHz on any band, ±6 dB, Q encoded as byte = 149 + 14·Q; 1 Hz granularity observed
   (75/76/77 Hz).
3. **Codec:** the 16-bit frequency field follows no formula found so far, so the handler can only
   encode the frequencies it has captured (the lookup table above).

So `vendor-app` evidence can be narrower than the firmware (SPEC §10 says so), and a bridge can be
narrower still. A profile describes layer 2. Codec gaps belong to the bridge.

### Consequences for the format

1. **Quantization is the norm.** Grids seen: 0.01, 0.03, 1/60, 0.1, 1/256, 0.25, 0.5 dB; Q in
   0.001, 0.01, 1/14, 1/256, 1/4096; freq in 0.01, 1/3, 1, 2 Hz. A `step` field is required, and
   non-decimal steps (1/14, 1/3) must work, so equality is tolerance-based (SPEC §4).
2. **Enumerated frequencies exist on real hardware** (Edifier), not only on graphic EQs. Hence
   `values`.
3. **Asymmetric ranges are common** (−12/+6, −12.8/+12.7). `min` and `max` stay independent.
4. **Per-slot types with type-based assignment exist** (JDS Labs). Slot assignment cannot be
   assumed positional. Hence a specified `assign` operation (SPEC §13.5).
5. **Neutral filler values are per-slot** (JDS Labs) and may need to respect cross-band rules. Hence
   `complete` (SPEC §13.7).
6. **"Exactly N filters" devices** (Airoha) need every slot written. `complete` always emits
   `bandCount` slots on the hardware path.
7. **Coefficient-quantized devices** (Walkplay, Moondrop HID) realize a response that depends on
   client-side biquad math at an assumed sample rate. That is a property of the bridge's
   coefficient math, not of the engine, so it stays out of scope (unlike the laws in §2.1).
8. **Write-only devices** (EarFun, Edifier) can't be verified by round-trip. Their profiles need
   other evidence (vendor app, docs, acoustic measurement).
9. **Firmware-side constraints are invisible in code** (Nothing). Only probing or vendor docs reveal
   them. This is the main argument for the inspector's probe mode.
10. **Written ≠ realized** on several measured devices (§2.1), and the gap can depend on gain and
    frequency. Hence written-value domains plus `realization` laws (DECISIONS D29, SPEC §8).
11. **Vendor apps can restrict more than the firmware** (§2.2). `vendor-app` evidence is a safe
    subset, not necessarily the full domain.

## 3. Identity data available to consumers

| API | Identity exposed | Notes |
| --- | --- | --- |
| WebHID | `vendorId`, `productId`, `productName`, `collections` (usages, report IDs/sizes) | `requestDevice({ filters: [] })` lists all non-blocklisted HID devices, which is how an unknown device can be inspected. `productName` can have trailing spaces (`"FIIO FX17 "`). |
| WebSerial | `usbVendorId`, `usbProductId` (USB); `bluetoothServiceClassId` (BT SPP) | no product name. BT SPP devices have **no** stable identity beyond the service UUID, so the user has to confirm. |
| Web Bluetooth | `name`, advertised/GATT service UUIDs | names are often user-renamed ("Alex's EH13"), so treat them as PII in evidence |
| Android USB Host | VID, PID, product/manufacturer strings, serial | same matchers work |
| Android BT | name, MAC, UUIDs | MAC must never be stored |
| Network (WiiM, Luxsin) | HTTP API model string | per-vendor |

Matching must work from any of these. USB VID+PID and/or product string is the strongest signal.
Bluetooth name prefix is weaker. A BT SPP service UUID is weakest.

Vendor id alone is never enough: devicePEQ disabled Topping detection because Topping shares its
USB vendor id with the Fosi Audio DS3.

Android WebView (Capacitor) has none of the browser device APIs above, so the Android app reaches
USB through a native plugin built on the USB Host API (DECISIONS D27).

## 4. Licensing

- modernGraphTool: MIT (© 2026 potatosalad775).
- devicePEQ: 0BSD (© 2024 Jerome O'Flaherty). Handlers carry "Copyright 2024 : Pragmatic Audio".
- AutoEQ: MIT.

All three permit reuse in this repo. Keep attribution in `packages/device-bridge/README.md`,
`THIRD-PARTY-NOTICES.md` and the profile `meta.sources` of anything imported.

devicePEQ's 0BSD covers its own work only. The same repo also holds third-party material that isn't
ours to copy (DECISIONS D25):

- captured vendor web-app bundles: `fiio-js-capture/` (FiiO and Moondrop), `walkplayJS/`,
  `walkplayPreprocessor/walkplay.js`, `Q5K/q5K-chrome-plugin.js` (Qudelix). Each carries embedded
  MIT/ISC library headers and is otherwise vendor code;
- protocol notes reverse-engineered from decompiled vendor apps (`bluetooth_tools/`: Edifier,
  UGreen/JieLi, Sony, Airoha, …), which cite vendor IP.

## 5. Upstream assets worth reusing

All in devicePEQ, under 0BSD unless noted.

| Asset | Where | Use here |
| --- | --- | --- |
| Recorded device captures (≈35, HID and BLE exchanges with device identity) + per-handler tests | `tests/captures/`, `tests/handlers/` | codec regression tests and the virtual device for `device-bridge` (INSPECTOR §4) |
| Mock HID / BLE / network devices | `tests/Mock*.js` | fake-device tests for probe failure paths (PLAN Phase 5) |
| REW-driven verification page and capability test | `testing/html-tools/devicepeq-rew-verification/`, `testing/rew-peq-capability-test/` | prior art for `measurement` evidence; how the compensation laws (§2.1) were derived |
| Browser-native sweep capture (sweep, FFT, deconvolution; rejects clock mismatch) | `devicePEQ/builtin-capture/` | possible later measurement tier in the inspector |
| Protocol notes for devices not yet supported | `bluetooth_tools/cli_tools/*.md` | facts only (see §4) |
