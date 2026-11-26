# Qudelix's Chrome app, against qudelix-usb-hid

The maintainer has a 5K (firmware 3.2.9) and a 5K Plus (firmware 1.0.3), checked from 2026-11-20
on: both profiles are `maintainer-verified`, their protocols no longer `experimental`. The 5K and
the T71 use `qudelix-usb-hid`, the 5K Plus `qudelix-v2-usb-hid`. No T71 is at hand: its profile,
from the app alone, stays `draft` and `experimental`. Each EQ's headroom, the crossfeed, the DAC
filter and the gain are driven as controls since 2026-11-22, released in 0.6.0.

## The app

The "Qudelix" app for Chrome, version 4.0.3.1 (Chrome extension
`phaodiidhofhdmfkjiacigibgikhfafn`), read 2026-11-19, and again on 2026-11-21 (the headphone EQ's
channels) and 2026-11-22 (the settings besides the EQ). Read for facts only (D25). It is Qudelix's
own remote-control app for its DAC/amplifiers, and the only one read; the Android and iOS apps
were not. The app also knows two models that are not on sale; they are not covered here.

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
     configuration and status, then `0x0123 [3]`; its sequence after that was not read. The 5K
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
  | headroom | 0, −6 or −12 dB per EQ (the setting takes ±12 in 0.1) | | s8 ×10 |
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
  - The headphone EQ's tab has a Both, Left and Right selector (read 2026-11-21). It is the
    editor's alone: Both by default and again on every connect, never sent to the device and
    never read from it. With Both an edit goes out as one frame with channel mask 3; with Left or
    Right, as one frame with mask 1 or 2. The pre-gain is per channel and follows the same
    selector. The device keeps nothing like Topping's mask of configs shown with the channels
    apart.
  - The T71's user EQ has 5 channels (front, center, LFE, back, side), likely in its surround USB
    mode; its headphone EQ has 4 (the QX-over's low and high) or 8 (a multi-driver earphone's
    DD, BA1, BA2, BA3) in its other processing modes, with a per-channel mute. The app edits one
    channel at a time; on a left and right pair it can edit both at once.
  - In the 5K's QX-over output mode the app warns that the device supports a 10-band EQ only. The
    headphone EQ stays a left and right pair there.
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
    read. 255 means "edited, no preset".
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
- **How the settings driven here are sent and read** (read 2026-11-22):
  - Headroom: a selector of 0, −6 and −12 dB under each EQ, greyed while that EQ is off. First
    protocol `0x0702 [group, s8 ×10]`, held in the group's configuration; second, the group's
    configuration element set whole with the headroom changed.
  - Crossfeed ("QX-FEED"): a level of 0 to 50 on the user and all-band EQs (the headphone EQ only
    in the 5K's QX-over mode), ignored while that EQ is off. It is one of the stored preset's
    first fields, beside the type. First protocol `0x070D [group, channel mask, 0, level u16]`;
    second, the preset attributes element set whole.
  - DAC filter ("FILTER SELECTION") and gain ("OUTPUT POWER": NORMAL, HIGH). 5K: one command
    with one byte each, `0x0501 [filter]` and `0x0505 [0 or 1]`, read from the DAC block of the
    device configuration (`0x0120 [0x08]`, 4 bytes: the gain is bit 5, the filter bits 18 to 21).
    5K Plus: one element, `0x40`, 8 bytes, set whole (the filter is bits 14 to 17, the gain bit
    18); the app shows the gain the DAC runs at now from a status element (`0x41`) and sets the
    configured one.
- **Other settings**: 5K: output (auto, 2.5 mm, 3.5 mm, QX-over), gain (normal, high), DAC filter
  (eight, one "NOS (88.2/96kHz only)"), standard or performance, channel swap, amplifier, and the
  QX-over crossover (low 0 to −6, high 0 to +6, trims ±3, cutoff 20–20000 Hz, 6500 by default);
  Bluetooth volume −32 to 0 and USB −60 to 0 in 0.25. 5K Plus: DAC filter (seven), gain, swap,
  amplifier, THD compensation; no QX-over. T71: DAC filter (seven), USB mode (high resolution,
  surround, PS5, Switch), channel lock, bass boost 0–4, hybrid or digital, and a crossfeed with a
  front and a back level.
- **Never sends**: coefficients; save-all (`0x1007`), except before a firmware update; factory or
  user reset; a memory delete (no screen offers it); feature reports outside a firmware update; a
  keep-alive.

## Deliberate differences from the app

- **Ids with any name.** The app also wants "Qudelix" in the product name; a match can't say
  "contains", and only two names are known.
- **10 bands in the data** while the device in single-EQ mode has 20 or 30: the handler drives the
  all-band EQ as the profile's own and reports the device's count, and 10 fit either mode. The
  headphone EQ (`spk`) is `unsupported` there.
- **No channel selector.** The bridge keeps nothing like the app's Both, Left and Right: a push
  without `right` writes both channels alike (the app's Both), one with `right` writes each
  channel its own (Left, then Right, band by band), and a pull returns both.
- **The mode and each EQ's switch and preset asked for on every operation.** The first handler
  asks for the EQ block of the device configuration (`0x0120` with `0x80` on the 5K, `0x40` on
  the T71); the second asks for the mode (0x80), then that EQ's configuration. On the 5K Plus the
  app takes them from the opening answer and the notifications and never asks. A change another
  program makes can reach an open session unannounced (2026-11-21), so the bridge asks, and the
  device answers.
- **A push switches the EQ on and makes it parametric** (not the headphone EQ, which has no other
  type), then writes the pre-gain and the bands. The app sends the switch and the type only when
  the user flips them, so a push turns an EQ left in graphic mode parametric.
- **Bands past the filters a push is given keep what the device holds** (D33); the app always has
  every band, bypassed or not. An app completes the list to `bandCount()` first, as uniPEQ does.
- **One frame per band.** The app writes a whole EQ (an import) as the preset block; the bridge
  writes one band frame or element per band and channel. On the 5K each waits for the device's
  echo (the `89` notification, within 250 ms), since 20 frames back to back can leave it deaf
  (2026-11-20); a device that doesn't echo the first gets the rest at once.
- **A save writes an empty name**, so the memory shows the app's default name, and a name the
  user gave it is lost. Only a custom memory can be saved to.
- **Not sent**: the app's session-info element, its warranty messages, its disconnect message and
  its preset-name requests.
- **The T71's user EQ on 5 channels** is written alike on every channel and read from the first;
  the app edits one channel at a time. Its headphone EQ on 4 and 8 channels is refused.
- **5K firmware 2.x is not driven** (refused as `unsupported`, with a message to update); the app
  drives it with older commands.
- **No graphic EQ** yet, and of the settings only each EQ's headroom, the crossfeed, the DAC
  filter and the gain; the rest are not driven (see Next). On the T71 only the headrooms: its
  crossfeed (two levels) and its DAC block (another layout) are refused.
- **The 5K Plus's gain read from its configuration.** The app shows the gain the DAC runs at now;
  the bridge reads back the one it set.
- **Custom memory names** in the data are the app's label for an unnamed memory; the device holds
  the user's names.

## Decisions

- **Two EQs on one device** (format 1.3, D53, SPEC §9.2; made 2026-11-20, once both devices showed
  the EQs independent): the profile describes the user EQ ("USR EQ") and lists the headphone EQ
  (`spk`, "SPK EQ") with its own band count and presets. Single-EQ mode is not modelled.
- **The headphone EQ's left and right apart** (format 1.5, D55, SPEC §9.2; 2026-11-21): both
  bases list `spk` with `"channels": "independent"`.
- **Settings of one EQ** (format 1.6, D57, SPEC §9.1; 2026-11-22): a control may name the EQ it
  belongs to (`eq`), and the role `headroom` is added; the 5K and 5K Plus list each EQ's
  headroom, the crossfeed, the DAC filter and the gain.

## Checked on a 5K and a 5K Plus (2026-11-20)

The maintainer's 5K (firmware 3.2.9) and 5K Plus (firmware 1.0.3) on macOS 27.2, driven by both
handlers over a Node HID library (the OS's HID layer, not Chrome's WebHID), every report logged,
nothing plugged into the outputs.

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
  of 63; input reports 9 of 63, 2 of 65 and 6 of 13; feature reports 3 and 4 of 3. A second HID
  interface is consumer control.
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
  0x20 (255).
- **Opening answer**: `0x9000` in four fragments 3 ms apart, 119 bytes of message each, not
  waiting for acks from the host. Protocol `02 00 00 78`: version 2.0.0, packet size 120.
  Firmware element `01 00 03 02`. It carries the EQ mode (0x80) and both groups' configuration
  (0x90, 0xA0) and preset configuration (0x91, 0xA1), among device status, settings and
  Bluetooth pairings (names included); nothing of the all-band EQ (0xB0) in layered mode.
- **A request** for a stored preset is answered in 3 to 6 ms: 78 bytes in one packet for the
  user EQ, 256 in three for the headphone EQ.
- **Acks**: a headphone-EQ push with a pre-gain sends the 256-byte preset in three fragments; the
  device acked each but the last in about 6 ms, `90 01 80 [fragment, 0]`. No message of the user
  EQ needs a second fragment at packet size 120.
- **Selecting a preset** is setting the group's configuration; the device answers with a
  notification holding the configuration and the whole preset. A save is answered with the
  preset configuration (a bit per stored memory) and the configuration.
- As found: the user EQ off on preset 41, the headphone EQ on, on Flat.

**Captures**: each device's session as found and after the pushes (the writes, their
notifications and acks, the reads after) is kept in `packages/device-bridge/test/captures/`, the
opening answers' status, settings and pairing data zeroed.

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
- **The 5K can go deaf after 20 band frames back to back.** In 1 run of 3 (and once before), a
  request sent right after them got no answer, nor did later ones in that session; only 12 of the
  20 echoes came. Every band had still been written, and a new session answered at once. With a
  300 ms pause the request was answered. The app never sends a whole EQ as single band frames
  (it writes the preset block, `0x0129`), so this is the handler's own burst. Paced by each band's
  echo, 12 of 12 runs answered, 20 bands taking about 65 ms. The 5K Plus showed no such thing
  with 30 band elements.

**Over Chromium's WebHID** (Helium 157 on macOS, the local inspector's origin, the device granted
earlier by the owner): the bridge and the client run in the page against the built 1.3 data. The
5K matched `qudelix-5k` at specificity 4, reported firmware 3.2.9, and both EQs read with no
violations. The vendor app had the device open in another tab at the same time: both hold it at
once, each sees the answers to the other's requests, and the handler read past them. The chooser
itself and the 5K Plus were not driven this way (the chooser needs the owner's click).

**Checked by the owner**: the vendor app shows the same firmware versions (3.2.9, 1.0.3) and,
for memory 22 of each user EQ, the curve the bridge saved there, value for value; the
inspector's own connect flow works on the devices.

**An unsaved EQ survives a restart** on both: a push to the user EQ without a slot, then the
cable pulled and the device powered off and on by the owner. Both came back with the pushed bands
and pre-gain, the switch on and no preset selected (255), the headphone EQ as it was.

## Left and right of the headphone EQ (2026-11-21)

**The 5K** (the maintainer's, firmware 3.2.9): one band frame `0x070F [1, 2, band, …]` changed
the right channel only, one with mask 1 the left only, and the stored-preset read returned the two
channels apart. So the headphone EQ's channels are independent on the device, and the user EQ
above it has one.

**Released client 0.4.3** (with core and bridge 0.4.3, from npm) loaded the built 1.5 data, found
a unique match for the 5K, 5K Plus and T71 and read each profile. It gives `spk` the profile's
linked channels, so an app on it writes both alike.

**Through the bridge, on both** (the 5K as above, and the maintainer's 5K Plus, firmware 1.0.3;
the working EQ only, no save): a push to `spk` with `right`, a different curve and pre-gain on
each channel, read back as written on each channel, the EQ on preset 255 and the user EQ
untouched; `right` equal to the left and without a pre-gain read back equal, the pre-gain the
left's; a push without `right` after it wrote both channels alike; `right` on the user EQ was
refused before anything was sent. Each device was then put back on the preset and switch it was
found with, and read as before.

**A pull that read a push partway** (the 5K Plus): a pull straight after a push to `spk`, while
the EQ was on a stored preset, returned the EQ as it was after the push's first band write, in 3
runs of 3. When an edit takes the EQ off a stored preset, the device sends a notification (0x9005)
holding the whole preset as that edit left it, and it came after the pull's request went out and
before the answer (0x9003). The bridge's request had taken any message holding the elements it
asked for; now only the answer resolves it, and 3 runs of 3 read what was pushed.

**A memory another program left** (the 5K Plus): with uniPEQ's session open over WebHID, another
HID client pushed bands to the headphone EQ, which took it off memory 22 (preset index 255,
edited). The session got no notification of the configuration: its next read of the headphone
EQ's current preset still answered 22 where a new session answered none, and an app would have
saved into memory 22 an EQ the user never put there. The vendor's app open beside the bridge is
the everyday case. The second handler now requests the mode (0x80), then its EQ's configuration,
on every operation; the device answered both, and a session then reported the edited EQ. They
stay two requests: the EQ's element depends on the mode, and whether the device answers a request
for a group its mode lacks is unknown (its layered opening answer holds no 0xB0).

**Single-EQ mode with that fix** (the 5K Plus, switched with the app's own mode element and back):
the handler's requests for the mode and the all-band EQ's configuration were each answered in
about 10 ms; the band count read 30, the switch, the preset and a pull of 30 bands read, and
`spk` was refused as `unsupported`. Back in layered mode both EQs read as before.

**Against the app's screen** (the 5K Plus, the app 4.0.3.1 connected at the same time): the bridge
wrote a different curve and pre-gain per channel. The app's headphone-EQ tab showed the left
channel's bands and pre-gain with Left or Both selected and the right channel's with Right
selected, value for value, without reconnecting. The 5K's app was looked at later that day, with
the channels written apart from uniPEQ through the bridge: its headphone-EQ tab agreed on both
channels.

## Settings besides the EQ (2026-11-22)

**The 5K** (the maintainer's, firmware 3.2.9), sent each as the app sends it and asked for it
back; the gain was only lowered and put back:

- The DAC block read `21 11 02 85`: high gain, filter 0. A filter write and a gain write each
  read back at once.
- The headroom of the user EQ and of the headphone EQ took −6 and −12 dB and read back from the
  group's configuration; the preset index did not move.
- The user EQ's crossfeed took a level and read back from the stored preset; the preset index
  stayed on its memory (22), though the app treats the preset as edited.
- The device announces every one of these changes a few milliseconds later (`0x2000`: the block
  for a DAC setting, `[0x83, group, 0, 0, s16]` for the headroom, `[0x8C, group, mask, 0, u16]`
  for the crossfeed).
- Left as found, read back equal.

**The 5K Plus** (the maintainer's, firmware 1.0.3), through the bridge with the repository's
profile, the gain only lowered and put back:

- The DAC configuration (`0x40`) is answered when asked for, 8 bytes; it read `01 1c 04 00 …`:
  high gain, filter 0. The attributes element of a group is answered too.
- Each headroom took −6 and −12 dB, the crossfeed 10 and 50, the DAC filter 1 and 6, the gain
  normal; each read back at once, in 14 to 58 ms a write with its read-back.
- Neither the headroom nor the crossfeed moved an EQ's preset index (both stayed on memory 22).
- The DAC's status element (`0x41`) showed the filter and the gain as set, at once, so what the
  app's screen shows follows the configuration.
- The device announces every change (`0x9005`) with the element that changed: the group
  configuration, the attributes, or the DAC configuration and status together. A gain change
  also announces a volume element.
- Left as found: the controls, both EQs' bands and pre-gains, their switches and presets read
  back equal.

## Next

1. **The settings against the app's screen**: both devices read back what the bridge set; whether
   the app shows each (the headroom under each EQ's tab, the crossfeed, the DAC filter, the gain)
   without reconnecting was not looked at.
2. **The settings in uniPEQ**: built in its working tree on packed tarballs (each EQ's headroom
   and the crossfeed on the band card with that EQ, the DAC filter and the gain among the
   device's settings, SPEC §9.1) and tried on the 5K Plus on 2026-11-22: each setting changed
   from uniPEQ read back from a second client, and the headroom and crossfeed rows went still
   once another client switched the EQ off and uniPEQ read again. Not tried there on the 5K.
3. **What the settings do, still unknown**: whether a device takes a headroom or crossfeed write
   while the EQ is off (the bridge never sends one); whether the crossfeed is saved with a
   memory; what the headroom does to the level against the pre-gain; the filter the app marks for
   88.2 and 96 kHz at other rates; what the volume element announced with a gain change holds.
4. **The rest of the settings**: the 5K's output selection and QX-over crossover (the QX-over
   mode changes the headphone EQ's channels and presets, which a control cannot say), DAC
   profile, channel swap, amplifier power; the 5K Plus's distortion compensation and active
   ground; the volume; the T71's DAC filter, USB mode (the device comes back with another
   product id), bass boost and the two crossfeed levels. Their facts are under "What the app
   does".
5. **Graphic EQ**, and the EQ mode as something an app can change: both change what the EQ is
   (fixed centres; which EQs exist), so neither is a plain control.
6. **Identity**: the USB product names of the T71 and of the other ids of the 5K and 5K Plus; what
   the product ids within a model mean (on the 5K, the app's USB settings may change it:
   full-speed mode, 16-bit mode, microphone); whether other makers' devices use these ids under
   `0x0a12` or `0x1fc9`, since the data matches any name. One is known: a Bluetooth dongle of
   another maker's answers to the 5K's `0x0a12`/`0x4007` with another product name.
7. **What the DSP does at the limits**, which both firmwares store: 22 kHz at 44.1 kHz, ±50 dB,
   Q 63 on the 5K Plus. A measurement, not a read-back. With it, whether the 5K's QX-over output
   mode warns at more than 10 bands.
8. **The T71**, without a device so far: its sequence after the opening answer, its user EQ on 5
   channels, whether it keeps an unsaved EQ across a restart (the 5K and 5K Plus do). It stays
   `draft` and `experimental`.
9. **A whole EQ as the app writes it**: the preset block in `0x0129` fragments (first protocol),
    instead of one band frame per band paced by echoes. Its layout is read from the app but no
    device has taken it from the bridge.
10. **Not checked on a device yet**: a bypassed band; whether a name given to a memory in the app
    is gone after a save from the bridge; another OS (every check so far was on macOS).
11. **5K firmware 2.x**, if an owner still runs it: its own layout, codes and save form.
12. **Recording the app's own session**: not done. The WebHID recorder cannot run in the app's
    pages: Chrome does not run a userscript manager's scripts in another extension's pages. The
    checks here sent the app's frames from the bridge and compared the app's screen. Both devices
    have captures of the bridge's own sessions.
