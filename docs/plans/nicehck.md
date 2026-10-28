# NICEHCK and Walkplay device controls

Started 2026-10-28. Branch `feat/device-controls`, after [fosi-audio.md](fosi-audio.md).

## Goal

Support NICEHCK's devices as their official web app (app.nicehck.cn) drives them: the EQ limits it
allows, its firmware read, and its settings besides the EQ (DAC filter, work mode, gain level,
volume, mic gain, channel balance), as device controls (SPEC §9.1). The owner has StringSnow,
Tears, PureAural and the 10th Anniversary Edition to test. The app's code and its public device
config (`nicehck.cn/api/app/v1/device/config-sync`) are read for facts only, never copied (D25),
and cited as a `vendor-app` source.

## What the app showed

- Every device is vendor `0x3302` with protocol variant `ttgk_v1`, which is the Walkplay protocol:
  report 0x4B, `[0x80 read | 0x01 write, cmd, …]`, band cmd 0x09 in the layout `walkplay-hid`
  already decodes, pre-gain 0x03. The Octave capture in `test/captures/` answers exactly as the app
  parses. So no new handler: `walkplay-hid` gained `firmware()` (0x0C, ASCII) and controls.
- Devices and app product ids: StringSnow `0x1291`, Tears `0x129e`, 10th Anniversary Edition
  `0xc200` (8 bands, EQ only; the app tags them "YUANDAO DSP Device"), PureAural `0x4322` (10 bands,
  every control), Octave `0x39c3` (10 bands; DAC filter, mic gain, channel balance). The app matches
  by product id alone, so the USB product names aren't known yet.
- Limits, the same on every device: peaking only, 20–20000 Hz, Q 0.2–12, gain ±12 dB, pre-gain −12
  to +8 dB in whole dB.
- Presets are an app idea. Applying one writes its bands, with its index in byte 35 (official
  presets from 1, the app's custom presets from 32). Game, sleep and diffuse modes are official
  presets written the same way; there is no mode command, so they aren't controls.
- The app shows the channel balance as one slider (−50 to 50) but the device holds a gain per
  channel (0x16, channel byte, s16 ×256 dB), so the data has `leftGain` and `rightGain`.

## Done

- Handler: `walkplay-hid` `firmware()` and controls `dacFilter`, `gainLevel`, `workMode`, `volume`,
  `micGain`, `leftGain`, `rightGain`; `encodeWalkplayBand` and `encodeWalkplayControl` for checks.
- Data: base `nicehck-walkplay` (the app's limits), `nicehck-stringsnow`, `nicehck-tears`,
  `nicehck-10th-anniversary-edition`, `nicehck-pureaural` (format 1.2, with controls). `0x4322`
  left the `walkplay-schemeno16-devices` group, whose match entry was the same.
- Recorder: adapter `nicehck-app` (React hooks, zustand state; **Read all** calls the app's
  connect-time read), `recording-nicehck.ts` checks, and `RecordingReplay` answers on input reports.
  Checked by a synthetic recording against `fake-walkplay.ts`; the adapter's hook walk was
  smoke-tested on the live page without a device.

## Next

1. **Record each device.** PureAural done on 2026-10-28, firmware 0.3, on the owner's device
   (`test/recordings/2026-10-28-nicehck-pureaural.json`); its profile is maintainer-verified.
   The handler reads what the app read, the app's band, pre-gain and control writes are the
   handler's bytes, and the data has the app's limits and controls. Found:
   - USB product name `NICEHCK PureAural`, now in its match entry.
   - The device keeps one report buffer and an answer overwrites only the bytes it fills; the rest
     is what the last request or answer left. The firmware answer has no length (byte 2 is left
     over) and no NUL, and a 0x16 answer sets only the whole dB (byte 5), not byte 4. The handler
     now stops the version at the first non-printable byte and reads 0x16 from byte 5. The app
     doesn't: after some reads it shows the firmware as "0." and a wrong balance (1 for 14).
   - The pre-gain read (0x03) answered +1 before and after the app wrote 0 and -2. Whether the
     write takes is the by-ear check below.
   - After about 6 minutes idle, the device lost the first report sent (band 0 of a preset);
     sent again, it took. See the read-back below.
   - Six mic gain writes in quick succession (keyboard) left it at -4.5 dB; single writes are
     exact. The handler sends one write per change.
   - The app's pre-gain minus button sends the previous value (shows -1, sends 0).
   - The recorder was injected after the app had connected, so it attaches its input listener to
     devices already open. Restoring the settings afterwards (where the idle loss and the mic
     run happened) is cut from the recording: those snapshots hold the device's -4.5 dB and the
     app's stale balance.

   10th Anniversary Edition done on 2026-10-28, firmware 0.3
   (`test/recordings/2026-10-28-nicehck-10th-anniversary-edition.json`), maintainer-verified:
   it agreed with no changes. USB product name `10th Anniversary Edition` (no brand). Its pre-gain
   reads back what the app wrote. It held a custom EQ in slot 101, restored afterwards with the
   handler's frames and read back byte for byte.

   **By ear on the PureAural** (2026-10-28, the handler's frames sent from the page):
   - The handler's commit (`[1,5,0]`, `[1,0x17,0]`, `[1,0x0A,…]`, `[1,1,1,0]`) applies the EQ, and
     it survives a replug. No `commit` option is needed.
   - The handler's pre-gain write (-12 dB) is heard and reads back as written; only the app's
     writes read back +1, cause unknown.
   - `setEnabled(false)` (`[1,1,0,0,0]`) changes nothing: the profile sets `enableCommand: false`,
     so it reports `canEnable: false`.
   - A low shelf is heard as a shelf and reads back as type 1: the device takes shelves, though
     the app only offers peaking. The profiles still list `PK` only, as the app allows.
   - The first push after a replug lost band 0 although the device had just answered reads, so
     the wake-up read wasn't enough. A push now reads its bands back, sends a lost band again
     with the commit, and fails with `rejected` if it still isn't taken.

   Tears done on 2026-10-28, firmware 0.2 (`test/recordings/2026-10-28-nicehck-tears.json`),
   maintainer-verified: it agreed with no changes. USB product name `Tears DSP`. Game mode on
   writes preset 4 and off rewrites the preset before it (3), confirming there's no mode command.
   A positive pre-gain (+3) reads back as written. Its flat EQ in slot 101 was restored with the
   handler's frames.

   StringSnow done on 2026-10-28, firmware 0.4 (`test/recordings/2026-10-28-nicehck-stringsnow.json`),
   maintainer-verified: it agreed with no changes. USB product name `StringSnow DSP`. Sleep mode
   writes preset 6 and off rewrites the preset before it (3). Its custom EQ in slot 101 was
   restored with the handler's frames.

   All four of the owner's devices are recorded. What was expected to settle:
   - Product names: `NICEHCK PureAural`, `StringSnow DSP`, `Tears DSP`, `10th Anniversary
     Edition`, in each match entry. The SchemeNo16 group could take `0x4322` back: the PureAural
     would still win, by specificity (vid+pid+name) and as a non-group profile (SPEC §8). devicePEQ's
     groups come from Walkplay's product catalog (its `walkplayPreprocessor/walkplay.json`, 367
     products with real vendor/product pairs and a SchemeNo each); its generator keeps one vendor
     list and per-scheme product lists, so our groups match every combination (SchemeNo16: 19
     vendor ids × 79 product ids, of which 80 pairs are in the catalog). The catalog lists
     `0x3302:0x4322` as SchemeNo16 with no name; StringSnow, Tears and the 10th Anniversary
     Edition aren't in it. Whether to rebuild the groups from the real pairs is open.
   - The commit: the handler's works (by ear, above); no `commit` option.
   - `setEnabled(false)` doesn't turn the EQ off on the PureAural, and the app has no EQ off
     switch: `enableCommand: false` in the `nicehck-walkplay` base, for every NICEHCK device.
   - Shelves work on the PureAural; the profiles keep `PK`, as the app allows.
   - The default slot: 101 works and the app shows it as "custom", as it does for its own
     custom writes there. It stays.
   - Special modes (Tears' game mode, StringSnow's sleep mode) are preset writes, as assumed.
2. **Octave**: add its controls (`dacFilter`, `micGain`, `leftGain`, `rightGain`) and the app's
   limits, once someone with an Octave records it; its capture test pins its current shape.
3. **Status.** Once a recording agrees with the data, the device's profile becomes
   `community-verified`, or `maintainer-verified` on the owner's devices (PureAural done).
4. **Ids.** `nicehck-10th-anniversary-edition` and the brand: the app files StringSnow, Tears and
   the 10th Anniversary Edition under YUANDAO. Ids are permanent once published (invariant 4), so
   settle brand and ids before this branch merges. Settled 2026-10-28: the brand stays NiceHCK
   (they are sold as NICEHCK products) and the ids stay `nicehck-*`; each profile's notes say
   the app files it under YUANDAO.
