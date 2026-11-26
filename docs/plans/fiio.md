# FiiO Control, against the FiiO profiles

The FiiO, Snowsky and JadeAudio profiles came from devicePEQ and were out of date: a user reported
that the Snowsky Tiny A has 10 bands, not 5. FiiO's web app, fiiocontrol.fiio.com, is the
reference (D50), read for facts only (D25) and cited as a `vendor-app` source: version 4.3.4 of
2026-10-13, read on 2026-11-03, and version 4.4.6 of 2026-11-21, read on 2026-11-26. Nothing here
has run on a device: every profile stays `draft`.

## FiiO Control 4.3.4 (2026-11-03)

- **Band count is mostly not in the app.** It asks the device (`0x18`) and never writes that
  command; only the K17 family is fixed, at 31. So the app can't confirm a count. The Tiny's 10
  comes from [FiiO's announcement](https://www.fiio.com/newsinfo/1082860.html).
- **`0x19` saves, `0x21` is factory reset** (payload `[0]`). devicePEQ called `0x21` the save on
  newer models.
- **Filter types**: `0 PK · 1 LSC · 2 HSC · 3 BP · 4 LPQ · 5 HPQ · 6 AP`.
- **Limits**: Q 0.25–8 (K17 family 0.4–128); gain −24…+12, or ±12 on the models the app lists. UI
  limits, not proven firmware limits.
- **Report id**: 1 on the KA17, 2 on the JA11, otherwise 7 (so the JIEZI is 7, not 2).
- **Presets** are one byte, or two big-endian above 255 (game 257–260, cinema 513). The app's save
  always sends one byte.
- **Frames** carry a sequence number at bytes 2–3 and a CRC before `EE`, where the handler sends
  zeros.

The handler and the profiles follow these. `fiio-usb-hid` doesn't write the band count; it and
`fiio-usb-serial` read what the device reports (`bandCount()`), which the bridge doesn't reconcile
with the profile. Twelve profiles were added from the app's list: BTR15, BTR19, BTR25, K13, FX25,
Game Engine, JD1 Gaming, KG13, Warmer Nano (now the TS13), JK13, Trustblu and Mage. **Their 10
bands are an assumption** (the app's default layout, noted in each profile), and their product
names come from the app's list, which it matches loosely. The Q7 and DM15 R2R aren't in the app
and inherit the base's Q 0.25–8 like the rest of the family.

## FiiO Control 4.4.6 (2026-11-26)

What changed since 4.3.4, per the app and its changelog:

- **TS13**: 4.4.0 renamed the Warmer Nano to the TS13, and the app identifies it by the new name.
  `fiio-ts13` matches both names and replaces `fiio-warmer-nano`. The app drives the TS13 as it
  drives the JK13, and 4.4.6 gave both a Close EQ preset (240).
- **Game Engine Mini** (4.4.3, beta): the app gives it everything it gives the Game Engine (filter
  types, gain range, presets, controls).
- **JadeAudio ROO** (4.3.6, beta; presets updated in 4.4.1): peaking and shelves, ±12 dB, its own
  presets with Close EQ (240).
- **BTR19**: 4.4.0 removed its BYPASS preset (240) as unsupported, and 4.4.5 added Retro and the
  two sDamp presets (8–10). So it has no EQ-off preset.
- **KG13**: 4.4.5 lists HiFi (416), and BYPASS (752) among its game presets. Close EQ (240) stays
  the one marked as the bypass.
- **Oak Nano**: the app knows it as "OAK NANO", a name its profile didn't match.

Every other model the app lists agrees with its profile in filter types, gain range, presets,
report id and HID or serial, except what Next lists: the K17 R2R (on serial, no profile), the K15,
and the QX11's, BT11's and Air Link's modes and variants. The 10 bands of the TS13, Game Engine
Mini and ROO profiles are the app's default layout, as for the profiles of 2026-11-03.

## Next

Under D50, 1 and 2 don't need a recording to change; they were left because each needs a decision
on what a HID profile means for a device the app drives over serial.

1. **K17, K19, K17 R2R**: the app drives them over serial with its own protocol and a heartbeat, and
   they have no global gain, while the profiles say HID with a preamp. They save with 0x19, not
   devicePEQ's 0x21, which is factory reset on the rest of the family, and the app sends them
   neither: saving is unconfirmed, and the profiles say so. A serial handler is the real fix. No
   K17 R2R profile until then.
2. **K15**: the app uses USER 160–169 and `0xFF` for EQ off, and moved to serial in 4.3.3; the
   profile says USER 7–16 and bypass 240 over HID.
3. **Record with the recorder** (needs an adapter for this app):
   - the band count of the Tiny A and B, LS-TC2, JA11, JIEZI and the new profiles. A device that
     got devicePEQ's or the old bridge's count write may now report the lower number;
   - whether newer firmware checks the frame's sequence and CRC;
   - the product names of the new profiles.
4. **EQ switch `0x1A`**: the app turns it on at connect for BTR17, Oak Nano, FP3, LS-TC2 and FX17,
   and toggles it for models outside its "always on" list. `fiio-usb-hid` doesn't send it, so these
   models have no "EQ off" where no bypass preset exists. An option, if a recording agrees.
5. **Settling time**: the app waits 1 s after selecting a preset on BTR15, BTR19 and BTR25 before
   reading bands. Add it if reads come back stale.
6. **Writable game presets**: the app lets the KG13 edit its game presets and the Mage has
   GAME-USER 416–418. They are read-only here because the save carries one byte.
7. **Modes and variants**: the QX11's game mode (`0x4014`) has its own presets; the BT11 and Air
   Link have "tengtai" variants (`0x4032`, `0x4033`) with their own settings. Same EQ commands, so
   no split yet.
8. **USB ids**: the app also accepts `0x3302:0x3bc0–2`, `0x0a12:0x4007`, `0x0666:0x0888` and
   `0x31b2:0xfff8`, without saying which models use them. Add them when a device shows up there.
