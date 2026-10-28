# Fosi Audio and device controls

Started 2026-10-28. Branch `feat/device-controls`.

## Goal

Support Fosi Audio's devices as their official web control center (cc.fosiaudio.com) drives
them: the DS3's 32-band firmware, its presets and pre-gain, and its settings besides the EQ
(volume, gain, DAC filter, upsampling, USB mode, game mode, LED). Those settings became device
controls, format 1.2 (SPEC §9.1, D49). The control center's code is read for facts only, never
copied (D25), and cited as a `vendor-app` source.

## Done

- Format 1.2: `protocol.controls` in SPEC §9.1, the schema, the validator and conformance cases;
  `controlTakes`, `controlPresent` and `eqDisabledBy` in core.
- Bridge: `firmware()`, `readControls()` and `writeControl()` on a device. A handler's `controls`
  is its vocabulary, checked strictly in CI and leniently for apps.
- Fosi handler: firmware (0xA6), the seven controls, pre-gain read (0x8B) and write (0x8C, which
  keeps the preset name), 8 bands from built-in presets, corrected command names (0x91 and 0x92).
- Data: `fosi-audio-ds3` (firmware 1.4.15 and later, 32 bands) and `fosi-audio-ds3-8-band`
  (earlier firmware, extends it).
- WebHID recorder userscript (`tools/userscripts/`, Fosi adapter `fosi-cc`), and
  `recordings.test.ts`, which checks every recording: reads, the app's writes, and the data.
  It is checked itself by a synthetic recording against the fake DS3, and smoke-tested on the
  live page without a device (Pinia found; the DS3 store only exists once a DS3 is connected).

## Next

1. **Record the DS3 in the control center** with the WebHID recorder userscript
   (`tools/userscripts/`): first on the owner's 1.4.x, then again on 1.5.8. Each run is
   **Read all** in UAC 2.0, then the same in UAC 1.0. Also check by ear whether the EQ still
   applies in FPS or 7.1 mode on 1.5.8 (it does on 1.4.x); the bytes can't show that. Save the
   recordings in `packages/device-bridge/test/recordings/`. `recordings.test.ts` then lists every
   disagreement between the handler, the data and the app. Expected:
   - the built-in presets 0–6 aren't in the data yet: add them with the names the device gives;
   - the pre-gain range (−24 in the app, −25 remembered from an earlier version), and whether
     firmware before 1.4.15 has pre-gain at all;
   - whether the DAC filter answers in UAC 1.0.

   Once a recording exists, drop the devicePEQ capture's `CHOSEN` and `NEVER_ASKED` entries in
   `captures.test.ts`, or the capture itself.
2. **Inspector support.** T2 read also reads the firmware and the controls, shows them, and
   records both in the evidence file: `device.firmware` comes from the device rather than the
   user, and the read experiment gets a `controls` entry. `ReadOnlyDevice` gets `firmware` and
   `readControls`, never `writeControl`, and `no-writes.test.ts` checks that. When matches
   differ only by firmware, the inspector reads the firmware and matches again. INSPECTOR.md §2
   and §6 change to match. Raw recordings stay with the userscript, which records the vendor's
   own traffic; the inspector would only record ours.
3. **Status.** Once a recording agrees with the data, the DS3 profiles become
   `community-verified`. The control center source then counts toward verification (D28).
4. **More Fosi devices.** The C1, C3, ZH1 and ZH3 send the same commands in the control center,
   so each can be a data file, plus a handler fix where a command differs. The C1 has the same
   8/32-band split at 1.4.15. The C3 has 10 bands, bass and treble controls, and an FPS mode and
   spatial audio that turn the EQ off (`disablesEq`). The Q8 and DA30 use other protocols and
   would each need a handler.

## Notes from the control center

- USB mode 0 is UAC 2.0 and 1 is UAC 1.0. In UAC 1.0 the DS3 is `0x152a:0x80d5`; in UAC 2.0 it is
  `0x152a:0x889b`, which the ZH3 shares, so every Fosi match entry needs `productName`.
- User presets are ids 7–9 on every firmware. The app calls them Custom1–3, whatever the device
  says. The device names the built-in presets; the app's name table knows Jazz, Pop, Rock,
  Classic, R&B, 3A Game and FPS.
- Turning the EQ on turns upsampling off, and the reverse. Volume is 0–60, and the app warns above
  50.
