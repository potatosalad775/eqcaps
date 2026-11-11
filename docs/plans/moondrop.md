# Moondrop's web app, against moondrop-usb-hid and moondrop-old-fashioned-hid

Started 2026-11-11, after [kiwi-ears.md](kiwi-ears.md). No Moondrop device was at hand: everything
here is from the app, and the profiles stay `draft`.

## How the app was read

`https://hub.moondroplab.com/` ("Moondrop Custom EQ", version 1.8.0, build 26B1107, Beta, built
2026-11-10), Vue. The main bundle `assets/index-iHwVcdAT.js` (994 520 bytes) holds the device
classes; the lazy chunk `assets/index-BupSpe5_.js` holds the EQ editor and the order of a write;
`assets/en-BUhSJ74Z.js` the English strings. Downloaded 2026-11-11 and read statically in a scratch
directory, pretty-printed with Prettier, never executed. Minified, not obfuscated. Facts only (D25).
The control panels are further lazy chunks, read the same way: `DacFilterType-D-41tuim.js`,
`DacMode-E9SgAdjr.js`, `dac-BTHrpc0M.js`, `LedControl-eBproyea.js`, `MicGainOffset-CVAKm01u.js`,
`GlobalGain-DdOXvw2r.js`, `NoiseControl-Cpj_DbDz.js`, `PromptTone-Bq1LelB5.js`,
`DualMicEnc-CgBTcUYB.js`. Which panels a device shows is a backend call that wasn't made.

The code to compare in a newer build: the product-id table (`productId: 283` and its neighbours),
the config defaults (`gainMin: -18`), the device classes by their `config` objects (`name: "Rays"`),
the command class with `sendCommand`/`queryCommand`, and `writeParameters` in the lazy chunk.

## What the app does

- **Identity**: WebHID filters of vendor `0x35d8` and one product id per device, nothing else. It
  never looks at a product name. It takes the interface that has output and input report 0x4B.
- **Transport**: `sendReport` on report 0x4B, each frame zero-padded to the descriptor's output
  size. One request at a time; the next input report on 0x4B is the answer, whatever it holds;
  2 s timeout. Writes aren't answered. A whole EQ write is retried up to twice, 500 ms apart.
- **Frames** (all but the Old Fashioned): `[op, cmd, len, payload…]`, op 0x01 write and 0x80 read.
  Commands: 0x01 save EQ, 0x03 global gain (the DAC offset), 0x04 save offsets, 0x09 band, 0x0A
  apply, 0x0C firmware, 0x0F active EQ slot, 0x23 pre-gain, 0x31 dongle link, 0x60 commit (Echo-BP).
  Gain, Q, pre-gain and global gain are s16 LE ×256; frequency u16 LE in Hz.
- **Type codes**: 0 disabled, 1 low shelf, 2 peaking, 3 high shelf, 4 low-pass, 5 high-pass. The
  editor offers the last five; five devices leave the shelves out.
- **Limits** (the editor's, the same for every device unless said): 20–20000 whole Hz, gain −18 to
  +12 dB in 0.1, Q 0.1–10 in 0.01, pre-gain −128 to 0 dB in 0.1, global gain −18 to 0 in whole dB.
  The band count is a constant per device, never asked of it.
- **Four families**:

  | Class | Devices | Band frame | After the bands | Save |
  | --- | --- | --- | --- | --- |
  | main | Rays, AG Rays, Marigold, POSITION, E.S. combo, FreeDSP Pro, FreeDSP Mini, DAWN PRO2, MOONRIVER 3, DHA15, Deco Audio System, INN Deco75-DH Audio, BLUE ROSE | 36 bytes: 96 kHz Q2.30 coefficients, parameters, custom slot in the last byte | one apply `[1,0x0A,4,0,0,FF,FF]` | 0x01 |
  | MM3A | MM3A | 14 bytes: parameters only | nothing | 0x01 |
  | headsets | Gaming Maestro, GM01 Pro (10 bands); Echo-BP (32 bands) | 14 bytes; Echo-BP 34 bytes with the coefficient area left zero | nothing; Echo-BP commit 0x60 | 0x01 then 0x04 |
  | Old Fashioned | Old Fashioned (5 bands) | two 10-byte register writes, the KT Micro way | nothing | `S` |

- **A write** ("Write Cfg"; editing a band sends nothing): pad or cut to the band count, select
  the custom slot (0x0F, 150 ms) where the device has slots, the bands 25 ms apart, the apply or
  commit and 50 ms, the pre-gain and 50 ms, the global gain and 50 ms, save and 200 ms. Then it
  reads everything back. The offsets save (0x04) is never sent by the main family or the MM3A.
- **Custom slot**: 7 on the main family, but 4 on the E.S. combo; 63 on the MM3A; 99 on the two
  headsets. The DHA15, BLUE ROSE, Echo-BP and Old Fashioned have no slot switch.
- **Built-in presets** are firmware slots the app can only select: Rays 0–4, AG Rays 0–3, E.S.
  combo 0–3, FreeDSP Pro and Mini 0–4, Marigold 0–2, POSITION 0, MM3A 0–3. Selecting one also
  writes pre-gain and global gain 0 (not on the MM3A) and saves. "Official" and "Gaming" presets
  are curves from the backend, written as a custom EQ.
- **Pre-gain** is computed by the app (a WASM module; 0 when no band boosts) and written with every
  EQ; the user can't set it. Rays writes none below firmware 0.2, FreeDSP Pro none below 0.6. The
  DHA15's is written but never read back. The MM3A's is held at −128 dB while its bands are written.
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
    selection, the selection list from the backend), battery 0x27 (read only).
  - Which panels a device shows comes from the backend, per product and firmware; the lists above
    are each device's `features` in the bundle.
- **Never sends**: flash clear (0x05) or factory reset (0x17) from the EQ, per-band apply frames, an
  EQ on/off switch (there is none).
- **Not in the app**: ECHO-A, ECHO-B, FreeDSP (the Conexant pair), CDSP, Chu 2 DSP, Quark2, Edge,
  HiFi with PD, MD-QT-042. Those profiles keep their devicePEQ sources. A "Thunder" class sharing
  the E.S. combo's product UUID, with custom slot 3 and a microphone gain, is in no device table.
  The CM1 (`0x0130`) is the calibration microphone and has no EQ.

## Disagreements with the bridge and data

1. **Pre-gain was read from the global gain.** The handler wrote pre-gain with 0x23 and read 0x03.
   The Marigold capture's own labels call 0x03 the global gain. → read 0x23; 0x03 is the
   `globalGain` control.
2. **One apply, not one per band.** devicePEQ sent `[1,0x0A,i,0,FF,FF,FF]` after each band.
3. **The custom slot was never selected**, so a device sitting on a built-in preset took the bands
   without playing them. → select it first; `customSlot`, `selectSlot`.
4. **Frame details**: length byte 0x21 (was 0x18), the slot in the last byte (was a constant 7),
   reads `[0x80,9,2,0,i]`, the app's delays, a 2 s timeout.
5. **Types.** No low-pass or high-pass, in the codes or the coefficients; the base offered shelves
   to the five devices whose app hides them, and Rays, AG Rays and Marigold were peaking only.
6. **Ranges.** ±12 dB (Marigold −12 to +6) against −18 to +12; pre-gain up to +128 against 0.
7. **Identity.** Profiles matched a product name under a list of Walkplay vendor ids. Two of that
   list's "vendor ids", `0x011b` and `0x011d`, are Moondrop's product ids for the Rays and the
   DAWN PRO2. → `35d8` and the product id first; the name entries stay. Seven of the pairs are also
   in Walkplay's SchemeNo11, 13, 15 and 16 groups, which yield.
8. **DAWN PRO2** was on the Walkplay handler and base. The app drives it like the FreeDSP Pro.
9. **Old Fashioned**: bytes agree. The app waits 200 ms after each register, not 100, and 2 s for
   an answer.
10. **Missing devices**: BLUE ROSE, E.S. combo, POSITION, MM3A, Gaming Maestro, GM01 Pro, Echo-BP.

## Done

- `moondrop-usb-hid`: follows the app by default. Options `bandFrame` (`biquad`, `compact`, `wide`),
  `commit` (`apply`, `commit`, `none`), `customSlot`, `selectSlot`, `duckPreamp`, `saveOffsets`,
  `linkCheck`, `ledCommand`; controls `globalGain`, `dacFilter`, `dacMode`, `led`, `gainLevel`,
  `ancMode`, `dualMicEnc`, `promptTone`, `promptToneVolume`; `firmware()`; low-pass and high-pass. The ddHiFi DSP IEM and
  the Echo A, which aren't in the app, are driven the new way too: it is the same firmware family,
  and BLUE ROSE shows the app serves ddHiFi.
- `moondrop-old-fashioned-hid`: the app's delays and timeout; a short answer is refused.
- Bases `moondrop-hub` and its relatives; the ten main-family profiles moved onto it with their
  product ids, types, presets and custom slots; the Old Fashioned aligned.
- New: BLUE ROSE (ddHiFi), E.S. combo, POSITION, MM3A, Gaming Maestro, GM01 Pro, Echo-BP.

- Both handlers pad every frame, reads too, to the output report size the descriptor declares
  (`outputReportSize`), 63 bytes on `moondrop-usb-hid` when it declares none. Never shorter than
  the frame.
- Moondrop's ids stay in the Walkplay groups: a group yields to a device profile on the same pair,
  and CI no longer calls that a collision (D43, 2026-11-11). The Kiwi Ears carve-outs are undone too.

Needs a bridge release before this data reaches `main`: a bridge that doesn't know an option drops
the protocol (AGENTS.md).

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
rounds and keeps the low 32 bits, with no clamp or check, and the handler sends the same bytes
(`coefficientBytes`). It isn't refused under D33, because that would refuse EQs the vendor's app
sends, a plain treble shelf among them.

If the firmware filtered by those coefficients, a treble boost would sound broken in Moondrop's own
app, so it more likely filters by the frequency, Q, gain and type in the same frame; the Echo-BP
and MM3A, which get no coefficients, point the same way. It is the question
[tanchjim.md](tanchjim.md) leaves open for Walkplay's frame. To settle it on a main-family device:
push a +6 dB high shelf at 8 kHz, Q 0.7, and listen or measure. A shelf means the parameters are
used and nothing changes. Anything else means the coefficients are, and then the limit goes in the
profiles (or the codec refuses what doesn't fit), for Walkplay's devices too.

## Next

1. **A device.** Nothing here is confirmed on hardware. First to settle: whether the last byte and
   the length byte matter, whether the save keeps pre-gain without 0x04, the USB product names of
   the new devices, that Echo-BP filters from parameters alone, and the shelf test above.
2. **A recorder adapter** for the app (`tools/userscripts/`), so an owner can record it.
3. **Controls**: whether any of them outlasts a replug (the app saves none), BLUE ROSE's
   microphone gain (no read, so not a control yet), the prompt tone selection, and the battery.
4. **Chu 2 DSP and CDSP** (KT Micro) aren't in this app; their reference is still open.
