# Walkplay's own app, against walkplay-hid

`walkplay-hid` was ported from devicePEQ, and NICEHCK's app ([nicehck.md](nicehck.md)) disagreed
with it in places. Walkplay's own apps are the reference for the chip. Both are read for facts only
(D25: facts may become data; nothing is copied) and cited as a `vendor-app` source:

- the web app, peq.szwalkplay.com ("TTGK", the platform of NICEHCK's devices too), read on
  2026-10-28;
- the Android app, version 2.3.1, package `com.ttgk.musicbox`, read on 2026-11-12, with its
  [product catalog](#the-product-catalog-2026-11-12).

The maintainer has a CrinEar Protocol Micro (scheme 11) and NICEHCK's devices, which speak the
same 0x4B protocol. No scheme 17 or 19 device is at hand.

State (2026-11-12): every Walkplay group, and 12 of the 19 device profiles of other brands, follow
Walkplay's apps; seven stay on devicePEQ's shape (Next 7). Schemes 17 and 19 are on
`ktmicro-usb-hid`, as the Android app drives them. Q and pre-gain take the web app's limits, wider
than the Android app's. Nothing of it is confirmed on a device beyond what the two
maintainer-verified profiles read. Since 2026-11-01 a push writes as the vendor apps do (D50): the
bands, the apply and save, then the pre-gain and `[1,0x04]`, as NICEHCK's app was recorded doing.
devicePEQ's commit also sent `[1,5,0]` and `[1,0x17,0]`, which belong to the app's factory reset,
and they reset a Tanchjim Space II's DAC settings (tanchjim.md). The WebHID recorder's
`walkplay-peq` adapter records the web app; the recording tests check its writes with NICEHCK's
write checks, not yet its snapshots (Next 4).

## What the app does

- **The app picks the chip family from the product's scheme number**: S17 and S22 → KT02H20, S19
  and S23 → KT0231H, S21 → CB1300D, S24 → CB1100AU (another protocol), S26 → KT1213, S27 →
  CX31993, S28 and S2801 → MT2000; **every other scheme (S10, S11, S15, S16, S18, …) → CB**, the
  0x4B protocol `walkplay-hid` speaks. The KT, CX and MT families are other chips (some 10-byte
  frames, some with a CRC), not covered here.
- **Writing the EQ** (CB): the band frames, then `[1,0x0A,4,0,0,FF,FF]`, which applies it; saving
  adds `[1,0x01,0]`, which writes it to flash, a second later. NICEHCK's app writes the same apply
  and save frames (nicehck.md). A band frame carries the pre-gain in byte 34 and the preset tag in
  byte 35; the pre-gain command is `[1,3,2,0,dB]`. Coefficients: RBJ, Q2.30,
  `[b0,b1,b2,−a1,−a2]` at 96 kHz, as the handler's.
- **`[1,0x05,n]` and `[1,0x17,0]` appear only in the factory reset** (`[1,5,1]`…`[1,5,4]` after
  writing default bands). There is **no EQ on/off command** in the app.
- **Reads**: firmware `[0x80,0x0C]` (ASCII from byte 3); tag `[0x80,9,0]` (byte 35); pre-gain
  `[0x80,3,2,0,0]` (byte 4); mic gain `[0x80,2,0]` (byte 4, s8); DAC filter `[0x80,0x11]`, work
  mode `[0x80,0x1D]`, gain mode `[0x80,0x19]` (byte 3); balance `[0x80,0x16,2,ch,0]` (dB in byte 5,
  the high byte of the ×256 value); noise reduction `[0x80,0x1B,0]` (byte 3).
- **Control writes**: DAC filter `[1,0x11,1,v]` (1 FAST-LL … 5 NON-OS), work mode `[1,0x1D,1,v]`,
  gain mode `[1,0x19,1,v]` (0–2), balance `[1,0x16,4,ch,0,−dB,0]` (one channel cut, the other 0),
  mic gain `[1,0x02,2,0x80,dB]`, noise reduction `[1,0x1B,1,v]` followed by a save to flash.
- Filter types LS 1, PK 2, HS 3, LP 4, HP 5. Schemes 11, 13 and 20 have no high shelf in either
  app; scheme 21 has one in the Android app and none in the web app.
- **The editor's limits.** Android app, 2026-11-12: Q up to 5, pre-gain −8 to +4 dB in whole dB.
  The web app is wider: a scheme 11 device read back Q up to 10 and a pre-gain from −16 to +6 dB
  through it (below). The band count per scheme, as the app gives it for its products (sampled,
  three products per scheme): 10: 8, 11: 8, 13: 8, 15: 8, 16: 10, 17: 5, 18: 10, 19: 6, 20: 10,
  21: 8, 24: 10, 25: 10, 26: 15, 28: 15. Types: PK, LS, HS, LP, HP, less the high shelf above.
- **Schemes 17 and 19 are KT Micro register devices** in the Android app (2.3.1), not the CB
  protocol devicePEQ uses for them (the first bullet):
  - Scheme 17: 5 bands from register 0x26, the frequency stored as half the Hz, types PK, LS, HP,
    LP. Scheme 19: 6 bands from register 0x35, whole Hz, types PK, HS, LS, HP, LP.
  - Every type byte is written with bit 3 set (code + 8) and read back masked.
  - After each write the app waits up to 1 s for the answer and goes on whatever it is.
  - After the bands it writes 1 to register 0x24 (17) / 0x34 (19), the register Kiwi Ears' firmware
    uses as the EQ switch, which Kiwi's app writes before the bands.
  - Then its own preset index to register 0x02 (17) / 0x16 (19).
  - Then the "DAC offset" slider: scheme 17 register 0x3b as a 1.5 dB step (−6 to +3 dB offered),
    scheme 19 register 0x57 in dB (−12 to 0).
  - Save adds the commit. Editor limits: 20 to 20000 Hz, ±10 dB in 0.1 steps, Q 0.1 to 5.
  - Not driven here: the microphone EQ and ADC gain, the flash erase.
- CB1300D (S21) adds an ADC (mic) EQ on cmd 0xDA in the band layout, 3D sound, reverb and modes
  (input reports 0x22–0x26, 0xD3), and scales its mic gain as 32767/15 per dB.

## On a device

- **Read-backs** behind the two maintainer-verified profiles. Band count and types agree with the
  app on both.
  - CrinEar Protocol Micro (scheme 11), read through the web app on 2026-10-03
    (`data/evidence/crinear-protocol-micro/2026-10-03-3f3bd4.json`): Q up to 10 and a pre-gain
    from −16 to +6 dB in whole dB, where the base's limits come from. Only its gain range (±15) is
    its own.
  - EarAcoustic Audio OSHUN DECO, 2026-10-04: Q 9.8984375 on band 1, which fits the base. Its
    gain, frequency, Q and pre-gain limits were skipped in that read, so they are the base's, not
    checked on the device.
- **Mic gain** (2026-10-31), on the Protocol Micro (CB, firmware 0.2;
  `test/recordings/2026-10-31-crinear-protocol-micro*.json`, then every whole and half dB from −15
  to +15 written and read back). The field is s16 ×256 dB, as NICEHCK's app writes it; the device
  rounds it to the nearest 1.5 dB from −15 to +15 and answers that. Walkplay's app sends its
  whole-dB slider value + 0.5 (`[1,2,2,0x80,dB]`) and nothing after it; NICEHCK's follows with
  `[1,0x04]`. The NICEHCK PureAural rounds the same way (1.5 dB from −12 to +12, though NICEHCK's
  app offers whole dB). It ignores a request sent within about 50 ms of `[1,0x04]`, and for up to
  about 250 ms after a work mode switch (0x1D); it varies. Not seen yet: whether an unsaved change
  survives a replug.
- **No EQ switch** (2026-10-31). Neither vendor app has one, and the handler's off (`[1,1,0,…]`,
  the apps' save) left the EQ audibly on on the PureAural and the Protocol Micro, so `canEnable` is
  false for every Walkplay device.

## Differences and open disagreements

- **Pre-gain in band frames.** The app writes the pre-gain into byte 34 of every band; the handler
  writes 0 there, so a push without `preamp` may reset the pre-gain to 0. Unconfirmed (Next 2).
- **Balance read length** is 2 in Walkplay's app and 4 in NICEHCK's. The handler sends 4, and
  matches the answer on the channel byte only.
- **Q and pre-gain limits: Android app against web app** (2026-11-12). The Android app's editor
  stops at Q 5 and a pre-gain of −8 to +4 dB; the web app held Q up to 10 and a pre-gain from −16
  to +6 dB in whole dB on the Protocol Micro (above). devicePEQ's captures of the Protocol Max
  (pre-gain +6 dB), the ddHiFi DSP Cable (−9 dB), the CS43131 HiFi Audio DSP (−10 dB) and the
  Quark2 (a band with Q 6) are outside the Android app's limits. A base must not be narrower than
  what the vendor's web app sets and a device holds, so `walkplay-app` takes the wider of the two.
  Whether the web app's limits differ by scheme is not known.
- **The Kiwi Ears AD1** is under scheme 17 in the catalog, but Kiwi Ears' own app writes it whole
  Hz; its own profile wins (D43).
- **The preset index of schemes 17 and 19.** The bridge doesn't write the app's preset index: there
  is no meaningful index to write, so the app may show a stale selection.

## The product catalog (2026-11-12)

Walkplay's Android app (version 2.3.1, package `com.ttgk.musicbox`), read for facts only (D25),
has a product catalog. `data/catalogs/walkplay.json` keeps a trimmed snapshot of it, refreshed by
the maintainer (D51, D52), and the groups' `match.usb` is generated from it, with a hand-kept
`extra` list of what only devicePEQ `0617f38` has.

- **What a product has:** vendor id, product id, scheme number, brand, model, title and update
  time.
- **The numbers, 2026-11-12:** 442 products under 15 vendor ids, 413 of them `0x3302`. By scheme:
  10: 2, 11: 175, 13: 46, 15: 16, 16: 95, 17: 37, 18: 23, 19: 18, 20: 2, 21: 18, 24: 2, 25: 2,
  26: 1, 28: 4, and scheme 1: 1 (a test row, product id `0xEEEE`). One row has a malformed product
  id (`0x43H1`).
- **2026-11-26:** 450 products: 8 added and 3 renamed, none removed and none moved scheme. Scheme
  28 now has 5 rows, still with no group (another chip family). Two of the new products have names
  of their own, Joy2Hear AA080 (scheme 21) and Strauss & Wagner (scheme 11). Like the catalog's
  other named products, they are left to their scheme's group.
- **Against devicePEQ's saved copy** (`walkplayPreprocessor/walkplay.json`, 367 products, newest
  2026-08-07): 75 new products, none removed, and one that moved scheme (`0x3302:0x39e0`, 16 to
  18). devicePEQ's `updateDeviceConfig.py` only merges that saved file into one vendor list and
  per-scheme product lists, where the groups' old cross product came from.
- **Limits of the catalog.**
  - Many brand and model names are placeholders ("TBD", "Need Update").
  - It misses products that exist: NICEHCK's StringSnow, Tears and 10th Anniversary Edition are
    absent or unnamed.
  - It lists products eqcaps drives with other handlers (several Moondrop `0x35d8` devices, Kiwi
    Ears AD1), so a scheme number alone doesn't prove the `walkplay-hid` protocol.
  - Schemes 24, 25, 26 and 28 have no group profile here. 24, 26 and 28 are other chip families
    (the first bullet of "What the app does"). 25 isn't in that list: the web app as read on
    2026-10-28 would drive it as CB, or predates it.

## Next

1. **Record** a Walkplay-scheme device in this app: connect, change a band and save, change each
   control, snapshot. That shows the commit and the controls on the wire, and the scheme number.
   NICEHCK's recordings (nicehck.md) show the apply and save frames, but nothing scheme-specific:
   the chip family a scheme picks, noise reduction, the high-shelf exclusions.
2. **Pre-gain in byte 34**: write the pre-gain there when given, and decide what a push without one
   sends (read it first, or refuse).
3. **Controls**: add `noiseReduction` (toggle, 0x1B). An app that changes a control may need to
   save it (`[1,1,0]`).
4. A snapshot checker for `walkplay-peq`.
5. **Schemes 24, 25, 26 and 28** (2, 2, 1 and 5 catalog products on 2026-11-26; 10, 10, 15 and 15
   bands): a group profile each, or none, once a handler for their chip family exists. Read the web
   app again for the family of S25, still unknown.
6. **Device profiles for named catalog products** (D37), starting with the schemes the bridge
   already drives. Check each against its vendor's app first: the catalog also lists devices
   eqcaps drives with other handlers.
7. **Seven device profiles of other brands** stay on devicePEQ's shape, each with the reason in its
   notes. They move when a product id or a name places them.
   - ddHiFi HiFi DSP Audio with PD, Moondrop HiFi with PD, Moondrop MD-QT-042 and Truthear KEYX: no
     catalog row carries their name.
   - Walkplay CS43198 HiFi DSP Audio: the name is the title of catalog rows in scheme 11 and in
     scheme 16.
   - Walkplay ES9039 HiFi DSP Audio: no row has the name; the nearest rows are in schemes 15 and
     18.
   - NICEHCK Octave: its product id 0x39c3 is not in the catalog, and NICEHCK's own app is its
     reference (nicehck.md).
8. **Confirm on a scheme 17 or 19 device**: the frequency halving, the type bit, and whether a push
   without the preset index leaves the app usable.
