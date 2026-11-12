# Walkplay's own app, against walkplay-hid

Started 2026-10-28. Branch `feat/device-controls`, after [nicehck.md](nicehck.md).

## Goal

`walkplay-hid` was ported from devicePEQ, and NICEHCK's app disagreed with it in places. Walkplay's
own web app (peq.szwalkplay.com, "TTGK", the platform NICEHCK's `ttgk_v1` names) is the reference
for the chip. It was read on 2026-10-28 for facts only (D25: facts may become data; nothing is
copied), and its facts are cited as a `vendor-app` source. How it was read is in the maintainer's
private notes (D52). The catalog its backend serves is described in
[the product catalog](#the-product-catalog-2026-11-12).

## What the app does

- **One class per chip family**, chosen from the product's `SchemeNo`, which the app asks its
  backend for by vid/pid: S17 and S22 → KT02H20, S19 and S23 → KT0231H, S21 → CB1300D, S24 →
  CB1100AU (another protocol), S26 → KT1213, S27 → CX31993, S28 and S2801 → MT2000; **every other
  scheme (S10, S11, S15, S16, S18, …) → `CB`**, the 0x4B protocol `walkplay-hid` speaks. The KT, CX
  and MT classes are other chips (some 10-byte frames, some with a CRC), not covered here.
- **Writing the EQ** (`CB`): the band frames, then `[1,0x0A,4,0,0,FF,FF]` ("refresh to memory",
  which applies it); saving adds `[1,0x01,0]` ("refresh to flash") a second later. A band frame
  carries the pre-gain in byte 34 and the preset tag in byte 35; the pre-gain command is
  `[1,3,2,0,dB]`. Coefficients: RBJ, Q2.30, `[b0,b1,b2,−a1,−a2]` at 96 kHz, as the handler's.
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
  through it (disagreement 9). The band count per scheme is what the vendor's product details say
  (sampled, three products per scheme): 10: 8, 11: 8, 13: 8, 15: 8, 16: 10, 17: 5, 18: 10, 19: 6,
  20: 10, 21: 8, 24: 10, 25: 10, 26: 15, 28: 15.
  Types: PK, LS, HS, LP, HP, less the high shelf above.
- **Schemes 17 and 19 are KT Micro register devices** in the Android app (2.3.1), not the `CB`
  protocol devicePEQ uses for them (the table above, first bullet):
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

## Disagreements with walkplay-hid

1. **The commit.** The handler ends a push with `[1,5,0]`, `[1,0x17,0]`, `[1,0x0A,…,0]`,
   `[1,1,1,0]`: devicePEQ's, which looks taken from the reset sequence. In the app, `0x05` and
   `0x17` belong to the factory reset; a push may be resetting something. The app's save is
   `[1,0x0A,4,0,0,FF,FF]` then `[1,1,0]`. NICEHCK's app agrees (its `[1,0x01]`, "save to flash").
2. **`setEnabled`** sends `[1,1,on,slot,0]`, the save command with extra bytes. The app has no EQ
   switch, so the handler's `canEnable` is most likely wrong: off may save rather than bypass.
3. **Pre-gain in band frames.** The app writes the pre-gain into byte 34 of every band; the handler
   writes 0 there, so a push without `preamp` may reset the pre-gain to 0. Unconfirmed.
4. **Mic gain.** Settled 2026-10-31 (below): s16 ×256 dB, as NICEHCK's app writes it; Walkplay's
   app adds 0.5 dB to its slider value.
5. **Balance read length** is 2 in Walkplay's app and 4 in NICEHCK's. The handler sends 4, and
   matches the answer on the channel byte only.
6. **Noise reduction** (0x1B) isn't a handler control yet.
7. **Schemes 17 and 19** (2026-11-12). devicePEQ drives them with `CB`; the app drives them as KT
   Micro register devices. Followed the app (D50): the groups moved to `ktmicro-usb-hid` (Done).
   The catalog lists the Kiwi Ears AD1 under scheme 17, but Kiwi Ears' own app writes it whole Hz;
   its own profile wins (D43).
8. **Bands and types per scheme** (2026-11-12). Against devicePEQ: scheme 13 was 10 bands of
   PK/LS/HS and is 8 of PK/LS/HP/LP; 10, 20 and 21 were PK-only; 15, 16 and 18 gain LP and HP.
   Settled by the app's editor (Done).
9. **Q and pre-gain limits: Android app against web app** (2026-11-12). The Android app's editor
   stops at Q 5 and a pre-gain of −8 to +4 dB; Walkplay's web app, through which the maintainer's
   Protocol Micro (scheme 11) was read on 2026-10-03, held Q up to 10 and a pre-gain from −16 to
   +6 dB in whole dB (`data/evidence/crinear-protocol-micro/2026-10-03-3f3bd4.json`).
   devicePEQ's captures of devices in schemes 11, 15 and 16 hold a pre-gain of +6, −9 and −10 dB and
   a Q of 6, all outside the Android app's limits. A base must not be narrower than what the
   vendor's web app sets and a device holds, so `walkplay-app` takes the wider of the two. Whether
   the web app's limits differ by scheme is not known.

## Status (2026-10-28)

No Walkplay-scheme device is at hand, so nothing above is confirmed on the wire and the handler is
unchanged. What is settled and what waits:

- **Settled from the app's code:** the scheme → chip class table; the apply and save frames; that
  `0x05` and `0x17` belong to the factory reset; that the app has no EQ switch; the read and write
  frames of each control; the coefficient math (it matches the handler's).
- **Waits for a recording:** whether the handler's commit really resets anything (1), what
  `setEnabled` does on a device (2), whether byte 34 sets the pre-gain (3), the mic gain encoding
  per scheme (4).
- **Can be checked sooner on the owner's NICEHCK devices**, which speak the same 0x4B protocol
  (`ttgk_v1`, Walkplay's TTGK platform): 1–3. Push from the handler (uniPEQ), then listen, replug
  and read back. NICEHCK's app writes the same apply and save frames, so its recordings
  (nicehck.md, Next 1) show them on the wire. What they can't show is scheme-specific: the class a
  `SchemeNo` picks, noise reduction, the high-shelf exclusions.

## Status (2026-11-12)

The groups, and 12 of the 19 device profiles of other brands, follow Walkplay's apps (Done). Seven
device profiles stay on devicePEQ's shape because the catalog cannot place them (Next 12). Q and
pre-gain are the web app's limits, wider than the Android app's (disagreement 9). Nothing of it is
confirmed on a device beyond what the two maintainer-verified profiles read, and no scheme 17 or 19
device is at hand. The new `ktmicro-usb-hid` options need a bridge release before this data
reaches `main` (AGENTS.md; Next 11).

## The product catalog (2026-11-12)

Walkplay's Android app (version 2.3.1, package `com.ttgk.musicbox`), read for facts only (D25),
downloads its whole product catalog at startup without a login. A maintainer-only script outside
this repository fetches it into `data/catalogs/walkplay.json` (D51, D52).

- **What a product has:** vendor id, product id, `SchemeNo`, brand, model, title and update time.
- **The numbers, 2026-11-12:** 442 products under 15 vendor ids, 413 of them `0x3302`. By scheme:
  10: 2, 11: 175, 13: 46, 15: 16, 16: 95, 17: 37, 18: 23, 19: 18, 20: 2, 21: 18, 24: 2, 25: 2,
  26: 1, 28: 4, and scheme 1: 1 (a test row, product id `0xEEEE`). One row has a malformed product
  id (`0x43H1`).
- **Against devicePEQ's saved copy** (`walkplayPreprocessor/walkplay.json`, 367 products, newest
  2026-08-07): 75 new products, none removed, and one that moved scheme (`0x3302:0x39e0`, 16 to
  18). devicePEQ has no fetch script. Its `updateDeviceConfig.py` only merges that saved file into
  one vendor list and per-scheme product lists, which is where the groups' cross product came from.
- **Limits of the catalog.**
  - Many brand and model names are placeholders ("TBD", "Need Update").
  - It misses products that exist: NICEHCK's StringSnow, Tears and 10th Anniversary Edition are
    absent or unnamed.
  - It lists products eqcaps drives with other handlers (several Moondrop `0x35d8` devices, Kiwi
    Ears AD1), so a `SchemeNo` alone doesn't prove the `walkplay-hid` protocol.
  - Schemes 24, 25, 26 and 28 have no group profile here. 24, 26 and 28 are other chip classes (the
    table in "What the app does"). 25 isn't in that table: the web bundle read on 2026-10-28 would
    drive it as `CB`, or predates it.
  - Schemes 17 and 19 were on `walkplay-hid`, although the app drives them with other chip classes
    (KT02H20, KT0231H); moved to the KT Micro handler on 2026-11-12 (Done).

What was built (D51): `data/catalogs/walkplay.json`, a trimmed snapshot of the catalog (vendor id,
product id, scheme, brand, model, title, update date; one row per line) with a hand-kept `extra`
list of the match entries the catalog doesn't have, which is what remains of devicePEQ `0617f38`:
the vendor ids the catalog never lists, the few product ids it never lists, and SchemeNo10's
`0x0a12`/`0x2972` with `0x0104`. The commands:

- the maintainer's fetch script, kept outside this repository (D52), downloads the catalog,
  rewrites the snapshot and prints what changed (new, removed, moved scheme, renamed);
- `npm run data:walkplay` (`scripts/walkplay-catalog.ts`) regenerates each group's `match.usb`
  from the snapshot (one entry per vendor id with its real product ids, then the `extra`
  entries) and its `vendor-app` source;
- `npm run check` runs it with `--check`, so a group edited by hand, or a snapshot not applied,
  fails.

The fetch is run by hand, never in CI or on a schedule, and only by the maintainer: it asks a
vendor's backend, the diff needs a person to read it (a new scheme needs a base chosen by hand;
named products may deserve device profiles, D37), and `main` deploys `/v1/` on every push. The
repository builds, checks and tests without it. Device profiles are unaffected: a group yields to
a device profile on the same pair (D43, SPEC §3).

## Done

- **Schemes 17 and 19 on the KT Micro handler** (2026-11-12). `walkplay-schemeno17-devices` and
  `walkplay-schemeno19-devices` extend two new bases, `walkplay-ktmicro-scheme17` and
  `walkplay-ktmicro-scheme19`, on `ktmicro-usb-hid`, and follow what the app does (the section
  above). Four new handler options carry it: `typeFlag`, `enableLast`, `writeWait` and
  `gainRegister` (packages/device-bridge/README.md). The bridge doesn't write the app's preset
  index: there is no meaningful index to write, so the app may show a stale selection. **A bridge
  release must come before this data reaches `main`** (AGENTS.md). Nothing is confirmed on a
  device. Settles Next 8.

- **Twelve device profiles of other brands on the app's shape** (2026-11-12). Placed by the
  catalog, by product id where the profile has one and otherwise by product name, and moved off the
  `walkplay-peq-*` bases:
  - Scheme 11 → `walkplay-app-8-band-no-high-shelf`: CrinEar Protocol Micro, EPZ TP13, Moondrop
    Quark2, Walkplay CS43131 HiFi Audio DSP.
  - Scheme 15 → `walkplay-app-8-band`: BGVP MX1, ddHiFi DSP Cable, Walkplay Dual CS43198, Walkplay
    ES9039.
  - Scheme 16 → `walkplay-app-10-band`: CrinEar Protocol Max, EarAcoustic Audio OSHUN DECO,
    Letshuoer DT04, Walkplay CS431XX.

  Each has the app as a `vendor-app` source and a note on what changed against devicePEQ. Five
  were placed by product name, since they carry no product id: BGVP MX1, DT04, CS431XX, Dual
  CS43198 and ES9039 (the catalog writes the last without the profile's trailing space). What
  changed: DT04 and CS431XX go from 8 bands to 10; the scheme 15 and 16 profiles gain low pass and
  high pass; Q stays up to 10 and the pre-gain narrows from −128…+127 to −16…+6 dB.

  The first attempt took the Android app's narrower limits, and four profiles were held back
  because devicePEQ's captures of them (Protocol Max, pre-gain +6 dB; ddHiFi DSP Cable, −9 dB;
  CS43131 HiFi Audio DSP, −10 dB; Quark2, a band with Q 6) held values outside them. That settled
  disagreement 9: the base was widened to the web app's limits and the four moved.

  The two maintainer-verified profiles keep what their read-backs show:
  - **CrinEar Protocol Micro**: its 2026-10-03 read is where the base's Q and pre-gain limits come
    from, so only its gain range (±15) is its own. Band count and types agree with the app.
  - **EarAcoustic Audio OSHUN DECO**: the 2026-10-04 read-back held Q 9.8984375 on band 1, which
    fits the base. Its gain, frequency, Q and pre-gain limits were skipped in that read, so they
    are the base's, not checked on the device. Band count and types agree with the app.

  Settles Next 12.

- **The other groups follow the app's editor** (2026-11-12). New bases `walkplay-app` (extends
  `walkplay-hid`: Q up to 5, pre-gain −8 to +4 dB in whole dB; widened to Q 10 and −16 to +6 dB
  the same day, disagreement 9), `walkplay-app-8-band`,
  `walkplay-app-8-band-no-high-shelf`, `walkplay-app-10-band` and
  `walkplay-app-10-band-no-high-shelf`. Groups: 10 and 15 → 8-band; 11, 13, 21 → 8-band without
  high shelf; 16, 18 → 10-band; 20 → 10-band without high shelf. What changed against devicePEQ is
  in disagreement 8. Settles Next 6.

- **Mic gain, on a CrinEar Protocol Micro** (scheme 11, CB class, firmware 0.2;
  `test/recordings/2026-10-31-crinear-protocol-micro*.json`, then every whole and half dB from −15
  to +15 written and read back). The field is s16 ×256 dB, as the handler had it; the device
  rounds it to the nearest 1.5 dB from −15 to +15 and answers that. Walkplay's app sends its
  whole-dB slider value + 0.5 (`[1,2,2,0x80,dB]`) and nothing after it; NICEHCK's follows with
  `[1,0x04]`, now the `micGainDone` option, set by the `nicehck-walkplay` base. The Micro's profile
  has the control with a 1.5 dB step. The PureAural rounds the same way (1.5 dB from −12 to +12,
  though NICEHCK's app offers whole dB), and ignores a request sent within about 50 ms of
  `[1,0x04]`, and for up to about 250 ms after a work mode switch (0x1D); it varies. The handler
  doesn't wait for it: every read is sent again each 150 ms until answered (`hidRequest`'s
  `resendMs`), and a control's read-back is read once more before a mismatch counts as rejected
  (`writeControl`). Not seen yet: whether an
  unsaved change survives a replug.

- **No EQ switch** (2026-10-31): `canEnable` is false for every Walkplay device and `setEnabled`
  is gone. Neither vendor app has a switch, and the handler's off (`[1,1,0,…]`, their Save) left
  the EQ audibly on on the NICEHCK PureAural and the CrinEar Protocol Micro. The `enableCommand`
  option is still accepted, and ignored, so profiles published with it load. Disagreement 2 is
  settled.

- Recorder: adapter `walkplay-peq` (snapshot only: Pinia stores `device`, `product` with the
  SchemeNo, `eq`, `filter`, `micphone`, `mf`). `recordings.test.ts` checks its writes with the
  NICEHCK write checks; its snapshots aren't checked yet.

## Next

1. **Record** a Walkplay-scheme device in this app: connect, change a band and save, change each
   control, snapshot. That shows the commit and the controls on the wire, and the SchemeNo.
2. ~~**Fix the commit** once recorded.~~ Done 2026-11-01 without waiting: the vendor app is the
   reference (D50). A push sends the apply and save, then the pre-gain and `[1,0x04]`, as
   NICEHCK's app was recorded doing; devicePEQ's `[1,5,0]`, `[1,0x17,0]` reset a Tanchjim Space
   II's DAC settings (tanchjim.md). Disagreement 1 is settled.
3. ~~**`setEnabled`**: drop it (`canEnable: false`) unless a recording shows a real switch.~~
   Done 2026-10-31 (below).
4. **Pre-gain in byte 34**: write the pre-gain there when given, and decide what a push without one
   sends (read it first, or refuse).
5. **Controls**: add `noiseReduction` (toggle, 0x1B). The Save frame `[1,1,0]` is the one
   `setEnabled(false)` sends (2): an app that changes a control may need to save it.
6. ~~**Data**: the high-shelf exclusion for schemes 11, 13 and 20 against the Walkplay bases.~~
   Done 2026-11-12 (above).
7. A snapshot checker for `walkplay-peq`, once a recording shows the store layout with a device.
8. ~~**Schemes 17 and 19.** The groups are on `walkplay-hid`, but the app drives S17 with KT02H20
   and S19 with KT0231H, other chip classes. Decide whether the groups are wrong, and what the
   catalog's 37 and 18 products are.~~ Done 2026-11-12 (above).
9. **Schemes 24, 25, 26 and 28** (2, 2, 1 and 4 catalog products; 10, 10, 15 and 15 bands): a group
   profile each, or none, once a handler for their chip class exists. Read a newer web bundle for
   the class of S25, still unknown.
10. **Device profiles for named catalog products** (D37), starting with the schemes the bridge
    already drives. Check each against its vendor's app first: the catalog also lists devices
    eqcaps drives with other handlers.
11. **Release the bridge**, then let the scheme 17 and 19 data reach `main`: the new
    `ktmicro-usb-hid` options (`typeFlag`, `enableLast`, `writeWait`, `gainRegister`) are in the
    data, and an older bridge drops a protocol it can't read.
12. ~~**The 19 device profiles of other brands** on the `walkplay-peq-*` bases.~~ 12 moved
    2026-11-12 (Done). Seven stay on devicePEQ's shape, each with the reason in its notes:
    - ddHiFi HiFi DSP Audio with PD, Moondrop HiFi with PD, Moondrop MD-QT-042 and Truthear KEYX: no
      catalog row carries their name.
    - Walkplay CS43198 HiFi DSP Audio: the name is the title of catalog rows in scheme 11 and in
      scheme 16.
    - Walkplay ES9039 HiFi DSP Audio: no row has the name; the nearest rows are in schemes 15 and
      18.
    - NICEHCK Octave: its product id 0x39c3 is not in the catalog, and NICEHCK's own app is its
      reference (nicehck.md).

    They move when a product id or a name places them.
13. **Confirm on a scheme 17 or 19 device**: the frequency halving, the type bit, and whether a
    push without the preset index leaves the app usable.
