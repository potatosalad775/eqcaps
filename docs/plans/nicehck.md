# NICEHCK and Walkplay device controls

Started 2026-10-28. NICEHCK's devices are supported as their official web app (app.nicehck.cn)
drives them: the EQ limits it allows, its firmware read, and its settings besides the EQ (DAC
filter, work mode, gain level, volume, mic gain, channel balance), as device controls (SPEC §9.1).
The app is read for facts only, never copied (D25), and cited as a `vendor-app` source.

The owner has StringSnow, Tears, PureAural and the 10th Anniversary Edition. All four were recorded
in the app on 2026-10-28, and their profiles are maintainer-verified. The Octave waits for someone
who has one (Next).

## What the app showed

- Every device is vendor `0x3302` and speaks the Walkplay protocol:
  report 0x4B, `[0x80 read | 0x01 write, cmd, …]`, band cmd 0x09 in the layout `walkplay-hid`
  already decodes, pre-gain 0x03. The Octave capture in `test/captures/` answers exactly as the app
  reads it. So no new handler: `walkplay-hid` gained `firmware()` (0x0C, ASCII) and controls.
- Devices and app product ids: StringSnow `0x1291`, Tears `0x129e`, 10th Anniversary Edition
  `0xc200` (8 bands, EQ only; the app tags them "YUANDAO DSP Device" and files them under
  YUANDAO), PureAural `0x4322` (10 bands, every control), Octave `0x39c3` (10 bands; DAC filter,
  mic gain, channel balance). The app matches by product id alone.
- Limits, the same on every device: peaking only, 20–20000 Hz, Q 0.2–12, gain ±12 dB, pre-gain −12
  to +8 dB in whole dB.
- Presets are an app idea. Applying one writes its bands, with its index in byte 35 (official
  presets from 1, the app's custom presets from 32). Game, sleep and diffuse modes are official
  presets written the same way; there is no mode command, so they aren't controls.
- The app shows the channel balance as one slider (−50 to 50) but the device holds a gain per
  channel (0x16, channel byte, s16 ×256 dB), so the data has `leftGain` and `rightGain`.

## On the owner's devices (2026-10-28)

Each recording is `test/recordings/2026-10-28-nicehck-<device>.json`.

- **PureAural**, firmware 0.3, USB product name `NICEHCK PureAural`. The handler reads what the app
  read, the app's band, pre-gain and control writes are the handler's bytes, and the data has the
  app's limits and controls.
  - The device keeps one report buffer and an answer overwrites only the bytes it fills; the rest
    is what the last request or answer left. The firmware answer has no length (byte 2 is left
    over) and no NUL, and a 0x16 answer sets only the whole dB (byte 5), not byte 4. The handler
    stops the version at the first non-printable byte and reads 0x16 from byte 5. The app doesn't:
    after some reads it shows the firmware as "0." and a wrong balance (1 for 14).
  - The pre-gain read (0x03) answered +1 before and after the app wrote 0 and -2. The handler's
    pre-gain write (-12 dB) is heard and reads back as written; only the app's writes read back
    +1, cause unknown.
  - The app's pre-gain minus button sends the previous value (shows -1, sends 0).
  - After about 6 minutes idle, the device lost the first report sent (band 0 of a preset); sent
    again, it took. The first push after a replug lost band 0 although the device had just
    answered reads. A push now reads its bands back, sends a lost band again with the commit, and
    fails with `rejected` if it still isn't taken.
  - Six mic gain writes in quick succession (keyboard) left it at -4.5 dB; single writes are
    exact. The handler sends one write per change.
  - The recorder was injected after the app had connected, so it attaches its input listener to
    devices already open. Restoring the settings afterwards (where the idle loss and the mic run
    happened) is cut from the recording: those snapshots hold the device's -4.5 dB and the app's
    stale balance.
- **By ear on the PureAural**, the handler's frames sent from the page:
  - devicePEQ's commit (`[1,5,0]`, `[1,0x17,0]`, `[1,0x0A,…]`, `[1,1,1,0]`) applies the EQ, and it
    survives a replug.
  - The handler's EQ off (`[1,1,0,0,0]`) changes nothing, and the app has no EQ off switch. Since
    2026-10-31 no Walkplay device has the switch (walkplay.md).
  - A low shelf is heard as a shelf and reads back as type 1: the device takes shelves, though the
    app only offers peaking.
- **10th Anniversary Edition**, firmware 0.3, USB product name `10th Anniversary Edition` (no
  brand): it agreed with no changes. Its pre-gain reads back what the app wrote. It held a custom
  EQ in slot 101, restored afterwards with the handler's frames and read back byte for byte.
- **Tears**, firmware 0.2, USB product name `Tears DSP`: it agreed with no changes. Game mode on
  writes preset 4 and off rewrites the preset before it (3), confirming there's no mode command. A
  positive pre-gain (+3) reads back as written. Its flat EQ in slot 101 was restored with the
  handler's frames.
- **StringSnow**, firmware 0.4, USB product name `StringSnow DSP`: it agreed with no changes.
  Sleep mode writes preset 6 and off rewrites the preset before it (3). Its custom EQ in slot 101
  was restored with the handler's frames.

## Choices

- The profiles list `PK` only, as the app allows, though the PureAural takes shelves.
- The default slot stays 101: it works, and the app shows it as "custom", as it does for its own
  custom writes there.
- The brand stays NiceHCK and the ids stay `nicehck-*` (2026-10-28): they are sold as NICEHCK
  products, and ids are permanent once published (invariant 4). Each profile's notes say the app
  files it under YUANDAO.
- Walkplay's catalog lists `0x3302:0x4322` as scheme 16 with no name; StringSnow, Tears and the
  10th Anniversary Edition aren't in it. The PureAural wins over the scheme 16 group, by
  specificity (vid+pid+name) and as a non-group profile (SPEC §8).

## Next

- **Octave**: add its controls (`dacFilter`, `micGain`, `leftGain`, `rightGain`) and the app's
  limits, once someone with an Octave records it; the profile becomes `community-verified` once
  the recording agrees. Its capture test pins its current shape.
