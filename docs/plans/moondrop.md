# Moondrop's web app, against moondrop-usb-hid and moondrop-old-fashioned-hid

Started 2026-11-11, after [kiwi-ears.md](kiwi-ears.md). No Moondrop device was at hand: everything
here is from the app, and the profiles stay `draft`.

`moondrop-usb-hid` and `moondrop-old-fashioned-hid` follow the app by default, with an option for
each way the families differ and the app's controls; the deliberate differences are listed below.
Profiles match `0x35d8` and the product id first; their product-name entries stay. Seven of the
pairs are also in Walkplay's SchemeNo11, 13, 15 and 16 groups, which yield to the device profiles
(D43, 2026-11-11). The ddHiFi DSP IEM and the Echo A, which aren't in the app, are driven the same
way: it is the same firmware family, and BLUE ROSE shows the app serves ddHiFi.

## The app

"Moondrop Custom EQ", `https://hub.moondroplab.com/`, version 1.8.0, build 26B1107, Beta, built
2026-11-10, read 2026-11-11 for facts only (D25). A newer build, seen 2026-11-26, lists the same
devices plus the CM1 calibration microphone (`0x35d8:0x0130`), which has no EQ in the app and so
no profile.

## What the app does

- **Identity**: vendor `0x35d8` and one product id per device, nothing else. It never looks at a
  product name. It takes the interface that has output and input report 0x4B.
- **Transport**: output report 0x4B, each frame zero-padded to the descriptor's output size. One
  request at a time; the next input report on 0x4B is the answer, whatever it holds; 2 s timeout.
  Writes aren't answered. A whole EQ write is retried up to twice, 500 ms apart.
- **Frames** (all but the Old Fashioned): `[op, cmd, len, payload…]`, op 0x01 write and 0x80 read.
  Commands: 0x01 save EQ, 0x03 global gain (the DAC offset), 0x04 save offsets, 0x09 band, 0x0A
  apply, 0x0C firmware, 0x0F active EQ slot, 0x23 pre-gain, 0x31 dongle link, 0x60 commit
  (Echo-BP). Gain, Q, pre-gain and global gain are s16 LE ×256; frequency u16 LE in Hz. A band is
  read with `[0x80,9,2,0,i]`.
- **Type codes**: 0 disabled, 1 low shelf, 2 peaking, 3 high shelf, 4 low-pass, 5 high-pass. The
  editor offers the last five; five devices leave the shelves out.
- **Limits** (the editor's, the same for every device unless said): 20–20000 whole Hz, gain −18 to
  +12 dB in 0.1, Q 0.1–10 in 0.01, pre-gain −128 to 0 dB in 0.1, global gain −18 to 0 in whole dB.
  The band count is a constant per device, never asked of it.
- **Four families**:

  | Family | Devices | Band frame | After the bands | Save |
  | --- | --- | --- | --- | --- |
  | main | Rays, AG Rays, Marigold, POSITION, E.S. combo, FreeDSP Pro, FreeDSP Mini, DAWN PRO2, MOONRIVER 3, DHA15, Deco Audio System, INN Deco75-DH Audio, BLUE ROSE | 36 bytes, length byte 0x21: 96 kHz Q2.30 coefficients, parameters, custom slot in the last byte | one apply `[1,0x0A,4,0,0,FF,FF]` | 0x01 |
  | MM3A | MM3A | 14 bytes: parameters only | nothing | 0x01 |
  | headsets | Gaming Maestro, GM01 Pro (10 bands); Echo-BP (32 bands) | 14 bytes; Echo-BP 34 bytes with the coefficient area left zero | nothing; Echo-BP commit 0x60 | 0x01 then 0x04 |
  | Old Fashioned | Old Fashioned (5 bands) | two 10-byte register writes, the KT Micro way | nothing | `S` |

- **A write** ("Write Cfg"; editing a band sends nothing): pad or cut to the band count, select
  the custom slot (0x0F, 150 ms) where the device has slots, the bands 25 ms apart, the apply or
  commit and 50 ms, the pre-gain and 50 ms, the global gain and 50 ms, save and 200 ms. Then it
  reads everything back. The offsets save (0x04) is never sent by the main family or the MM3A. On
  the Old Fashioned the app waits 200 ms after each register and 2 s for an answer; the handler's
  bytes agree with it.
- **Custom slot**: 7 on the main family, but 4 on the E.S. combo; 63 on the MM3A; 99 on the two
  headsets. The DHA15, BLUE ROSE, Echo-BP and Old Fashioned have no slot switch.
- **Built-in presets** are firmware slots the app can only select: Rays 0–4, AG Rays 0–3, E.S.
  combo 0–3, FreeDSP Pro and Mini 0–4, Marigold 0–2, POSITION 0, MM3A 0–3. Selecting one also
  writes pre-gain and global gain 0 (not on the MM3A) and saves. The app's "Official" and "Gaming"
  presets are curves it writes as a custom EQ.
- **Pre-gain** is computed by the app (0 when no band boosts) and written with every EQ; the user
  can't set it. Rays writes none below firmware 0.2, FreeDSP Pro none below 0.6. The DHA15's is
  written but never read back. The MM3A's is held at −128 dB while its bands are written.
- **Global gain**: a switch and a slider; off writes 0. Main family only.
- **Coefficients** (main family): RBJ at 96 kHz. Shelves take the band's Q as the shelf slope S;
  low-pass and high-pass have their own forms and ignore gain.
- **The two headsets** sit behind a USB dongle: before every operation the app asks 0x31 and stops
  when the headset isn't linked.
- **Other controls**, each one byte read with `[0x80, cmd, 0]` and written without a save:
  - BLUE ROSE: DAC filter 0x11 (1 sharp low-latency, 2 sharp phase-compensated, 3 slow
    low-latency, 4 slow phase-compensated, 5 non-oversampling), DAC mode 0x1D (0 class H, 1 class
    AB), LED 0x18. Its microphone gain (0x02, low or high) is written and saved with 0x04 but never
    read: the app remembers the choice itself. Factory reset is 0x17.
  - The two headsets: gain level 0x26 (0 high, 1 mid, 2 low; the panel is titled "Global Gain"),
    noise control 0x25 (0 off, 1 noise cancel, 2 transparency, and the effects 3 wind, 4 adaptive,
    5 live), LED 0x28, dual-microphone ENC 0x34, prompt tone 0x2B (three bytes: on, volume 0–100,
    selection), battery 0x27 (read only).
  - Which panels a device shows depends on the product and firmware and was not read; the lists
    above are the panels the app has for each device.
- **Never sends**: flash clear (0x05) or factory reset (0x17) from the EQ, per-band apply frames,
  an EQ on/off switch (there is none).
- **Not in the app**: ECHO-A, ECHO-B, FreeDSP (the Conexant pair), CDSP, Chu 2 DSP, Quark2, Edge,
  HiFi with PD, MD-QT-042. Those profiles keep their devicePEQ sources. The app also describes a
  "Thunder" (custom slot 3, a microphone gain) under the E.S. combo's product, with no USB id.

## Deliberate differences from the app

- **Global gain is a control**, written when the user changes it (then saved with 0x04). The app
  writes it with every EQ, 0 when its switch is off. Same reasoning as Kiwi's: it is a DAC offset
  after the EQ, and controls are opt-in (SPEC §9.1).
- **Pre-gain is `manual`**: the app computes it, here the caller does. The firmware gates on the
  Rays and FreeDSP Pro are notes, not corrections (D39).
- **Selecting a built-in preset** isn't driven; the presets are listed so an app knows which slot
  is the user's.
- **No retry or read-back** after a push; the session's caller decides.

## Coefficients that don't fit Q2.30

Q2.30 holds −2 up to just under 2. A boosted high shelf or a very broad peak high up goes past it:
+6 dB high shelf at 8 kHz, Q 0.7 has b1 = −2.303; +12 dB peak at 15 kHz, Q 0.1 has b0 = 3.014. Of
1 080 ordinary settings (three types, ten frequencies, six gains, six Q), 159 don't fit. The app
rounds and keeps the low 32 bits, with no clamp or check, and the handler sends the same bytes. It
isn't refused under D33, because that would refuse EQs the vendor's app sends, a plain treble shelf
among them.

If the firmware filtered by those coefficients, a treble boost would sound broken in Moondrop's own
app, so it more likely filters by the frequency, Q, gain and type in the same frame; the Echo-BP
and MM3A, which get no coefficients, point the same way. It is the question
[tanchjim.md](tanchjim.md) leaves open for Walkplay's frame. To settle it on a main-family device:
push a +6 dB high shelf at 8 kHz, Q 0.7, and listen or measure. A shelf means the parameters are
used and nothing changes. Anything else means the coefficients are, and then the limit goes in the
profiles (or the codec refuses what doesn't fit), for Walkplay's devices too.

## Next

1. **A device.** Nothing here is confirmed on hardware. First to settle: whether the last byte and
   the length byte matter (devicePEQ sent a constant 7 and 0x18), whether the save keeps pre-gain
   without 0x04, the USB product names of the new devices, that Echo-BP filters from parameters
   alone, and the shelf test above.
2. **A recorder adapter** for the app (`tools/userscripts/`), so an owner can record it.
3. **Controls**: whether any of them outlasts a replug (the app saves none), BLUE ROSE's
   microphone gain (no read, so not a control yet), the prompt tone selection, and the battery.
4. **Chu 2 DSP and CDSP** (KT Micro) aren't in this app; their reference is still open.
5. **The newer build** (2026-11-26): its limits and frames haven't been compared with 1.8.0 yet.
