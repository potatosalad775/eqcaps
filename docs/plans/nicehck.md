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

1. **Record each device** with the recorder: open the device's page, **Read all**, then change a
   band, the pre-gain and each control once in the app and press **Snapshot**. Save to
   `test/recordings/`. Expected disagreements to settle:
   - the product names: add `productName` to each match entry, which also makes room to give
     `0x4322` back to the SchemeNo16 group for other vendors' devices;
   - the commit (Walkplay's own app agrees with NICEHCK's; see [walkplay.md](walkplay.md)): the app ends a write with `[1,0x0A,4,0,0,FF,FF]`, `[1,0x01]`, the pre-gain,
     `[1,0x04]`; the handler sends devicePEQ's `[1,5,0]`, `[1,0x17,0]`, `[1,0x0A,…]`, `[1,1,1,0]`.
     The app calls `[1,0x01]` (padded `[1,1,0,0]`) "save to flash", and the handler's
     `setEnabled(false)` sends the same bytes, so it may save rather than turn the EQ off. Check by
     ear after a push from the handler (uniPEQ) whether the EQ applies and survives a replug, and
     what `setEnabled(false)` does. If they differ, give `walkplay-hid` a `commit` option rather
     than a new handler;
   - whether shelves work (the app only writes peaking; devicePEQ wrote shelves to the Octave);
   - the default slot: the handler writes 101, which the app shows as "custom". The app's own
     custom presets start at 32.
2. **Octave**: add its controls (`dacFilter`, `micGain`, `leftGain`, `rightGain`) and the app's
   limits, once someone with an Octave records it; its capture test pins its current shape.
3. **Status.** Once a recording agrees with the data, the device's profile becomes
   `community-verified`.
4. **Ids.** `nicehck-10th-anniversary-edition` and the brand: the app files StringSnow, Tears and
   the 10th Anniversary Edition under YUANDAO. Ids are permanent once published (invariant 4), so
   settle brand and ids before this branch merges.
