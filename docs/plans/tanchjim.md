# Tanchjim's Android app, against ktmicro-usb-hid

Started 2026-10-28. Branch `feat/device-controls`, after [walkplay.md](walkplay.md).

## Goal

Tanchjim has no web app; its tools are an Android app (`com.tanchjim.android`) and a Windows app
(Qt5, native, talks through `hidapi.dll`). The Android app is plain Kotlin, unobfuscated, and was
decompiled with jadx 1.5.6 for facts only (D25: facts may become data; nothing is copied). Facts
are cited as a `vendor-app` source. The owner has a **FOLA** (IEM with a USB-C DSP cable) and a
**Luna** (DAC dongle) to confirm them on.

## What the app does

- **Three USB protocols, chosen by product name** (`UsbDevice.getProductName()`, e.g.
  `TANCHJIM-FOLA`, `TANCHJIM-LUNA`; the Rita and Rita AT names map to their DSP cables):
  - **"FeiFan"** (`DSPCommand`): DSP S, Zero DSP, One DSP, Tanya DSP, Zero Ultima, Fission DSP,
    EA Force, **FOLA**, Fission Rational, Origin AT, Bunny DSP. This is the 0x4B register protocol
    `ktmicro-usb-hid` speaks.
  - **"TTGK"** (`StarGate2Command`, `Space2Command`): Stargate II, DSP M, Space II, Space Pro,
    Space Pro AT, OLA II DSP, Rita DSP, Pinto DSP, Bunny Game, Rita AT DSP. Walkplay's platform
    (walkplay.md), 64-byte frames: `walkplay-hid`.
  - **Luna** (`LUNACommand`): Luna, Luna AT, Space. `C1 A5 …` 7-byte frames.
- **Transport** (all USB devices): the first interface with a bulk or interrupt endpoint is
  claimed; writes over 8 bytes go to its OUT endpoint, writes of 8 bytes or fewer are a vendor
  control transfer (`bmRequestType` 0x43, `wIndex` 0x09A0), reads likewise (0xC3). Each command is
  write then read, 5 s timeout, **400 ms between commands**.
- **Band count**: 5 for every FeiFan device and the Luna family's default; 8 for most TTGK, 10 for
  Space II/Pro.

### FeiFan (FOLA)

- Frames are 11 bytes on the wire, `4B reg 00 00 00 op 00 d0 d1 d2 d3`: the 0x4B the handler sends
  as the report id, then its 10-byte packet. `op` is `'R'` 0x52, `'W'` 0x57, `'S'` 0x53.
- **Bands**: registers 0x26/0x27 … 0x2E/0x2F. Even: gain s16 LE ×10, freq u16 LE. Odd: Q u16 LE
  ×1000, filter type, 0. Read Q registers first, then gain/freq (order seems irrelevant).
- **Filter types**: `0 PK · 1 LP · 2 HP · 3 LS · 4 HS`. No code for "off". The editor offers all
  five on every device.
- **Writing**: the ten band frames, 400 ms apart, then `4B 00 00 00 00 53 …` (save), **then the
  app closes the USB connection**. It sends the same save frame and closes when it goes to the
  background.
- **Editor ranges** (FeiFan gets the defaults): freq 30–20000 Hz, gain −12…+12 dB, Q 0.1–10
  (shown to one decimal). UI limits, not proven firmware limits.
- **Frequency halving**: for **Zero, One and Tanya** (`DSPProductType`), the app writes freq / 2
  and reads ×2. The FOLA and the rest are written in Hz.
- **Register 0x65** is mic gain (s8, ×2 → 0.5 dB steps); hidden on the FOLA (no mic).
- **FOLA "virtual channel"**: app-side 5-band presets written as an ordinary EQ, not device presets.

### Luna

**No EQ.** The app opens its EQ screen ("effect entrance") only for Space II; the Luna screen has
volume, channel balance, DAC digital filter, output level, DAC mode (Class H …), DRE, DEPOP, LED
and sample rate (read only). Reads are `C1 A5 A0`…`A4` (firmware, sample rate, volume, two config
blocks). Its frames are 7 bytes, so they go over the vendor control transfer, not an endpoint:
WebUSB, not WebHID.

## Disagreements with ktmicro-usb-hid and its base

1. **Filter types.** The handler has `PK 0, LSC 3, HSC 4`; the app adds `LP 1, HP 2` (→ `LPQ`,
   `HPQ`). The base `ktmicro-peq-5-band-12db-full-shelves-no-pregain` lists `PK LSC HSC`.
2. **Ranges.** The base says freq 20–20000, gain ±10, Q 0.1–5 (devicePEQ's shared shape, despite
   "12db" in its id); the app says 30–20000, ±12, 0.1–10.
3. **Slot register 0x24** (read, select custom slot 3, bypass 2, `setEnabled`): the app never
   touches it on FeiFan devices. Either devicePEQ knew something from another vendor's KT Micro
   app (Kiwi Ears, Moondrop), or writing 0x24 does something unintended on Tanchjim firmware.
4. **Preamp register 0x66**: the app never reads or writes it, and the base is "no-pregain" while
   the handler says `readsPreamp`/`writesPreamp`.
5. **Pacing**: the handler sends frames back to back and waits 1 s at the end; the app waits
   400 ms between frames and closes the connection after the save.
6. **Frequency halving** on Zero, One and Tanya. The handler's comment calls it "older firmware";
   the app shows it is per model, and that the vendor app does convert it, which D39's "vendor
   apps don't correct" didn't expect. Since the wire carries Hz/2 and the app means Hz, this is
   arguably a wire grid (handler option, D42) rather than a quirk: **owner's call**, needs a
   DECISIONS note either way. Affects the existing `tanchjim-one-dsp` profile.

## Decided (2026-10-28)

The vendor app comes first (D39, dated note): what Tanchjim's app does is what the bridge does on
Tanchjim devices, through `protocol` options so the other KT Micro brands keep the handler's
behaviour. Matching stays exact, with the chip vendor's id (0x31b2 for KT Micro) standing in for
USB ids not known yet; a name-only match would be a format change (1.3) and waits for a device
found under another vendor id.

## Done (FeiFan half)

- `ktmicro-usb-hid`: `LPQ` 1 and `HPQ` 2; options `freqUnit` (Hz per unit of the frequency field),
  `slotRegister` and `preampRegister` (false leaves 0x24 / 0x66 alone; no EQ switch then),
  `frameDelay` (ms between push frames). Defaults keep the old behaviour. Tests in
  `handlers.test.ts`.
- Bases `tanchjim-ktmicro` (the app's types and ranges, no preamp, options `slotRegister: false`,
  `preampRegister: false`, `frameDelay: 400`) and `tanchjim-ktmicro-half-frequency` (adds
  `freqUnit: 2` and a 2 Hz frequency step).
- One DSP (half frequency), Fission DSP and Bunny DSP moved onto them; their capture snapshots now
  read no pre-gain, the One DSP's frequencies doubled. devicePEQ's captures hold Q 8 and 6, which
  the old base (Q ≤ 5) flagged and the app's range (Q ≤ 10) allows.
- New profiles, `0x31b2` + the app's name: DSP S, Zero DSP and Tanya DSP (half frequency), Zero
  Ultima, EA Force, FOLA, Fission Rational HiFi Edition, Origin AT.
- Not followed: the app closes the USB connection after the save. The bridge keeps it open; if
  writes after a save don't take, that's the first thing to try.

## Next

1. **Identify the FOLA**: vid/pid, the exact product name and the HID report descriptor. Check that
   it matches `tanchjim-fola`, then pull (inspector, read only, D40) and push (uniPEQ).
2. **TTGK half**: read `StarGate2Command` and `Space2Command` against `walkplay-hid` the way
   walkplay.md read Walkplay's app, then a Tanchjim Walkplay base (the app offers all five types
   and ±10 dB, Q 0.1–5, 20–20000 Hz; the existing OLA II and Space Pro profiles are peaking only)
   and profiles for DSP M, Rita DSP, Pinto DSP, Bunny for Gaming, Rita AT DSP (8 bands), Space II
   and Space Pro AT (10 bands).
3. **Record the vendor app writing**: the Windows app over USBPcap/Wireshark (hidapi, so plain HID
   reports), or the Android app. Cover a write with each filter type, the save, and
   replug-and-read. Keep it under `packages/device-bridge/test/captures/`.
4. **Luna**: out of eqcaps' scope while it has no EQ (a profile is an EQ constraint profile). Its
   controls could become a WebUSB handler later if a no-EQ device profile is ever wanted; park it.
