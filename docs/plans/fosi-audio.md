# Fosi Audio and device controls

Started 2026-10-28. Support Fosi Audio's devices as their official web control center
(cc.fosiaudio.com) drives them: the DS3's 32-band firmware, its presets and pre-gain, and its
settings besides the EQ (volume, gain, DAC filter, upsampling, USB mode, game mode, LED). Those
settings became device controls, format 1.2 (SPEC §9.1, D49). The control center is read for facts
only (D25) and cited as a `vendor-app` source; it was read again on 2026-11-26, as served that day.

The owner's DS3 was recorded with the WebHID recorder (`tools/userscripts/`, Fosi adapter
`fosi-cc`), and both its profiles are `maintainer-verified`: `fosi-audio-ds3` (firmware 1.4.15 and
later, 32 bands) and `fosi-audio-ds3-8-band` (earlier firmware). The C1, C3, ZH1 and ZH3 have no
profile yet.

## The control center

- The firmware is read with 0xA6. A preset's pre-gain is read with 0x8B and written with 0x8C,
  which keeps the preset name.
- USB mode 0 is UAC 2.0 and 1 is UAC 1.0. In UAC 2.0 the DS3 is `0x152a:0x889b`, which the ZH3
  shares, so every Fosi match entry needs `productName`.
- User presets are ids 7–9 on every firmware. The app calls them Custom1–3, whatever the device
  says. The device names the built-in presets; the app knows Jazz, Pop, Rock, Classic, R&B, 3A
  Game and FPS.
- Turning the EQ on turns upsampling off, and the reverse. Volume is 0–60, and the app warns above
  50.

## The DS3, recorded

On 2026-10-28, in UAC 2.0 and UAC 1.0, on the owner's device before and after its update
(`test/recordings/2026-10-28-fosi-audio-ds3.json` on 1.4.6, `…-1.6.10.json` on 1.6.10, which also
holds the app's writes from a by-ear test):

- 10 presets on both firmwares: the built-in 0–6, named JAZZ, POP, ROCK, CLASIC (sic), R&B, 3A
  Game and FPS, with 8 bands each, and the user presets 7–9 with 8 or 32.
- Pre-gain per preset already on 1.4.6, −24 to 0 dB in the app.
- In UAC 1.0 the DS3 is `0x20b1:0x80d5` (XMOS's vendor id), and the DAC filter answers there.
- The EQ still applies in FPS and 7.1 on 1.6.10.

On 2026-10-29, on 1.6.10 in UAC 2.0, with the control center sending the commands: `0x8B 0xFF`
answers the active preset in the `0x8B` layout (byte 2 the index), and it followed every `0x8A`
select, with the EQ on or off. The EQ switch (`0x9E`) is separate state.

## The C1, C3, ZH1 and ZH3 (2026-11-26)

- **The same EQ protocol.** The C1, C3, ZH1 and ZH3 send the DS3's EQ commands (0x8A to 0x92, the
  same band layout). They edit within the same limits: 20–20000 Hz, ±30 dB, Q 0.1–20. Each reads
  8 bands per preset, built-in or user.
- **The 10 bands were another EQ.** The C1's and C3's game mode has an EQ of its own, with 10
  bands, its own presets and its own commands. That is where an earlier read's 10 bands for the C3
  came from. Listing it would be the device's other EQ (D53).
- **The C3** has bass and treble controls, and an FPS mode and spatial audio that turn the EQ off
  (`disablesEq`).
- **Pre-gain.** The ZH1 and ZH3 clamp it to −50…0 dB.
- **The ZH1** now sets its other settings through a protocol of parameters by address; its EQ is
  unchanged.
- **Matching.** The ZH3's match needs a product name. The app takes "Fosi Audio ZH3", "ZH3" or
  "Fosi ZH3", in any case.
- **What blocks a profile.** The app can't give a device's preset layout. It asks the device how
  many presets it has and how many are built in (0x91), and writes only to the presets after the
  built-in ones. The handler writes to slot 7 unless told otherwise: the DS3's first user preset,
  which may be a built-in one on another model.

## Next

1. **Inspector support.** T2 read also reads the firmware and the controls, shows them, and
   records both in the evidence file: `device.firmware` comes from the device rather than the
   user, and the read experiment gets a `controls` entry. The bridge's `DeviceReader` has
   `firmware` and `readControls`, never `writeControl` (D40, 2026-11-22). When matches differ only
   by firmware, the inspector reads the firmware and matches again. INSPECTOR.md §2 and §6 change
   to match. Raw recordings stay with the userscript, which records the vendor's own traffic; the
   inspector would only record ours.
2. **The C1, C3, ZH1 and ZH3** get no profile until one of two things happens: a device of each
   answers 0x91 (a recording), or the handler writes where the app does, after the built-in count
   0x91 reports. That second route is a bridge change and needs a release.
3. **The Q8 and DA30** use other protocols and would each need a handler.
