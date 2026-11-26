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
  live page without a device (the DS3's state only exists once a DS3 is connected).

## Next

1. **Record the DS3.** Done on 2026-10-28, in UAC 2.0 and UAC 1.0, on the owner's device before and
   after its update (`test/recordings/2026-10-28-fosi-audio-ds3.json` on 1.4.6,
   `…-1.6.10.json` on 1.6.10, which also holds the app's writes from a by-ear test). Both DS3
   profiles are maintainer-verified. Found: 10 presets on both firmwares, the built-in 0–6 named
   JAZZ, POP, ROCK, CLASIC (sic), R&B, 3A Game and FPS with 8 bands each, user presets 7–9 with 8
   or 32; pre-gain per preset already on 1.4.6, −24 to 0 dB in the app; the DAC filter answers in
   UAC 1.0; in UAC 1.0 the DS3 is `0x20b1:0x80d5`; the EQ still applies in FPS and 7.1 on 1.6.10.
   The app's band writes showed that `tidyF32` lost float32 values above 8192 Hz (fixed).

   devicePEQ's DS3 capture is gone from `test/captures/`: the 1.6.10 recording holds band writes.
2. **Inspector support.** T2 read also reads the firmware and the controls, shows them, and
   records both in the evidence file: `device.firmware` comes from the device rather than the
   user, and the read experiment gets a `controls` entry. The bridge's `DeviceReader` has
   `firmware` and `readControls`, never `writeControl` (D40, 2026-11-22). When matches
   differ only by firmware, the inspector reads the firmware and matches again. INSPECTOR.md §2
   and §6 change to match. Raw recordings stay with the userscript, which records the vendor's
   own traffic; the inspector would only record ours.
3. **Status.** Done for the DS3 (maintainer-verified). Other devices recorded by contributors
   become `community-verified` once their recording agrees with the data (D28).
4. **Active preset and EQ switch.** Found on 2026-10-29 on the DS3 (1.6.10, UAC 2.0, through the
   control center's own calls): `0x8B 0xFF` answers the active preset in the `0x8B` layout (byte
   2 the index); it followed every `0x8A` select, with the EQ on or off. The EQ switch (`0x9E`) is
   separate state. So: Fosi `currentSlot()` from `0x8B 0xFF`, and `eqEnabled()` with a
   `readsEnabled` capability, from `0x9E`. uniPEQ shows "Unknown" in Device EQ until then; its
   plan is uniPEQ `docs/plans/device-controls.md`.
5. **More Fosi devices.** The C1, C3, ZH1 and ZH3 send the same commands in the control center,
   so each can be a data file, plus a handler fix where a command differs. The C1 has the same
   8/32-band split at 1.4.15. The C3 has 10 bands, bass and treble controls, and an FPS mode and
   spatial audio that turn the EQ off (`disablesEq`). The Q8 and DA30 use other protocols and
   would each need a handler.

   *2026-11-26*, read again for the control center as served that day:
   - **The same EQ protocol.** The C1, C3, ZH1 and ZH3 still send the DS3's EQ commands (0x8A to
     0x92, the same band layout). They edit within the same limits: 20–20000 Hz, ±30 dB, Q
     0.1–20. Each now reads 8 bands per preset, built-in or user.
   - **The 10 bands were another EQ.** The C1's and C3's game mode has an EQ of its own, with 10
     bands, its own presets and its own commands. That is where the C3's 10 bands came from.
     Listing it would be the device's other EQ (D53).
   - **Pre-gain.** The ZH1 and ZH3 clamp it to −50…0 dB.
   - **The ZH1** now sets its other settings through a protocol of parameters by address; its EQ
     is unchanged.
   - **Matching.** The ZH3 shares `0x152a:0x889b` with the DS3, so its match needs a product
     name. The app takes "Fosi Audio ZH3", "ZH3" or "Fosi ZH3", in any case.
   - **What blocks a profile.** The app can't give a device's preset layout. It asks the device
     how many presets it has and how many are built in (0x91), and writes only to the presets
     after the built-in ones. The handler writes to slot 7 unless told otherwise: the DS3's first
     user preset, which may be a built-in one on another model. So these four get no profile
     until one of two things happens: a device of each answers 0x91 (a recording), or the handler
     writes where the app does, after the built-in count 0x91 reports. That second route is a
     bridge change and needs a release.

   Unchanged: the Q8 and DA30 still need handlers of their own.

## Notes from the control center

- USB mode 0 is UAC 2.0 and 1 is UAC 1.0. In UAC 1.0 the DS3 is `0x20b1:0x80d5` (XMOS's vendor
  id, as recorded; we had assumed `0x152a`); in UAC 2.0 it is `0x152a:0x889b`, which the ZH3
  shares, so every Fosi match entry needs `productName`.
- User presets are ids 7–9 on every firmware. The app calls them Custom1–3, whatever the device
  says. The device names the built-in presets; the app's name table knows Jazz, Pop, Rock,
  Classic, R&B, 3A Game and FPS.
- Turning the EQ on turns upsampling off, and the reverse. Volume is 0–60, and the app warns above
  50.
