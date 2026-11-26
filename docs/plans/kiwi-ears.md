# Kiwi Ears' web EQ, against ktmicro-usb-hid

Started 2026-11-09, after [tanchjim.md](tanchjim.md). The owner has an **Allegro Mini**; no other
Kiwi Ears device.

The bridge drives Kiwi Ears devices as the app does: each model's register map, its EQ switch,
acknowledgements and delays, peaking only, its ranges, no pre-gain, and global gain as a control
on the KT0211L models. The Allegro Mini is recorded and `maintainer-verified`; the other devices
are unconfirmed.

## The app

Kiwi Ears' web EQ, `https://equalizer.kiwiears.com`, read 2026-11-09 for facts only (D25).

## What the app does

- **Transport**: WebHID, output and input report 0x4B, 10 bytes,
  `[register, 0, 0, 0, cmd, 0, d0…d3]`, usage page 0x000C. `R` 0x52, `W` 0x57, `S` 0x53 save to
  flash, `C` 0x43 clear flash. Every command waits for an echo of register and cmd, 5 s; a write or
  save checks byte 6 against the model's flag and fails on anything else.
- **Three register maps**, chosen by USB id:

  | Model | EQ switch | Bands (freq/gain, Q) | Write flag | Global gain |
  | --- | --- | --- | --- | --- |
  | KT0211L | 0x24 | 0x26/0x27 … 0x2E/0x2F | 3 | 0x3B |
  | KT1132L | 0x34 | 0x35/0x36 … 0x3B/0x3C, 0x3D/0x3F | 0x4F | none |
  | KT3016L | 0x34 | band 0 0x37/38, 1 0x3B/3C, 2 0x3D/3F, 3 0x39/3A, 4 0x35/36 | 0x4F | none |

- **Devices**: `31B2:0111` Allegro Mini; `3302:2017` KT-0211L USB DAC; `3302:20E3` AD1;
  `3302:12C3` KT-12C3L USB D1; `31B2:3016` S-Link (KT3016L); `31B2:0113` AD1 Pro; `31B2:0117`
  Allegro Nano; `31B2:011B` Coda; `0BDA:0023` Allegro BAL (all KT0211L unless marked);
  `31B2:3001` S-Link Type-C 0.78 Mic; `31B2:3030` Stardust; `31B2:1132` Chorus; `31B2:3006`
  KT-1132L USB DAC (all KT1132L). The product list shown to users names the Belle but gives it no
  id; `0x3006` is the only id left for it. `3302:2017` and `12C3` aren't in that list.
- **EQ**: 5 bands. The type selector is disabled and always peaking; the Q write's type byte is
  always 0, and a read ignores it. Freq 20–20000 whole Hz, gain ±12 and Q 0.1–10, 0.1 steps in the
  editor. Neighbouring bands stay strictly ascending; on connect, a device that reads out of order
  (or above 20 kHz) is sorted and rewritten.
- **EQ switch**: 1 on, 0 off, as a 4-byte value; the app reads on as exactly 1.
- **Applying a preset**: switch on, each band's two writes (each waiting for its answer) then 50 ms,
  save, close, 3 s, reopen, read back. Editing one band writes it after a 100 ms debounce, no save;
  **Save to Flash** is its own button, and it closes and reopens too.
- **Global gain** on KT0211L only, never saved on its own. Index 0–15 (Mute, then −18…+3 dB in 1.5)
  on most, read `& 0x0F`; on `3302:2017` and `12C3` linear, −12…+12 dB, value `round(−dB × 10)`.
- **Never sends**: register 0x66, slots.
- **Not Kiwi's yet**: the app also names a "CB-5000X" and a "CB-3000S" under two ids that disagree
  (`31B2:5000` against `CB01:5000`), so it can't connect to them, and no product is listed.
  Ignored.

## Disagreements with the bridge and data

1. **Register 0x24 isn't a slot.** devicePEQ read it with `[3,0,0,0]` and took the answer's first
   byte as a slot: 3 on Kiwi's captures, the same as the write flag and the request's own byte. On
   the Chorus and S-Link it answers `"2025"` and `"2026"` in ASCII. The old handler wrote 3 to the
   app's on/off register, and read a year as a slot on the two others.
2. **Filter types.** devicePEQ's base has PK, LSC, HSC; the app only peaks. The Mini's capture
   shows a type byte of 3 read back, so firmware stores it; whether it filters as a shelf is
   unknown. Following the app takes shelves away from Kiwi users. Owner's decision, 2026-11-09:
   follow it.
3. **Allegro Pro.** devicePEQ's capture says `compensate2X` (half frequency); the app shares its id
   with the Mini and sends Hz. Followed the app, with a warning in the notes.
4. **Identity.** `3302:20E3` and `12C3` are also in Walkplay's SchemeNo17 and 11 groups, which
   yield to the device profiles (D43, 2026-11-11).

## Allegro Mini, recorded (2026-11-09)

The owner's Mini, in Edge on Windows, driven through the app by the agent:
`test/recordings/2026-11-09-kiwi-ears-allegro-mini.json`. The recorder's wrapper was injected into
the page, as the installed userscript wasn't active there.

- **Agrees with the handler and data**: every write and the save, byte for byte; flag 3 on all of
  them; band reads; negative gain as s16 (`ff ff` is −0.1); the 16 gain steps, 13 at 0 dB. Report
  ids 1, 75 and 84 in, 75 and 84 out; only 75 is used. Answers take about 1 ms.
- **Save**: answered, USB drops about 40 ms later, back 850 ms after that as a new `HIDDevice`, so
  closing after the save is right. Register 0x24, band and gain all persist.
- **0x24 held 3 as found.** A zeroed read answers `03 00 00 00`, so the 3 is the device's and not
  an echo. The app shows that as off, and can only write 1 or 0, each read back as written. So the
  app's on and the state as found differ, and nothing but a raw write gets 3 back. Following the
  app (owner's decision): the EQ reads as off at 3, and a push writes 1.
- **3 by ear (owner, 2026-11-09)**: writing 3 to 0x24 sounds like neither 0 nor 1, so it is a third
  state and not another "on". What it does isn't known. The bridge doesn't write it on Kiwi devices
  (tested). devicePEQ's and the older handler's "custom slot" is exactly that write, so a device
  that has been driven by them may hold 3; whether this Mini's came from there is unknown.
- **Elsewhere in the scan**: 0x20–0x23 look like two more bands (8 kHz, 10 kHz, Q 0.707, gain 0)
  the app doesn't use; 0x48–0x4D the product name, 0x5B the USB ids, 0x66 `00 02 00 00`.
- **Recorder bug**: a send was logged when it resolved, so a fast answer could land before its
  request and pair with the wrong one. Fixed in version 3; eight events in the fixture are put back
  in order, as its notes say.
- Left as found: band flat, step 13, 0x24 = 3, saved and read back.

The owner then ran every feature from a uniPEQ debug build on Android, with this bridge and data:
identify, read, write and save, reconnect, EQ switch, global gain, replug. All worked by ear, so
the profile is `maintainer-verified`.

## Global gain stays a control (owner, 2026-11-09)

It sounds like a pre-gain, but it is most likely a DAC gain after the EQ, which wouldn't give the
EQ headroom; that is unmeasured. As a pre-gain, uniPEQ's Auto would also move the user's level on
each push, and Mute doesn't fit a dB range.

## Next

1. **Global gain, before or after the EQ**: +12 dB at 1 kHz, a full-scale 1 kHz tone at low volume,
   global gain down 12 dB. Still distorted means after the EQ.
2. **Other KT Micro brands on the slot path**: JCally KT02H20, Moondrop Chu 2 DSP and CDSP still
   write 3 to 0x24 when the EQ is turned on. Whether that means the same on them is unchecked, and
   their own vendor apps are the reference.
3. **Devices nobody here has**: confirm USB product names, the S-Link pair's register maps, the
   Allegro Pro's frequency unit, and that `0x3006` is the Belle.
