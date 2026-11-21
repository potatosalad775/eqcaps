# Qudelix's Chrome app, against qudelix-usb-hid

Started 2026-11-19, after [moondrop.md](moondrop.md). No Qudelix device was at hand then:
everything up to "Checked on a 5K and a 5K Plus" is from the app. Both were checked on 2026-11-20
(below): their protocols are no longer `experimental`, the T71's is, and all three profiles stay
`draft`.

## How the app was read

The "Qudelix" app for Chrome, version 4.0.3.1 (Chrome extension
`phaodiidhofhdmfkjiacigibgikhfafn`), read 2026-11-19. Read for
facts only (D25). It is Qudelix's own
remote-control app for its DAC/amplifiers, and the only one read; the Android and iOS apps were
not. The app also knows two models that are not on sale; they are not covered here.

## What the app does

- **USB only**: the Chrome app talks WebHID and never Bluetooth.
- **Identity**: a device is accepted when its product id is in the list for its vendor id and its
  product name contains "Qudelix". It is kept only if it has a collection on usage page 0xFF00.

  | Model | Vendor | Product ids | Protocol |
  | --- | --- | --- | --- |
  | 5K | `0x0a12` | `0x4003`–`0x4007`, `0x4112`, `0x4113`, `0x4125`, `0x4126`, `0x4135`, `0x4136` | first |
  | 5K Plus | `0x0a12` | `0x5000`–`0x5004`, `0x5010`–`0x5014`, `0x5020`, `0x5021`, `0x5030`, `0x5031` | second |
  | T71 | `0x1fc9` | `0x7100`–`0x7102`, `0x7110`–`0x7112`, `0x7130`–`0x7132`, `0x7200`, `0x7201`, `0x7300`–`0x7302`, `0x7310`–`0x7312`, `0x7330`–`0x7332`, `0x7400`, `0x7401` | first |

  `0x0a12` is the Bluetooth chip vendor's id (CSR, now Qualcomm) and `0x1fc9` NXP's; both are
  shared with other makers. The vendor id picks the USB framing; the product ids only gate
  support. The app learns the model from a device id in the device's answer to its opening
  request (1 the 5K, 2 the 5K Plus, 0x100 the T71), and never uses the product id to tell the 5K
  from the 5K Plus. Nothing in the app says what the product ids within a model mean; the 5K's
  two recorded names ("Qudelix-5K USB DAC 48KHz" on `0x4005`, "Qudelix-5K USB DAC" on `0x4007`)
  suggest its USB audio setting, and the T71's low digit may be its USB mode (high resolution,
  PS5, Switch).
- **5K firmware**: 0.0.0 disconnects; below 2.0.0 the app refuses the device and forces an update;
  2.x gets older EQ commands; 3.0.0 and later the commands below. The 5K Plus and T71 have no
  firmware branch in the EQ, except the T71's graphic EQ from 1.5.6.
- **Transport, `0x0a12`**: output report 8 on the 0xFF00 collection, or 7 when the descriptor
  has no report 8 (a size of 0 refuses the send). Input reports 2 and 9 both carry the device's
  packets. Reports 3 (feature), 5 and 6 are only for firmware updates; 1 and 4 are unused. Out:
  `[n + 1, 0x80, packet…]` zero-padded to the report size, where the packet is
  `[cmd hi, cmd lo, data…]` and n its length. In: `[n, cmd hi, cmd lo, data…]`, no 0x80.
- **Transport, `0x1fc9`**: out on report 2, `[0x00, n u16 BE, packet…]` padded; in on report 1,
  `[x, n u16 BE, cmd u16 BE, data…]`. Reports 3 and 4 are firmware update, 5 a debug log. A packet
  longer than the report less 3 bytes fails.
- **No checksum, sequence number or HID-level splitting.** No delays: each send waits only for the
  previous one. The editor debounces 30 ms. No keep-alive.
- **Session**:
  1. Drop every input until 20 ms pass without one.
  2. Send the opening request `0x0100 [0x20, 0x00, 0x04]` (on `0x0a12`:
     `06 80 01 00 20 00 04 00…` on report 8) and wait up to 5 s. Everything but the two answers
     below is ignored until then.
  3. First protocol: `0x0101 [device id u16 BE, 3 = ok, firmware 4 bytes, model block]`. The 5K's
     block holds its status, its configuration (the EQ configuration among it), warranty and USB
     mute; the T71's holds warranty and status.
  4. Second protocol: `0x9000` with elements device id and protocol version
     `[major, minor, revision, packet size]`; accepted only for major 2 and a known model.
  5. On a timeout or failure: disconnect, retry every 250 ms, at most 240 times.
  6. Then the reads: the 5K asks for the configuration and status blocks it lacks, then the EQ
     presets (`0x0123 [3]` user and headphone, `[4]` all-band), then one name per stored memory,
     each asked when the last answer arrives. The T71 asks for production data (`0x3300`), its
     configuration and status, then `0x0123 [3]`; its sequence after that was not traced. The 5K
     Plus sets a session element (the host's OS), starts the warranty if blank, then asks for the
     presets of the active mode and their names.
  7. Unprompted: notifications `0x2000` (the device pushes every EQ change it makes), debug
     `0x2001`, warning `0x2002`, disconnect `0x0107`. Leaving: `0x0107` on the first protocol,
     action 1 on the second.
- **First protocol frames**: a 16-bit command and its bytes, all big-endian. Packet budget 56
  bytes on the 5K, 122 on the T71. No request ids; an answer is matched by its command.
- **Second protocol frames**: commands `0x9001` ack, `0x9002` request, `0x9003` answer, `0x9004`
  set, `0x9005` notification, `0x9006` action. A packet is `[cmd u16 BE, header, payload slice]`;
  the header is the fragment id (bits 0–4, wrapping at 32) plus 0x80 on the last. The payload is
  elements `[id, size in 4-byte words, data]`, their fields packed little-endian. Packet size
  40–120 from the device; at most 1022 bytes reassembled. After every fragment but the last the
  app waits for an ack `[fragment id, 0 = ok]`, 1 s, and reconnects on a failure. EQ elements:
  0x80 the EQ mode; per group (user 0x90, headphone 0xA0, all-band 0xB0, then +0 … +6) the group
  configuration (on/off, headroom, preset), preset configuration (stored, type and name masks),
  preset attributes, the whole preset, a preset name, one band, and the coefficients. Actions 0x30
  save and 0x31 delete a memory.
- **Types**: peaking, low shelf, high shelf, low-pass, high-pass, and a per-band bypass. Codes 5,
  3, 4, 1, 2 and 0 on 5K firmware 3.x, the T71 and the second protocol (5K firmware 2.x has other
  codes). Low-pass and high-pass take no gain in the editor.
- **Limits** (the editor's; typed values go to the full range, dragging stays on the plot's 20 Hz
  to 20 kHz):

  | Field | Range | Step | As sent |
  | --- | --- | --- | --- |
  | frequency | 10–22000 Hz | 1 | u16 |
  | gain | ±50 dB (graphic ±12) | 0.1 | s16 ×10 |
  | Q | 0.01–15 (5K Plus 0.01–63) | 0.001 | u16 ×1024, so 10/1024 at the bottom |
  | pre-gain | ±24 dB, per channel | 0.1 | s16 ×10 |
  | headroom | 0, −6 or −12 dB per EQ (the data allows ±12 in 0.1) | | s8 ×10 |
  | crossfeed | 0–50 | 1 | |

  No limit depends on the sample rate: 22 kHz is allowed at 44.1 kHz. The device's stored presets
  are narrower fields: gain 10 bits (±51.1 dB), Q 14 bits on 5K 3.x and the T71 (13 on 5K 2.x,
  just under 8), frequency 15 bits on the T71, Q 16 bits on the 5K Plus. Import takes PK, LS, HS,
  LSC, HSC, LP and HP, up to 30 filters and 10 channels.
- **Groups and modes**: each EQ has its own values, pre-gain, on/off switch, headroom and
  memories.

  | Model | User EQ | Headphone EQ | All-band EQ |
  | --- | --- | --- | --- |
  | 5K, firmware 3.x | 10 bands, 1 channel | 10 bands, left and right | 20 bands, 1 channel |
  | 5K, firmware 2.x | – | – | 20 bands on 1 channel, or 10 on left and right |
  | 5K Plus | 10 bands, 1 channel | 20 bands, left and right | 30 bands, 1 channel |
  | T71 | 10 bands, 1 or 5 channels | 10 bands, 2, 4 or 8 channels | – |

  - Layered mode ("USR+SPK" on the 5K, "USR 10 / SPK 20 layered" on the 5K Plus) runs the user EQ
    on top of the headphone EQ; single-EQ mode ("USR only", "USR 30-band") runs the all-band EQ
    alone. The T71 is always layered.
  - The headphone EQ is parametric only. It carries the headphone's impedance and sensitivity and
    is where AutoEQ curves go ("APPLY TO SPK EQ").
  - The T71's user EQ has 5 channels (front, center, LFE, back, side), likely in its surround USB
    mode; its headphone EQ has 4 (the QX-over's low and high) or 8 (a multi-driver earphone's
    DD, BA1, BA2, BA3) in its other processing modes, with a per-channel mute. The app edits one
    channel at a time; on a left and right pair it can edit both at once.
  - In the 5K's QX-over output mode the app warns that the device supports a 10-band EQ only.
- **Graphic EQ** (the user and all-band EQs; on the T71 from firmware 1.5.6): fixed centres, gain
  ±12 dB in 0.1, frequency not editable. 10 bands: 31, 63, 125, 250, 500, 1k, 2k, 4k, 8k, 16k.
  20 bands: 31, 44, 63, 88, 125, 180, 250, 355, 500, 710, 1k, 1.4k, 2k, 2.8k, 4k, 5.6k, 8k, 11.3k,
  16k and 22k on the first protocol, 20k on the second. 30 bands: ISO third-octaves 25 Hz to
  20 kHz. On the first protocol the Q is fixed at 1.414 and a slider sends only the gain
  (`0x0704`). On the second the app computes each band's Q in one of four modes (fixed Q, fixed
  bandwidth, proportional Q, classic Q) and sends the whole band. The type switch is `0x0701
  [group, 0 graphic / 1 parametric]`, or the preset attributes. The 5K Plus's all-band EQ is
  graphic by default.
- **Presets**: one numbering for every model and group.
  - 0–21 are curves the device holds, which the app can only select: Flat, Acoustic, Bass Booster,
    Bass Reducer, Classical, Dance, Deep, Electronic, Hip-Hop, Jazz, Latin, Loudness, Lounge,
    Piano, Pop, R&B, Rock, Small Speaker, Spoken Word, Treble Booster, Treble Reducer, Vocal.
  - 22–41 are the user's memories, 20 per group; on the T71 10 for the user EQ and 20, 5 or 5 for
    the headphone EQ on 2, 4 or 8 channels. The user names them (up to 32 UTF-8 bytes); an unnamed
    one shows as "Custom #n".
  - 42–52 are QX-over curves and 53–58 curves for the T71; where the app offers the T71's was not
    traced. 255 means "edited, no preset".
  - The user and all-band EQs offer all 22 built-ins; the headphone EQ offers Flat only, except in
    the 5K's QX-over mode.
  - On the second protocol a memory is listed only when it was stored with the EQ's current type.
  - A disabled EQ reports Flat. There is no delete or rename screen in this build; renaming is part
    of saving.
- **A write** (no apply, no commit; edits play at once):
  - A band edit (on release of a drag, a typed field, the bypass toggle, or a wheel on Q after
    160 ms) sends one band. First protocol: `0x070F [group, channel mask, band, type, freq u16,
    gain s16 ×10, Q u16 ×1024]`. Second: the group's band element, 8 bytes
    `[channel mask:4 | type:4, band, freq, gain ×10, Q ×1024]`, little-endian.
  - Groups are 0 user, 1 headphone, 2 all-band. The channel mask is `1 << channel`, so 1 for the
    user EQ; the headphone EQ with both channels selected is 3.
  - Band edits are dropped while the EQ is off, and any edit sets the group's preset to 255.
  - Pre-gain: `0x0703 [group, mask, 0, s16 ×10]`; the second protocol resends the whole preset.
  - On/off `0x0700 [group, 0/1]`, headroom `0x0702 [group, s8 ×10]`, mode `0x070E [0 layered /
    1 single-EQ]`; on the second protocol the group configuration, preset attributes and EQ mode
    elements.
  - Selecting a preset: `0x0709 [group, preset]`, or the group configuration's preset. Nothing is
    read back after it.
  - Saving: the headphone's impedance and sensitivity when the user overrides them (`0x0534`),
    then the name `0x070A [group, slot 0–19, n, UTF-8]` (n 0 for the default name), then
    `0x0708 [group, 22 + slot]`. Second protocol: the name element `[group, slot, n, 0, name]`,
    then action 0x30 `[group, slot, 0, 0]`.
  - Importing a file or an AutoEQ curve writes a whole group at once: its configuration (on,
    preset 255), then the preset block, in `0x0129` fragments of the packet size less 6 on the
    first protocol, or one preset element on the second.
  - The 5K's help says its EQ settings stay in flash across a restart. Whether the 5K Plus and T71
    keep an unsaved EQ is not said.
- **Coefficients** are the device's. The second protocol can read them back (only while audio
  plays); the app never asks. The app draws its curve and computes the graphic Q at 48 kHz.
- **Other settings**: crossfeed (0–50, user and all-band EQs; per preset on the 5K Plus).
  5K: output (auto, 2.5 mm, 3.5 mm, QX-over), gain (normal, high), DAC filter (eight, one "NOS
  (88.2/96kHz only)"), standard or performance, channel swap, amplifier, and the QX-over crossover
  (low 0 to −6, high 0 to +6, trims ±3, cutoff 20–20000 Hz, 6500 by default); Bluetooth volume
  −32 to 0 and USB −60 to 0 in 0.25. 5K Plus: DAC filter (seven), gain, swap, amplifier, THD
  compensation; no QX-over. T71: DAC filter (seven), USB mode (high resolution, surround, PS5,
  Switch), channel lock, bass boost 0–4, hybrid or digital.
- **Never sends**: coefficients; save-all (`0x1007`), except before a firmware update; factory or
  user reset; a memory delete (no screen calls it); feature reports outside a firmware update; a
  keep-alive.

## Disagreements with the bridge and data

As they stood before this work: `qudelix-usb-hid` was devicePEQ's 5K handler, and
`qudelix-5k.json` was seeded from AutoEQ.

1. **No opening request.** The handler sent bands straight away and called the device write-only.
   The app always sends `0x0100` first; the device answers on input report 2 or 9, and the app
   reads everything from there. devicePEQ saw no input most likely because it never asked.
2. **Channel mask 3 on the user EQ**, which has one channel. The app sends 1.
3. **Save and load as one byte** `[slot]`: the 5K firmware 2.x form. On 3.x the app sends
   `[group, 22 + slot]`.
4. **Saving without a name.** The app always writes the name first. Whether the firmware needs it
   is unknown.
5. **Unused bands kept** whatever they held; the app always has every band, bypassed or not.
6. **On and parametric with every push.** The handler sent `0x0700` and `0x0701` before the bands;
   the app sends them only when the user flips them.
7. **15 ms between frames**; the app sends back to back.
8. **Report fallback**: with neither report 8 nor 7 in the descriptor the handler used 8 at 64
   bytes; the app refuses.
9. **Q as signed 16-bit**; the app sends it unsigned. It only matters above 32 (the 5K Plus).
10. **Not covered**: the 5K Plus (second protocol), the T71 (NXP framing), 5K firmware 2.x, the
    headphone EQ, reads.
11. **Data**: 20–20000 Hz, ±12 dB, Q 103/1024–7, peaking and shelves only, pre-gain unknown, no
    presets, two product ids. AutoEQ's Q ceiling of 7 fits the 13-bit Q of 5K firmware 2.x.

## Done

- Bases `qudelix-app` (first protocol: `qudelix-usb-hid`, the app's limits, five types, manual
  pre-gain ±24 dB, presets 0–21 built in and 22–41 writable, `experimental`) and
  `qudelix-app-v2`, which extends it with `qudelix-v2-usb-hid` and Q up to 63.
- `qudelix-5k` (same id) now extends `qudelix-app` with all eleven product ids, any name, and keeps
  its two recorded names as more specific entries.
- New `qudelix-5k-plus` (fourteen ids, any name) and `qudelix-t71` (twenty-two ids under
  `0x1fc9`, its 10 user-EQ memories 22–31).
- The profiles describe the user EQ, with `bandCount` 10, and list the headphone EQ (format 1.3,
  below); their notes cover the modes, the firmware gates and what changed.
- `qudelix-usb-hid` follows the app for the 5K (firmware 3.0.0 and later) and the T71: the opening
  request, reads, the app's framing on both USB chips, no options besides `group`.
  - Every operation opens the session if it isn't open (quiet for 20 ms, the opening request, 5 s
    for the answer), then asks for the EQ block of the device configuration (`0x0120` with the
    EQ's mask bit alone: `0x80` on the 5K, `0x40` on the T71), which gives the mode and each
    EQ's switch and preset index. A pull then asks for the stored preset. Answers are waited for
    2 s. Nothing is read back after a push.
  - A 5K below firmware 3.0.0 is refused as `unsupported`, with a message that says to update;
    `firmware()` still returns its version.
  - A push is the switch on, the parametric type (not on the headphone EQ, which has no other),
    the pre-gain, then one band frame per band and channel, with no delay between frames. So an
    EQ left in graphic mode is switched to parametric by a push.
  - Bands past the filters it is given keep what the device holds (D33); an app completes the
    list to `bandCount()` first, as uniPEQ does.
  - A push to a slot ends with an empty name and the save, so the memory shows the app's default
    name; a name the user gave that memory is lost. Slots are the profile's preset ids, and only a
    custom one can be saved to.
  - The T71's user EQ on 5 channels is written on every channel alike and read from the first;
    its channel count is read from the stored preset before a push.
- New `qudelix-v2-usb-hid` for the 5K Plus: elements, fragments and acks, reads and writes.
  - The mode, each EQ's configuration and the firmware are taken from the opening answer and from
    what the device sends later, and asked for only when missing. Whether the opening answer
    carries them was inferred from the app, which never asks.
  - A push asks for the stored preset, sets the EQ's configuration (switch on), its attributes
    (parametric), then for a pre-gain the whole preset with only the pre-gain and type changed, as
    the app does, then one band element per band.
  - A save is the name element with an empty name, then action 0x30 with the memory's number from
    0.
  - A missing or bad ack fails the operation and closes the session; the next operation opens it
    again.
- Neither handler sends the app's session-info element, its warranty messages, its disconnect
  message or its preset-name requests.
- Both handlers drive the user EQ, or the all-band EQ in single-EQ mode, and report that count
  (20 on the 5K, 30 on the 5K Plus). An operation on the EQ `spk` drives the headphone EQ instead:
  parametric, both channels alike, absent in single-EQ mode, refused on the T71's 4 and 8 channels. On the 5K the headphone EQ
  stays a left/right pair in the QX-over output mode too, so it is written there as well.
- Tests run against a fake device built from this reading: they show the handlers agree with the
  reading. The devices' own answers are tested apart (Checked on a 5K and a 5K Plus).
- Needs a bridge release before this data reaches `main`: an older bridge has no
  `qudelix-v2-usb-hid` and drops the 5K Plus's protocol.

## Deliberate differences from the app

- **Ids with any name.** The app also wants "Qudelix" in the product name; a match can't say
  "contains", and only two names are known.
- **10 bands in the data** while the device is in single-EQ mode has 20 or 30: the handler reports
  the device's count, and 10 fit either mode.
- **The headphone EQ writes left and right alike**. The app can set each channel. The format has
  independent channels since 1.4 (D54), but a listed EQ has the profile's `channels`, and the user
  EQ the profile describes has one channel: the headphone EQ needs a `channels` of its own in
  `protocol.eqs` first, which D54 left for later.
- **5K firmware 2.x is not driven**; the app drives it with older commands.
- **No graphic EQ, crossfeed, headroom or device controls** yet (see Next).
- **Custom memory names** in the data are the app's label for an unnamed memory; the device holds
  the user's names.

## Decision: two EQs on one device (2026-11-19), made 2026-11-20

The EQ is chosen per operation, and the profile lists the device's EQs, each with its own band
count and presets: format 1.3, D53, SPEC §9.2. Made once both devices confirmed that the EQs are
independent.

- **Format**: `protocol.eqs` lists the EQs besides the one the profile describes, each `{ id,
  name, bandCount?, presets? }`. Issue code `eq-duplicate`; a listed EQ's slots must be complete
  (`slot-incomplete`); `version-too-low` below 1.3. Six conformance cases.
- **Core**: `profileEqs(profile)` and `eqProfile(profile, id)`, the profile of one EQ for the
  engine.
- **Bridge**: `eq` on `pull` and `push`, and on `currentSlot`, `eqEnabled`, `setEnabled` and
  `bandCount`; `capabilities.eqs`; a handler names its EQs in `eqs` and reads `ctx.eq`. The
  `group` option is gone from the data's options (no profile set it); the codecs keep it as what
  the handler passes them.
- **Data**: `qudelix-app` has `engine` "USR EQ" and lists `spk` "SPK EQ" (Flat and memories 22 to
  41); `qudelix-app-v2` lists it with 20 bands. The T71 inherits the base's.
- **Inspector**: the read (T2) chooses the EQ and checks it against that EQ's profile.
- **Not modelled**: single-EQ mode. The handler drives the all-band EQ as the profile's own and
  reports its band count; `spk` is `unsupported` there.

Rejected:

- **One profile per EQ**: two profiles on one USB identity tie at matching (SPEC §3 lets them
  share it only with different `engine` labels), so every connect would ask which EQ.
- **A switch held by the bridge**: session state posing as a device control, and the profile's
  band count would be wrong for the 5K Plus's headphone EQ (20 bands, not 10).

## Checked on a 5K and a 5K Plus (2026-11-20)

The maintainer's 5K (firmware 3.2.9) and 5K Plus (firmware 1.0.3), both as the handlers read
them, on macOS 27.2: `qudelix-usb-hid` and `qudelix-v2-usb-hid` as they stand, over a Node HID
library (the OS's HID layer, not Chrome's WebHID), every report logged. Nothing was plugged into
the outputs. The vendor app was not compared.

**Both devices**

- **The opening request is answered** within 10 ms, on input report 9; every later answer and
  notification came there too. devicePEQ's "write-only" is wrong: it never asked.
- **Pull and push work on both EQs.** A push to the user EQ (pre-gain −3.5; PK 1000 Hz −3 dB
  Q 1.5, LSC 105 Hz −2 dB Q 0.75, HSC 9000 Hz −1.5 dB Q 0.5, HPQ 25 Hz and LPQ 19000 Hz Q
  724/1024) read back exactly, the bands past it as they were, the switch on. So the channel
  mask 1, all five type codes, the gain's sign and scale, Q in 1/1024ths and the stored layouts
  hold. Frames go back to back, with no delay.
- **The headphone EQ**: a push with mask 3 took on left and right alike and left the user EQ
  alone; its preset became 255.
- **A save**: the empty name, then the save to memory 22, leaves the EQ on preset 22. Selecting
  Flat (0) then 22 again brought the curve back. Memory 22 of each device's user EQ now holds
  the test curve.
- **Limits**: both ends of the editor's ranges are stored as written (10 and 22000 Hz, ±50 dB,
  Q 0.01 as 10/1024 and 15, or 63 on the 5K Plus, pre-gain ±24; Q 1.111111 lands on 1138/1024).
  The firmware does not clamp to the editor: it keeps what its fields hold (±51.1 dB; Q
  16383/1024 on the 5K, 65535/1024 on the 5K Plus, which also kept 65535 Hz). What the DSP does
  past the editor's limits was not measured, so the profiles keep the app's ranges.
- **Left as found**, read back byte for byte, but for memory 22.

**5K** (`0x0a12`/`0x4007`, "Qudelix-5K USB DAC", manufacturer "QTIL", behind a hub of its own,
`0x0a12`/`0x4010`)

- **Descriptor**, the 0xFF00 collection (usage 1): output reports 1, 5 and 7 of 65 bytes and 8
  of 63; input reports 9 of 63, 2 of 65 and 6 of 13; feature reports 3 and 4 of 3. The codec
  assumed 64 bytes without a device (`OFFLINE_LINK`), now 63. A second HID interface is consumer
  control.
- **Opening answer** `38 01 01 00 01 03 83 90 …`: device id 1, status 3, firmware `83 90` =
  3.2.9.
- **The EQ configuration** `01 21 80 | 00 | 00 ff 00 00 | 00 00 00 00 | 01 | 00 1a 00 00 |
  0f 00 00 00` as found: layered, the user EQ off on preset 255, the headphone EQ off on preset
  26. The preset configurations (`00…`, `0f…`) did not change with the save; their meaning is
  open.
- **Stored presets** come as `0x0128` fragments of at most 50 bytes, about 10 ms apart: 88 bytes
  for the user EQ, 128 for the headphone EQ.
- **Notifications** `0x2000`, about 6 ms after a write, first byte a kind: `82` the switch (only
  when it changes), `8d` the type, `81 [group, 0, 0, 0, preset]`, `84` the pre-gain, `89
  [group, mask, band, 0, type, freq, gain, Q]` a band, `04` a status that comes unasked.
- **A band write while the EQ is off is stored** and notified. The app drops such edits; that is
  the app's choice.

**5K Plus** (`0x0a12`/`0x5004`, "Qudelix-5K+ USB DAC", manufacturer "Qualcomm", also behind a
`0x0a12`/`0x4010` hub)

- **Descriptor**: one HID interface with several top-level collections. On 0xFF00: usage 1 with
  output reports 1 (62 bytes) and 5 (254), input 2 (16) and 6 (12), feature 3 and 4 (62); usage 3
  with output report 8 and input report 9, 127 bytes each; usage 3 again with feature report
  0x20 (255). The second handler's codec now assumes 127 bytes without a device.
- **Opening answer**: `0x9000` in four fragments 3 ms apart, 119 bytes of message each, not
  waiting for acks from the host. Protocol `02 00 00 78`: version 2.0.0, packet size 120.
  Firmware element `01 00 03 02`. It carries the EQ mode (0x80) and both groups' configuration
  (0x90, 0xA0) and preset configuration (0x91, 0xA1), as the handler assumed, among device
  status, settings and Bluetooth pairings (names included: the captures zero those).
- **A request** for a stored preset is answered in 3 to 6 ms: 78 bytes in one packet for the
  user EQ, 256 in three for the headphone EQ.
- **Acks**: a headphone-EQ push with a pre-gain sends the 256-byte preset in three fragments; the
  device acked each but the last in about 6 ms, `90 01 80 [fragment, 0]`. No message of the user
  EQ needs a second fragment at packet size 120.
- **Selecting a preset** is setting the group's configuration; the device answers with a
  notification holding the configuration and the whole preset. A save is answered with the
  preset configuration (a bit per stored memory) and the configuration.
- As found: the user EQ off on preset 41, the headphone EQ on, on Flat.

**Kept as captures** in `packages/device-bridge/test/captures/`, each device as found
(`qudelix_qudelix_5k.json`, `qudelix_qudelix_5k_plus.json`) and after the pushes
(`…_pushed.json`: the writes, their notifications and acks, the reads after). The opening
answers have their status, settings and pairing data zeroed. `captures.test.ts` pulls from all
four and re-encodes the recorded band frames; `qudelix.test.ts` reads the firmware, switches,
presets and both EQs from them, and replays the 5K's pushes frame for frame. That found one bug:
the first handler's codec decoded another EQ's frames as its own.

**Single-EQ mode** (both devices, switched with the app's own command: `0x070E [1]` on the 5K,
the EQ mode element 0x80 set to mode 1 on the 5K Plus, and back)

- The device answers the switch with notifications: the 5K with its new configuration and the
  all-band preset, the 5K Plus with the mode, the all-band configuration and its preset.
- The handlers read the all-band EQ as the profile's own: 20 bands on the 5K (parametric, Flat),
  30 on the 5K Plus (graphic by default, as the app has it, Q 4.318). The EQ `spk` is refused as
  `unsupported` on both.
- A push of every band (20 and 30) read back exactly. On the 5K Plus it made the EQ parametric,
  as a push does; setting the attributes element back made it graphic again.
- Back in layered mode the user EQ and the headphone EQ read byte for byte as before.
- **The 5K can go deaf after 20 band frames back to back.** In 1 run of 3 (and once before),
  a request sent right after them got no answer, nor did later ones in that session; only 12 of
  the 20 echoes came. Every band had still been written, and a new session answered at once.
  With a 300 ms pause the request was answered. The app never sends a whole EQ as single band
  frames (it writes the preset block, `0x0129`), so this is the handler's own burst. The handler
  now waits for the device's echo of each band (the `89` notification, within 250 ms) before
  the next; a device that doesn't echo the first gets the rest at once. Paced, 12 of 12 runs
  answered, 20 bands taking about 65 ms. The 5K Plus showed no such thing with 30 band elements.

**Over Chromium's WebHID** (Helium 157 on macOS, the local inspector's origin, the device
granted earlier by the owner): the bridge's own `grantedHidDevice`, `openDevice` and the client's
`matchDevice`, run in the page against the built 1.3 data. The 5K matched `qudelix-5k` at
specificity 4, reported firmware 3.2.9, and both EQs read with no violations. The vendor app had
the device open in another tab at the same time: both hold it at once, each sees the answers to
the other's requests, and the handler read past them. The chooser itself and the 5K Plus were
not driven this way (the chooser needs the owner's click).

**In the data**: both profiles cite the check as a `community` source with `by` and `firmware`,
say in their notes what was and was not checked, and clear the base's `experimental`; the 5K
Plus has its product name as a specific match entry. Status stays `draft`: no counting source has
`by`, and the app's screen was not compared.

**Checked by the owner** (2026-11-20): the vendor app shows the same firmware versions (3.2.9,
1.0.3) and, for memory 22 of each user EQ, the curve the bridge saved there, value for value;
the inspector's own connect flow works on the devices.

**An unsaved EQ survives a restart** on both: a push to the user EQ without a slot, then the
cable pulled and the device powered off and on by the owner. Both came back with the pushed bands
and pre-gain, the switch on and no preset selected (255), the headphone EQ as it was.

Not checked: a bypassed band, other OSes, 5K firmware 2.x, the T71.

## Checking on a device

For someone holding a 5K or a 5K Plus with only this repository. Nothing here writes outside the
app's own limits. Keep the volume low and the headphones off for any step that sets an extreme.

**Tools, as they are:**

- **The vendor app**: the "Qudelix" app for Chrome (Chrome extension
  `phaodiidhofhdmfkjiacigibgikhfafn`), the version read here 4.0.3.1. Note the version you have.
- **The inspector, run locally** from this branch: `npm install`, `npm run data:build`,
  `npm run inspector:dev`. The public site has neither these profiles nor the new handlers. It
  shows the identity, the matched profile and the HID descriptor (INSPECTOR §2 T1), reads the EQ
  (T2) and runs guided reads (T3, §3). It never writes (D40).
- **uniPEQ with packed tarballs** for pushes: `npm run release -- <version> --pack` (any semver,
  say `0.0.0-qudelix.1`) writes `dist/pack/*.tgz`; `npm install <eqcaps>/dist/pack/*.tgz` in
  `../uniPEQ` (read-vendor-app step 5). uniPEQ passes a slot to save to and takes the band
  count from `bandCount()`; that it runs on that PC is for the day.
- **The browser console**, for raw traffic on our own pages (the inspector, uniPEQ): before
  connecting, run
  `for (const d of await navigator.hid.getDevices()) d.addEventListener('inputreport', (e) =>
  console.log(e.reportId, [...new Uint8Array(e.data.buffer)].map((b) => b.toString(16))))`
  (a device granted earlier), or add the listener after the chooser. Save the console log.
- **The WebHID recorder does not fit.** Its `@match` lines are https origins of vendor web apps,
  and Chrome does not run a userscript manager's scripts in another extension's pages, so it
  cannot record Qudelix's app. Nothing the app sends can be recorded from this repository; what
  the app shows on screen is the comparison. (`recordings.test.ts` needs a recording; the
  console logs above are raw material for a capture in `packages/device-bridge/test/captures/`.)
- **Sharing the device**: the inspector and the vendor app run in the same Chrome. Whether both
  can hold the device at once is unknown; Walkplay's web app could (INSPECTOR §3.4). If not, close
  the app's window before each read and reopen it after.

**Steps**, most informative first. For each, write down what is asked, the device's firmware (from
the vendor app), the OS and Chrome version. Results go into this plan (Next, Disagreements), the
profiles, and the bridge's captures.

1. **Identity and descriptor.** Connect in the inspector with no vendor app open. Look at the
   vendor id, product id and product name (exactly, trailing spaces included) and the HID
   descriptor: which collection has usage page 0xFF00, the output reports there (8, 7) and their
   sizes, the input reports (2, 9) and the feature report 3. Write down a row per product id. On
   the 5K, change the app's USB settings that may change the product id (full-speed mode, 16-bit
   mode, microphone), replug, and write down each new id and name. Expected: one of the ids in the
   profile; a name containing "Qudelix".
2. **Does the opening request get an answer?** Connect again with the console listener on. Look
   for an input report on 2 or 9 whose first byte is a length and the next two `01 01` on the 5K
   (`90 00` on the 5K Plus). Write down which report answered, the device id (1 the 5K, 2 the
   5K Plus), the firmware it reports against the app's, and on the 5K Plus the packet size (the
   protocol version element's last byte, 40–120). No answer within 5 s is the most important
   result here: then reads cannot work and devicePEQ's "write-only" stands. The inspector
   shows neither the firmware nor the device id the handler read; the console log does (the
   firmware is in the four bytes after the answer's device id and status).
3. **Pull the user EQ, compared with the app.** In the app, set a curve that is easy to tell apart
   (say peaking 1000 Hz +3 dB Q 1.41, low shelf 100 Hz −2 dB Q 0.7, high-pass 30 Hz, the rest
   bypassed) and a pre-gain of −3 dB. Read in the inspector. Write down every band, bypassed ones
   too, the pre-gain, the current preset and the on/off state, next to what the app shows; any
   difference is a finding.
4. **Pull the headphone EQ.** Choose "SPK EQ" in the inspector's EQ selector. Set a different
   curve on left and right in the app's SPK tab, read, and write down what comes back for each
   channel.
5. **Limits, by guided read** (INSPECTOR §3) on the user EQ: the app's lowest and highest
   frequency (10, 22000), gain (−50, +50), Q (0.01, 15; 63 on the 5K Plus), each type, the
   pre-gain (−24, +24), and the grid check (type Q 1.111111). Expected reads: Q 0.01 as
   0.009765625 (10/1024), Q steps of 1/1024. The evidence file goes to
   `data/evidence/<profile id>/`.
6. **Push to the user EQ** from uniPEQ, without saving: a curve unlike the one on the device
   (peaking 1000 Hz +6 dB Q 1, high-pass 200 Hz). Then look at the app (does it show the new
   bands without reconnecting?), listen (the boost and the bass cut are plain), pull in the
   inspector, then replug without saving and pull again. Write down all four. Push 3 filters
   onto a device holding 10 and write down what the other 7 bands hold afterwards.
   Expected: they keep what they held; the handler writes only the bands it is given.
7. **Push to the headphone EQ** (the EQ `spk`): write down whether left and right
   both took it in the app, whether the user EQ stayed as it was, what is heard, and what a replug
   keeps.
8. **Save to a custom memory**: push with slot 22. In the app, look at the memory's name and
   contents, pick another preset and come back, replug and look again. Then save the same way
   once with a name and once without. The handler always writes an empty name before the save
   and cannot pass one: name the memory in the app first, save to it from uniPEQ, and write down
   whether the name is gone, and the name the app shows each time.
9. **Single-EQ mode**: switch the app to "USR only" (5K) or "USR 30-band" (5K Plus). Pull: expect
   20 or 30 bands. On the 5K Plus, note whether the all-band EQ is graphic, and switch it to
   parametric in the app before pushing. Push a full set (uniPEQ takes the count from the device's
   `bandCount()`), then switch back to layered mode and pull the user EQ: write down
   whether it kept its values. A push to the EQ `spk` should be refused in this mode.
10. **5K Plus acknowledgements**: during a push long enough to need several fragments (a pre-gain
    change resends the whole preset in the app), the console should show acks (`90 01` after the
    length byte, then the fragment id and a result of 0) after every fragment but the last. Write
    down any non-zero result or missing ack.
11. **The rest of what is unknown**: with a band at 22000 Hz set in the app (not pushed) and
    44.1 kHz playback, listen at low volume; whether the QX-over output mode (5K) warns at more
    than 10 bands; whether an unsaved EQ survives a restart on the 5K Plus.

**What makes a profile `maintainer-verified`** (SPEC §10): the maintainer checked it on their own
hardware, and the profile cites at least one counting source with `by`. Here: steps 2, 3, 5, 6 and
8 agree with the profile and the app on the maintainer's device; the guided read's evidence file
(step 5) is cited as a `vendor-app` source with `by` and `firmware`; the profile's limits, types
and presets match it. Then set the status, and drop `experimental` from that profile's
`protocol` once pull and push work. A 5K check verifies `qudelix-5k` only; the T71 stays `draft`.

## Next

1. **The rest of the device check** (Checking on a device). The 5K and 5K Plus open, read and
   write both EQs and save (Checked on a 5K and a 5K Plus). Still open, all needing the owner at
   the device: other OSes.
2. **Status**: `maintainer-verified` needs a counting source with `by` (SPEC §10): the guided
   read against the app (step 5), or `by` on the app reading.
3. **Identity**: the USB product names of the T71 and of the other ids of the 5K and 5K Plus; what
   the product ids within a model mean; whether other makers' devices use these ids under `0x0a12`
   or `0x1fc9`, since the data matches any name.
4. **What the DSP does at the limits**, which both firmwares store: 22 kHz at 44.1 kHz, ±50 dB,
   Q 63 on the 5K Plus. A measurement, not a read-back.
5. **Persistence**: whether the T71 keeps an unsaved EQ across a restart; the 5K and 5K Plus do.
6. **The T71**: its sequence after the opening answer, and its user EQ on 5 channels.
7. **A whole EQ as the app writes it**: the preset block in `0x0129` fragments (first protocol),
   instead of one band frame per band paced by echoes. Its layout is read from the app but no
   device has taken it from the bridge.
8. **Releases**: the bridge (the second handler, the EQ of an operation) and core (format 1.3)
   before uniPEQ can offer the headphone EQ. An older bridge ignores `eqs` and drives the user EQ.
9. **Graphic EQ and device controls** (headroom, crossfeed, DAC filter, gain, output, USB mode and
   the rest), after a device confirms the basics. Their facts are under "What the app does".
10. **5K firmware 2.x**, if an owner still runs it: its own layout, codes and save form.
11. **Recording**: no way yet to record the app itself (Checking on a device). Both devices
    have captures of the bridge's own sessions.
