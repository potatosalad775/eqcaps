# Walkplay's own app, against walkplay-hid

Started 2026-10-28. Branch `feat/device-controls`, after [nicehck.md](nicehck.md).

## Goal

`walkplay-hid` was ported from devicePEQ, and NICEHCK's app disagreed with it in places. Walkplay's
own web app (peq.szwalkplay.com, "TTGK", the platform NICEHCK's `ttgk_v1` names) is the reference
for the chip. Its bundle is obfuscated; its strings were decoded statically for facts only (D25:
facts may become data; nothing is copied). Facts are cited as a `vendor-app` source. The app's
backend answers are encrypted and were left alone.

## What the app does

- **One class per chip family**, chosen from the product's `SchemeNo`, which the app asks its
  backend for by vid/pid: S17 and S22 → KT02H20, S19 and S23 → KT0231H, S21 → CB1300D, S24 →
  CB1100AU (another protocol), S26 → KT1213, S27 → CX31993, S28 and S2801 → MT2000; **every other
  scheme (S10, S11, S15, S16, S18, …) → `CB`**, the 0x4B protocol `walkplay-hid` speaks. The KT, CX
  and MT classes are other chips (some 10-byte frames, some with a CRC), not covered here.
- **Writing the EQ** (`CB`): the band frames, then `[1,0x0A,4,0,0,FF,FF]` ("refresh to memory",
  which applies it); saving adds `[1,0x01,0]` ("refresh to flash") a second later. A band frame
  carries the pre-gain in byte 34 and the preset tag in byte 35; the pre-gain command is
  `[1,3,2,0,dB]`. Coefficients: RBJ, Q2.30, `[b0,b1,b2,−a1,−a2]` at 96 kHz, as the handler's.
- **`[1,0x05,n]` and `[1,0x17,0]` appear only in the factory reset** (`[1,5,1]`…`[1,5,4]` after
  writing default bands). There is **no EQ on/off command** in the app.
- **Reads**: firmware `[0x80,0x0C]` (ASCII from byte 3); tag `[0x80,9,0]` (byte 35); pre-gain
  `[0x80,3,2,0,0]` (byte 4); mic gain `[0x80,2,0]` (byte 4, s8); DAC filter `[0x80,0x11]`, work
  mode `[0x80,0x1D]`, gain mode `[0x80,0x19]` (byte 3); balance `[0x80,0x16,2,ch,0]` (dB in byte 5,
  the high byte of the ×256 value); noise reduction `[0x80,0x1B,0]` (byte 3).
- **Control writes**: DAC filter `[1,0x11,1,v]` (1 FAST-LL … 5 NON-OS), work mode `[1,0x1D,1,v]`,
  gain mode `[1,0x19,1,v]` (0–2), balance `[1,0x16,4,ch,0,−dB,0]` (one channel cut, the other 0),
  mic gain `[1,0x02,2,0x80,dB]`, noise reduction `[1,0x1B,1,v]` followed by a save to flash.
- Filter types LS 1, PK 2, HS 3, LP 4, HP 5. The app hides high shelf on schemes 11, 13 and 20
  (and 21 on CB1300D).
- CB1300D (S21) adds an ADC (mic) EQ on cmd 0xDA in the band layout, 3D sound, reverb and modes
  (input reports 0x22–0x26, 0xD3), and scales its mic gain as 32767/15 per dB.

## Disagreements with walkplay-hid

1. **The commit.** The handler ends a push with `[1,5,0]`, `[1,0x17,0]`, `[1,0x0A,…,0]`,
   `[1,1,1,0]`: devicePEQ's, which looks taken from the reset sequence. In the app, `0x05` and
   `0x17` belong to the factory reset; a push may be resetting something. The app's save is
   `[1,0x0A,4,0,0,FF,FF]` then `[1,1,0]`. NICEHCK's app agrees (its `[1,0x01]`, "save to flash").
2. **`setEnabled`** sends `[1,1,on,slot,0]`, the save command with extra bytes. The app has no EQ
   switch, so the handler's `canEnable` is most likely wrong: off may save rather than bypass.
3. **Pre-gain in band frames.** The app writes the pre-gain into byte 34 of every band; the handler
   writes 0 there, so a push without `preamp` may reset the pre-gain to 0. Unconfirmed.
4. **Mic gain.** Settled 2026-10-31 (below): s16 ×256 dB, as NICEHCK's app writes it; Walkplay's
   app adds 0.5 dB to its slider value.
5. **Balance read length** is 2 in Walkplay's app and 4 in NICEHCK's. The handler sends 4, and
   matches the answer on the channel byte only.
6. **Noise reduction** (0x1B) isn't a handler control yet.

## Status (2026-10-28)

No Walkplay-scheme device is at hand, so nothing above is confirmed on the wire and the handler is
unchanged. What is settled and what waits:

- **Settled from the app's code:** the scheme → chip class table; the apply and save frames; that
  `0x05` and `0x17` belong to the factory reset; that the app has no EQ switch; the read and write
  frames of each control; the coefficient math (it matches the handler's).
- **Waits for a recording:** whether the handler's commit really resets anything (1), what
  `setEnabled` does on a device (2), whether byte 34 sets the pre-gain (3), the mic gain encoding
  per scheme (4).
- **Can be checked sooner on the owner's NICEHCK devices**, which speak the same 0x4B protocol
  (`ttgk_v1`, Walkplay's TTGK platform): 1–3. Push from the handler (uniPEQ), then listen, replug
  and read back. NICEHCK's app writes the same apply and save frames, so its recordings
  (nicehck.md, Next 1) show them on the wire. What they can't show is scheme-specific: the class a
  `SchemeNo` picks, noise reduction, the high-shelf exclusions.

How the strings were decoded, to redo it on a newer bundle: the app is built with
javascript-obfuscator (per module, a base64 string table with a custom alphabet, an index offset,
and a startup loop that rotates the table until a `parseInt` checksum matches; property names go
through small wrapper functions with constant arithmetic). A script parsed the bundle with `acorn`,
rebuilt each table's rotation by evaluating the checksum, and replaced every constant call with its
string, without executing the bundle. The script isn't kept in the repository; the bundle read was
`assets/index-DKGnhDWR.js` on 2026-10-28.

## Done

- **Mic gain, on a CrinEar Protocol Micro** (scheme 11, CB class, firmware 0.2;
  `test/recordings/2026-10-31-crinear-protocol-micro*.json`, then every whole and half dB from −15
  to +15 written and read back). The field is s16 ×256 dB, as the handler had it; the device
  rounds it to the nearest 1.5 dB from −15 to +15 and answers that. Walkplay's app sends its
  whole-dB slider value + 0.5 (`[1,2,2,0x80,dB]`) and nothing after it; NICEHCK's follows with
  `[1,0x04]`, now the `micGainDone` option, set by the `nicehck-walkplay` base. The Micro's profile
  has the control with a 1.5 dB step. The PureAural rounds the same way (1.5 dB from −12 to +12,
  though NICEHCK's app offers whole dB), and ignores a request sent within about 50 ms of
  `[1,0x04]`, and for up to about 250 ms after a work mode switch (0x1D); it varies. The handler
  doesn't wait for it: every read is sent again each 150 ms until answered (`hidRequest`'s
  `resendMs`), and a control's read-back is read once more before a mismatch counts as rejected
  (`writeControl`). Not seen yet: whether an
  unsaved change survives a replug.

- Recorder: adapter `walkplay-peq` (snapshot only: Pinia stores `device`, `product` with the
  SchemeNo, `eq`, `filter`, `micphone`, `mf`). `recordings.test.ts` checks its writes with the
  NICEHCK write checks; its snapshots aren't checked yet.

## Next

1. **Record** a Walkplay-scheme device in this app: connect, change a band and save, change each
   control, snapshot. That shows the commit and the controls on the wire, and the SchemeNo.
2. **Fix the commit** once recorded: send the app's apply-and-save instead of devicePEQ's tail.
   Retest the Octave capture's device by ear; `captures.test.ts` pins the old bytes, so it changes
   with it.
3. **`setEnabled`**: drop it (`canEnable: false`) unless a recording shows a real switch.
4. **Pre-gain in byte 34**: write the pre-gain there when given, and decide what a push without one
   sends (read it first, or refuse).
5. **Controls**: add `noiseReduction` (toggle, 0x1B). The Save frame `[1,1,0]` is the one
   `setEnabled(false)` sends (2): an app that changes a control may need to save it.
6. **Data**: the high-shelf exclusion for schemes 11, 13 and 20 against the Walkplay bases.
7. A snapshot checker for `walkplay-peq`, once a recording shows the store layout with a device.
