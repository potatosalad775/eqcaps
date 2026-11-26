# Tanchjim's Android app, against ktmicro-usb-hid

Started 2026-10-28, after [walkplay.md](walkplay.md). The owner has a **FOLA** (IEM with a USB-C
DSP cable) and a **Luna** (DAC dongle).

Tanchjim's KT Micro ("FeiFan") and Walkplay ("TTGK") devices follow the app, through `protocol`
options on `ktmicro-usb-hid` and `walkplay-hid`, with one deliberate difference (TTGK
coefficients, below). The FOLA was tried on the owner's Mac (2026-10-29) and is not
`maintainer-verified` yet. A Space II owner's trial (2026-11-01) changed how `walkplay-hid` writes;
its retest is open (Next). The Luna has no EQ.

## The app

Tanchjim has no web app. Its tools are an Android app (`com.tanchjim.android`) and a Windows app
(Qt5, native). The Android app, version 2.5.7.4, was read for facts only (D25): its FeiFan EQ
first, then on 2026-11-01 its TTGK EQ and the Space family's DAC screen.

## What the app does

- **Three USB protocols, chosen by the USB product name** (for example `TANCHJIM-FOLA`,
  `TANCHJIM-LUNA`; the names `TANCHJIM-RITA` and `TANCHJIM-RITA AT` map to the DSP cables):
  - **FeiFan**: DSP S, Zero DSP, One DSP, Tanya DSP, Zero Ultima, Fission DSP, EA Force,
    **FOLA**, Fission Rational, Origin AT, Bunny DSP. This is the 0x4B register protocol
    `ktmicro-usb-hid` speaks.
  - **TTGK**: Stargate II, DSP M, Space II, Space Pro, Space Pro AT, OLA II DSP, Rita DSP, Pinto
    DSP, Bunny Game, Rita AT DSP. Walkplay's platform ([walkplay.md](walkplay.md)), 64-byte
    frames: `walkplay-hid`.
  - **Luna**: Luna, Luna AT, Space. `C1 A5 …` 7-byte frames.
- **Transport** (all USB devices): the first interface with a bulk or interrupt endpoint is
  claimed; writes over 8 bytes go to its OUT endpoint, writes of 8 bytes or fewer are a vendor
  control transfer (`bmRequestType` 0x43, `wIndex` 0x09A0), reads likewise (0xC3). Each command is
  write then read, 5 s timeout, **400 ms between commands**.

### FeiFan (FOLA)

- Frames are 11 bytes on the wire, `4B reg 00 00 00 op 00 d0 d1 d2 d3`: the 0x4B the handler sends
  as the report id, then its 10-byte packet. `op` is `'R'` 0x52, `'W'` 0x57, `'S'` 0x53.
- **Bands**: 5 on every FeiFan device, registers 0x26/0x27 … 0x2E/0x2F. Even: gain s16 LE ×10,
  freq u16 LE. Odd: Q u16 LE ×1000, filter type, 0. Read Q registers first, then gain and freq
  (the order seems irrelevant).
- **Filter types**: `0 PK · 1 LP · 2 HP · 3 LS · 4 HS`. No code for "off". The editor offers all
  five on every device.
- **Writing**: the ten band frames, 400 ms apart, then `4B 00 00 00 00 53 …` (save), **then the
  app closes the USB connection**. It sends the same save frame and closes when it goes to the
  background.
- **Editor ranges** (FeiFan gets the defaults): freq 30–20000 Hz, gain −12…+12 dB, Q 0.1–10
  (shown to one decimal). UI limits, not proven firmware limits. devicePEQ's captures of the One
  DSP, Fission DSP and Bunny DSP hold Q 8 and 6, inside the app's range.
- **Frequency halving**: for **Zero, One and Tanya**, the app writes freq / 2 and reads ×2. The
  FOLA and the rest are written in Hz.
- **Never touched**: register 0x24 (the handler's slot select and EQ switch) and the preamp
  register 0x66. There is no pre-gain and no EQ switch.
- **Register 0x65** is mic gain (s8, ×2, so 0.5 dB steps); hidden on the FOLA (no mic).
- **FOLA "virtual channel"**: app-side 5-band presets written as an ordinary EQ, not device
  presets.

### TTGK (Walkplay)

- **Band frame**: the handler's layout byte for byte (report 0x4B, `[1,9,0x18,0,idx,0,0]`, Q2.30
  coefficients at 96 kHz, freq u16, Q and gain ×256, type, 0, preset tag). Types are Walkplay's
  (LS 1, PK 2, HS 3, LP 4, HP 5). The band read sends `[0x80,9,0x1F,0,idx]`; the handler sends 0
  where the app sends 0x1F.
- **The app computes peaking coefficients for every band**, whatever its type byte says. Either
  the firmware filters by the metadata (and the coefficients don't matter), or the app's shelves
  and passes are peaks. The handler sends each type's own coefficients, the one deliberate
  difference from the app. Only a recording settles it (Next 2).
- **Write**: the bands, the pre-gain `[1,3,2,0,dB]` right after them with no `[1,4]`, then
  `[1,0x0A,4,0,0,FF,FF]` and `[1,1,0]`, 400 ms between commands: the same apply and save as
  Walkplay's and NICEHCK's apps. The pre-gain goes only in its own command (byte 34 of each band
  stays 0), −8…+4 whole dB.
- **Editor**: all five types, 20–20000 Hz, ±10 dB, Q 0.10–5.00. 10 bands on Space II, Space Pro
  and Space Pro AT; 8 on Stargate II, DSP M, OLA II DSP, Rita DSP, Pinto DSP, Bunny for Gaming,
  Rita AT DSP. Mic gain is shown on every TTGK device but the DSP M.
- **Identity**: by USB product name, as for FeiFan. A device that comes up as 0x0666:0x0888 (a
  failed update) is identified by the USB id it keeps in flash (read `0x0D`), which gives Space II
  `0x3302:0x4381`, Space Pro `0x4367`, Stargate II `0x43d4` and `0xf3d4`, DSP M `0x129d`, and any
  other 0x3302 id as Space Pro AT. The two ids that were already in profiles match what devicePEQ
  recorded. The profiles take these ids where known, otherwise the name under 0x3302.
- **Space family controls**: the handler's own commands. DAC filter 0x11 (1–5), gain 0x19 (0 low
  2 Vrms, 1 high 4 Vrms), DAC mode 0x1D (**0 class AB, 1 class H**, the reverse of the PureAural),
  volume 0x85 (the slider is 0–100 but the app sends `ceil(slider × 0.6)`, so the register is
  0–60; followed by `[1,4]`), mic gain 0x02 (−15…+15 whole dB, s16 ×256; followed by the apply and
  save), balance 0x16 (one channel cut, up to 127 dB). **DRE** 0x32, one byte, **0 on, 1 off** (the
  handler turns it round).

### Luna

**No EQ.** The app opens its EQ screen only for Space II (its band count for the Luna family
defaults to 5); the Luna screen has volume, channel balance, DAC digital filter, output level, DAC
mode (Class H …), DRE, DEPOP, LED and sample rate (read only). Reads are `C1 A5 A0`…`A4`
(firmware, sample rate, volume, two config blocks). Its frames are 7 bytes, so they go over the
vendor control transfer, not an endpoint: WebUSB, not WebHID. It is out of eqcaps' scope while it
has no EQ (a profile is an EQ constraint profile); its controls could become a WebUSB handler if a
no-EQ device profile is ever wanted.

## Decided (2026-10-28)

The vendor app comes first (D39, dated note): what Tanchjim's app does is what the bridge does on
Tanchjim devices, through `protocol` options so the other KT Micro brands keep the handler's
behaviour. The frequency halving is per model and the app converts it, so it is the wire format,
not a firmware quirk. Matching stays exact, with the chip vendor's id (0x31b2 for KT Micro)
standing in for USB ids not known yet; a name-only match would be a format change and waits for a
device found under another vendor id.

## FOLA on the owner's Mac (2026-10-29)

- USB `0x31b2:0x1123`, product name `TANCHJIM-FOLA`. One consumer-control collection: reports
  0x4B (75) and 0x54 (84), 10 bytes in and out, and input report 1, 1 byte. The app uses only
  0x4B; 0x54 is left alone.
- Inspector pull: bands read in Hz, so the FOLA is not a half-frequency model.
- uniPEQ push (a dev build with this bridge): the first write took, the next one hung. After the
  save the FOLA re-enumerates (it drops out of the audio device list for a moment), which is what
  the app's close-after-save and Android's repeated permission dialog follow from. With the bridge
  closing the connection after the save, as the app does, every write took, and the Android app
  read them back as written.
- Reconnecting in Chrome after the drop sometimes needs the device chooser again, sometimes not.

## Space II in uniPEQ (2026-11-01)

A Space II owner tried the published profile in uniPEQ 1.3.0 (firmware 1.3):

- **Volume** failed with "reads back 60, not 63": the register is 0–60 and the device clamps above
  it. The profile had the app's slider range.
- **DAC filter, gain and DAC mode reset themselves** to 1/1/1 (the values at first connect): they
  survived replugs, then reverted. Most likely the handler's devicePEQ commit, `[1,5,0]` and
  `[1,0x17,0]`, two of Walkplay's factory reset commands, sent with every (auto-)write. Tanchjim's
  app never sends them.

So `walkplay-hid` now writes as the vendor apps do (D50): bands, `[1,0x0A,4,0,0,FF,FF]`,
`[1,1,0]`, then the pre-gain and `[1,4]`, NICEHCK's recorded sequence; on Tanchjim's devices in
Tanchjim's order and pacing, with the controls written as above. The Space profiles have volume
0–60.

## Next

1. **FOLA**: one band of each type by ear, and replug-and-read, then `maintainer-verified`.
2. **TTGK on the wire**: does the firmware filter by the coefficients or by the metadata? A shelf
   pushed from the handler can't tell (its coefficients and type agree), unless the firmware
   rebuilds from the metadata and doesn't handle the type, as devicePEQ's Stargate II exclusion of
   shelves hints. Instead, a one-off script (the codec can't build it) writes one band whose
   metadata says PK +6 dB at 100 Hz and whose coefficients say PK +6 dB at 3 kHz, and the output is
   measured (loopback into an interface, a sweep in REW; a read back only returns the metadata). A
   bump at 3 kHz means coefficients: the handler's shelves are right and the app's are peaks. At
   100 Hz it means metadata: then push a real low shelf and measure whether it is one. Per model
   (Stargate II, Space), modest gains.
3. **Space II retest**: the volume across 0–60, DRE, and that the DAC filter,
   gain and mode survive an EQ write and a replug.
4. **Record the vendor app writing**: the Windows app over USBPcap/Wireshark (plain HID
   reports), or the Android app. Cover a write with each filter type, the save, and
   replug-and-read. Keep it under `packages/device-bridge/test/captures/`.
