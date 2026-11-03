# FiiO Control, against the FiiO profiles

Started 2026-11-03. Branch `feat/device-controls`, after [tanchjim.md](tanchjim.md).

## Goal

The FiiO, Snowsky and JadeAudio profiles came from devicePEQ and were out of date: a user reported
that the Snowsky Tiny A has 10 bands, not 5. FiiO's web app was read for facts only (D25) and is
cited as a `vendor-app` source; the vendor's app is the reference (D50). Nothing here has run on a
device: every profile stays `draft`.

Read on 2026-11-03: fiiocontrol.fiio.com, version 4.3.4 of 2026-10-13, bundle `index-7hb30NUo.js`
and its changelog chunk, as text with plain string searches (minified, not obfuscated), never
executed.

## What the app showed

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
- The official preset API takes encrypted bodies only. It wasn't pursued.

## Done

- `fiio-usb-hid`: the seven type codes, two-byte presets, no band count write.
- `bandCount()` on the device session with `capabilities.readsBandCount`, on `fiio-usb-hid` and
  `fiio-usb-serial`: what the device reports, null when it reports 0 or the read fails. The bridge
  doesn't reconcile it with the profile.
- Bases: `fiio-usb-hid` Q 0.25–8; `fiio-peq-31-band-12db-wide-shelves` Q 0.4–128; new
  `fiio-peq-10-band-12db-shelves`, `-no-all-pass`, `-no-band-pass`, `-all-filters-3-users`.
- Profiles:
  - Tiny A and B: 10 bands.
  - Melody and QX11: −24…+12. Air Link and BT11: ±12, no band-pass, the app's presets.
  - FG3: the app's presets, on a base. Air Amp: Retro (8) for Monitor (7).
  - JIEZI: report id 7. BTR17: saves with `0x19`.
- New profiles: BTR15, BTR19, BTR25, K13, FX25, Game Engine, JD1 Gaming, KG13, Warmer Nano, JK13,
  Trustblu, Mage. **Their 10 bands are an assumption** (the app's default layout, noted in each
  profile), and their product names come from the app's list, which it matches loosely.
- Q7 and DM15 R2R aren't in the app and inherit the base's Q 0.25–8 like the rest of the family.

## Next

Under D50, 2 and 3 don't need a recording to change; they were left because each needs a decision
on what a HID profile means for a device the app drives over serial.

1. **Release**: this adds no handler option or control, so the data can reach `main` first. Until
   apps have the new bridge, it refuses the presets above 255 and the filter types beyond PK, LSC
   and HSC, as it already did for the types. uniPEQ follows the device's count through
   `bandCount()` once it has the release.
2. **K17, K19, K17 R2R**: the app drives them over serial with its own protocol and a heartbeat, and
   they have no global gain, while the profiles say HID with a preamp. devicePEQ's `saveCommand` 0x21
   is gone (2026-11-03), since it is factory reset on the rest of the family, so these save with
   0x19, which the app doesn't send them either: saving is unconfirmed, and the profiles say so.
   A serial handler is the real fix. No K17 R2R profile until then.
3. **K15**: the app uses USER 160–169 and `0xFF` for EQ off, and moved to serial in 4.3.3; the
   profile says USER 7–16 and bypass 240 over HID.
4. **Record with the recorder** (needs an adapter for this Vue app):
   - the band count of the Tiny A and B, LS-TC2, JA11, JIEZI and the new profiles. A device that
     got devicePEQ's or the old bridge's count write may now report the lower number;
   - whether newer firmware checks the frame's sequence and CRC;
   - the product names of the new profiles.
5. **EQ switch `0x1A`**: the app turns it on at connect for BTR17, Oak Nano, FP3, LS-TC2 and FX17,
   and toggles it for models outside its "always on" list. `fiio-usb-hid` doesn't send it, so these
   models have no "EQ off" where no bypass preset exists. An option, if a recording agrees.
6. **Settling time**: the app waits 1 s after selecting a preset on BTR15, BTR19 and BTR25 before
   reading bands. Add it if reads come back stale.
7. **Writable game presets**: the app lets the KG13 edit its game presets and the Mage has
   GAME-USER 416–418. They are read-only here because the save carries one byte.
8. **Modes and variants**: the QX11's game mode (`0x4014`) has its own presets; the BT11 and Air
   Link have "tengtai" variants (`0x4032`, `0x4033`) with their own settings. Same EQ commands, so
   no split yet.
9. **USB ids**: the app's filter also accepts `0x3302:0x3bc0–2`, `0x0a12:0x4007`, `0x0666:0x0888`
   and `0x31b2:0xfff8`, without saying which models use them. Add them when a device shows up there.
