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
- At first not followed: the app closes the USB connection after the save. The FOLA showed why
  (below); the base now has `disconnectOnSave`.

## FOLA on the owner's Mac (2026-10-29)

- USB `0x31b2:0x1123`, product name `TANCHJIM-FOLA`. One consumer-control collection: reports
  0x4B (75) and 0x54 (84), 10 bytes in and out, and input report 1, 1 byte. The app uses only
  0x4B; 0x54 is left alone. `productId` added to the profile's match.
- Inspector pull: bands read in Hz, so the FOLA is not a half-frequency model.
- uniPEQ push (dev, with tarballs from `release --pack` and the local build): the first write took, the next one hung. After the
  commit the FOLA re-enumerates (it drops out of the audio device list for a moment), which is
  what the app's close-after-save and Android's repeated permission dialog follow from.
  `disconnectOnSave: true` on `tanchjim-ktmicro`: with it, every write took, and the Android app
  read them back as written.
- Reconnecting in Chrome after the drop sometimes needs the device chooser again, sometimes not.
- Still to do before `maintainer-verified`: one band of each type by ear, and replug-and-read.

## TTGK half (2026-11-01)

Same app build (2.5.7.4), now read for `StarGate2Command` (EQ) and `Space2Command` (the Space
family's DAC screen) against `walkplay-hid`.

- **Band frame**: the handler's layout byte for byte (report 0x4B, `[1,9,0x18,0,idx,0,0]`, Q2.30
  coefficients at 96 kHz, freq u16, Q and gain ×256, type, 0, preset tag). Types are Walkplay's
  (LS 1, PK 2, HS 3, LP 4, HP 5). The band read sends `[0x80,9,0x1F,0,idx]`; the handler sends 0
  where the app sends 0x1F.
- **But the app computes peaking coefficients for every band**, whatever its type byte says. Either
  the firmware filters by the metadata (and the coefficients don't matter), or the app's shelves
  and passes are peaks. The handler sends each type's own coefficients. Only a recording settles it.
- **Write**: the bands, then `[1,0x0A,4,0,0,FF,FF]`, 400 ms, `[1,1,0]`: the same apply-and-save
  as Walkplay's and NICEHCK's apps, so the third vendor app against the handler's devicePEQ commit
  (walkplay.md, disagreement 1). Pre-gain only as `[1,3,2,0,dB]` + `[1,4]` (byte 34 stays 0),
  −8…+4 whole dB.
- **Editor**: all five types, 20–20000 Hz, ±10 dB, Q 0.10–5.00. 10 bands on Space II, Space Pro and
  Space Pro AT; 8 on Stargate II, DSP M, OLA II DSP, Rita DSP, Pinto DSP, Bunny for Gaming, Rita
  AT DSP.
- **Identity**: by USB product name, as for FeiFan; the USB names `TANCHJIM-RITA` and
  `TANCHJIM-RITA AT` map to the DSP cables. A device that comes up as 0x0666:0x0888 (a failed
  update) is identified by the USB id it keeps in flash (read `0x0D`), which gives Space II
  `0x3302:0x4381`, Space Pro `0x4367`, Stargate II `0x43d4` and `0xf3d4`, DSP M `0x129d`, and any
  other 0x3302 id as Space Pro AT. The two already in profiles match what devicePEQ recorded.
- **Space family controls** (`Space2Command`): the handler's own commands. DAC filter 0x11 (1–5),
  gain 0x19 (0 low 2 Vrms, 1 high 4 Vrms), DAC mode 0x1D (**0 class AB, 1 class H**, the reverse of
  the PureAural), volume 0x85 (0–100, followed by `[1,4]`), mic gain 0x02 (−15…+15 whole dB, s16
  ×256), balance 0x16 (one channel cut, up to 127 dB). Not in the handler: **DRE** 0x32, one byte,
  **0 on, 1 off**.

Done: bases `tanchjim-walkplay` (8 bands, the app's types and ranges, pre-gain −8…+4) and
`tanchjim-walkplay-space` (10 bands, the controls above, format 1.2). Stargate II, Space Pro and
OLA II DSP moved onto them (devicePEQ had them peaking only; Stargate II gains `0xf3d4`). New:
Space II, Space Pro AT, DSP M, Rita DSP, Rita AT DSP, Pinto DSP, Bunny for Gaming; ids from the
flash table where known, otherwise name under 0x3302. The handler is unchanged.

## Space II in uniPEQ, and following the app (2026-11-01)

A Space II owner tried the published profile in uniPEQ 1.3.0 (firmware 1.3):

- **Volume** failed with "reads back 60, not 63". The app's slider is 0–100 but it sends
  `ceil(slider × 0.6)`: the register is **0–60**, and the device clamps above it. The profile had
  the slider's range.
- **DAC filter, gain and DAC mode reset themselves** to 1/1/1 (the values at first connect): they
  survived replugs, then reverted. Most likely the handler's devicePEQ commit, `[1,5,0]` and
  `[1,0x17,0]`, two of Walkplay's factory reset commands, sent with every (auto-)write. Tanchjim's
  app never sends them.

So `walkplay-hid` now writes as the vendor apps do (D50: the vendor app is the reference):
bands, `[1,0x0A,4,0,0,FF,FF]`, `[1,1,0]`, then the pre-gain and `[1,4]`, NICEHCK's recorded
sequence. Tanchjim's order and pacing are options on `tanchjim-walkplay`: `preampWithBands`
(pre-gain right after the bands, nothing after it), `frameDelay: 400`, and `afterControl`
(`[1,4]` after volume; the apply and save after mic gain, from `saveDigitalAdc`). New control `dre`
(0x32, held as 0 on; the handler turns it round). Data: Space volume 0–60, `dre` on the Space base,
and `micGain` on a new `tanchjim-walkplay-mic` base for every TTGK device the app shows it for
(all but the DSP M). The one deliberate difference from the app: the handler sends each filter
type's own coefficients (Next 2).

Needs a bridge release and uniPEQ update before this data is published: a bridge that doesn't know
an option rejects the profile.

## Next

1. **FOLA**: the by-ear pass and replug-and-read above, then `maintainer-verified`.
2. **TTGK on the wire**: does the firmware filter by the coefficients or by the metadata? A shelf
   pushed from the handler can't tell: its coefficients and type agree, so it sounds right either
   way, unless the firmware rebuilds from the metadata and doesn't handle the type (devicePEQ's
   Stargate II exclusion of shelves hints at that). Instead, a one-off script (the codec can't
   build it) writes one band whose metadata says PK +6 dB at 100 Hz and whose coefficients are PK
   +6 dB at 3 kHz, and the output is measured (loopback into an interface, a sweep in REW; a read
   back only returns the metadata). A bump at 3 kHz: coefficients, the handler's shelves are right
   and the app's are peaks. At 100 Hz: metadata, so then push a real low shelf and measure whether
   it is one. Per model (Stargate II, Space), modest gains.
3. **Space II retest** after the release: the volume across 0–60, DRE, and that the DAC filter,
   gain and mode survive an EQ write and a replug.
4. **Record the vendor app writing**: the Windows app over USBPcap/Wireshark (hidapi, so plain HID
   reports), or the Android app. Cover a write with each filter type, the save, and
   replug-and-read. Keep it under `packages/device-bridge/test/captures/`.
5. **Luna**: out of eqcaps' scope while it has no EQ (a profile is an EQ constraint profile). Its
   controls could become a WebUSB handler later if a no-EQ device profile is ever wanted; park it.
