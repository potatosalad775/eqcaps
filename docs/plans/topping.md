# Topping's web app, against topping-usb-hid

Started 2026-11-20. After [tanchjim.md](tanchjim.md) and [fosi-audio.md](fosi-audio.md).

## Goal

Support Topping's DACs as their web app, Topping Home (https://home.toppingaudio.com/, "web
v1.17.0"), drives them: the DX1 II, DX5 II, E50 II, DX9 Discrete and D900, whose parametric EQ the
app edits over WebHID. The app was read on 2026-11-20 for facts only (D25: facts may become data;
nothing is copied) and its facts are cited as a `vendor-app` source. devicePEQ has no Topping
support (it turned Topping detection off), so the app is the only source. **Reads and writes were
tried on one DX5 II and the app recorded with it (below), so its profile is `maintainer-verified`;
the other four are unchecked and `draft`.**

## What the app does

- **Identity.** All five devices are USB `0x152a:0x8750`. The app tells them apart by the USB
  product name, stripped of spaces and case: names containing `DX5 II`, `DX9D` or `DX9 Discrete`,
  or ending in `E50 II` or `D900`, are those models, and any other name on that id is treated as
  the DX1 II.
- **Frame.** Every message is one 16-byte output report with id 0:
  `22 33 kind frames frame cmd-hi cmd-lo data(u32 BE) 00 00 66 77 00`. `kind` is `0x10` for a read
  and `0x20` for a write; the answers are `0x11`/`0x21` (and `0x1F`/`0x2F` on some paths). An
  answer is an input report in the same layout, with or without one byte in front. A long answer
  comes as `frames` reports, one 32-bit word each, numbered from 0 or from 1 (the app goes by the
  first one it sees). Single-frame commands are sent as frame 1 of 1, or 0 of 1 on the D900.
- **Session start**, per family. The app sends nothing else first.
  - DX1 II: connect (`0x1101`, 1), 100 ms, agreement (`0x1120`, 1), 100 ms.
  - E50 II: the same, then the settings read (below), whose firmware word it checks.
  - DX5 II: connect (`0x1101`, 2), 100 ms, then the firmware read (`0x1202`), checked.
  - DX9 Discrete: connect (`0x1101`, 2), 100 ms. Its agreement is the config list request itself.
  - D900: a capabilities read (`0x7144`), which the app requires to be one exact answer (a fixed
    set of values), then connect (`0x1101`, 2) repeated every 200 ms until the device answers 1,
    then agreement (`0x1120`, 1).
- **Config list.** The app asks for every stored config in one request, which the device answers
  as a two-frame header (the count, then one word of metadata) and each config as a run of frames
  of one word each (78 words; the app accepts 70 or more). A missing header counts as 3 configs.
  The request is the upload command (`0x1106`): a read with data 0 on the DX1 II and E50 II, a
  write with data 0 on the D900; the DX5 II and DX9 Discrete send the agreement command with data
  1 as a write instead. A config is a 15-byte name and band count, the pre-gain and its switch for
  each channel, then 11 bands of three words (switch, type and gain in tenths of a dB; frequency in
  Hz; Q in ten-thousandths) for the left channel and 11 for the right.
- **Firmware, active config and EQ switch.**
  - DX1 II: firmware by `0x1202` (the app checks none for the EQ; its home screen needs 2.30). The
    app only listens for the active config (`0x1206`, 0xFFFFFFFF for none). The EQ state is
    `0x1204`, bit 0.
  - E50 II: one settings read (`0x710C`, a read) answers a block of words: firmware at word 31 and
    the active config at word 14. No EQ switch; it uses the DX1 II's.
  - DX5 II: firmware by `0x1202` (the low 12 bits, the digits as hex: `0x239` is 2.39). The app
    waits for the device to announce its active config (`0x1206`) and its EQ switch (`0x7132`),
    and asks for neither.
  - DX9 Discrete: the settings read (`0x710C`, a read) holds the firmware at word 46, the EQ
    switch at word 54 and the active config at word 55.
  - D900: the settings read (`0x710C`, sent as a write) holds the firmware at word 49, the EQ
    switch at word 47 and the active config at word 48.
- **EQ on and off.**
  - DX1 II and E50 II have no switch: selecting no config (`0x110E`, 0xFFFFFFFF) turns the EQ off
    and selecting a config turns it on (the DX1 II sends the select twice, 140 ms apart).
  - DX5 II and DX9 Discrete: the EQ switch command (`0x7132`, 1 or 0), after selecting the config
    (120 ms pause on the DX5 II, 60 ms on the DX9 Discrete) when turning it on.
  - D900: the same command, but the device answers with the setting's command, a status (0 for
    done) and the value.
- **Writing a config.** The app selects it (`0x110E`, then 60 ms; 120 ms on the DX5 II), and sends
  every parameter as its own live command, then waits 85 ms. The pre-gain comes first: `0x9C01`
  (left), `0x9C02` (its switch, 1), `0x9C03` (right), `0x9C04`. A band is `0x9000 | band << 8 |
  field`, bands 1 to 11, fields 1 to 5 for the left channel (type, frequency, gain, Q, switch) and
  6 to 10 for the right. The app sends left and right of a band together, except on the D900,
  which gets all left bands before the right ones. Every 20 commands (10 on the DX5 II and D900)
  it pauses 10 ms; the DX5 II also pauses after the pre-gain. **It sends no save command after
  them.** Switching a band off writes it as a peak at 632 Hz, 0 dB, Q 0.707.
- **Editor limits.** 10 bands shown and 11 written (the 11th switched off; on the D900 it is a
  reserved band the app writes back as it read it). Frequency 20 to 20000 Hz in whole Hz (22000 on
  the D900), gain -12 to +12 dB in steps of 0.1, Q 0.1 to 15 in steps of 0.0001, pre-gain -12 to
  +12 dB in steps of 0.1. Types, as the editor sends them: 1 peak, 2 low pass, 3 high pass, 4 low
  shelf, 5 high shelf (the editor hides the gain of the passes).
- **Stored configs.** 3 on the DX1 II and E50 II (the app cannot delete one there), 10 on the
  others. The app creates, renames and deletes configs; a config's name is the user's.

## Where the app is plainly wrong or inconsistent

- **Pre-gain table.** The wire value is a linear gain with 0 dB at 2^25. The app takes it from a
  table of 0.1 dB steps that is one step off above +7.7 dB and below -10.3 dB and wrong at +3.5
  and -4.9 dB; for the D900 it computes `2^25 · 10^(dB/20)` instead. The formula is right, but
  the app reads a word that is not in its table as a neighbouring step (see the recording below),
  so the handler sends the app's own words, except for the D900.
- **AutoEQ headroom.** The app's AutoEQ code reads the filter type codes differently from its
  editor (2 low shelf, 3 high shelf, 4 low pass, 5 high pass, against the editor's 2 low pass, 3
  high pass, 4 low shelf, 5 high shelf), so its headroom calculation looks broken. The editor's
  codes are the ones sent to the device.
- **Firmware gates.** The app refuses a DX5 II below 2.37 and an E50 II below 1.52, while
  Topping's page asks for 2.39 and 1.56. There is no numeric gate for the DX9 Discrete (page: 0.46)
  or the D900 (page: 1.52); the D900 is gated by the capabilities answer.
- **Q.** The editor caps it at 15; some other paths of the app allow 20, and its text import
  clamps to 20.
- **Re-sent switch.** After each single-parameter edit it re-sends the band's switch from its
  cached copy.

## Done

- Handler `topping-usb-hid` with the option `family` (`dx1`, `dx5`, `e50`, `dx9d`, `d900`): the
  frame codec, the five session flows, config list, firmware, active config, EQ switch, pull and
  push. Tests with a simulated device.
- The DX5 II's settings as controls (below), tried on the device.
- Base `topping-home` (the editor's limits) and five profiles, `topping-dx1-ii`, `topping-dx5-ii`,
  `topping-e50-ii`, `topping-dx9-discrete` and `topping-d900`, each citing the app; `draft` but
  for the DX5 II's.

## Deliberate deviations from the app

- **Pre-gain** is the app's own word for every family but the D900, which computes it as the app
  does. The three steps the table repeats (-4.9, -10.4 and +7.8 dB) get a word halfway to the
  next step, which the app reads as the step meant.
- **Both channels** are written the same, and the L/R-mode mask the app updates after a save is
  not. A pull returns the left channel.
- **No heartbeat** (the app sends one every 1 or 5 s, by family), **no shutdown notice** on
  disconnect, and **no preview state** (the app's live preview of a config being edited).
- The active config of the DX1 II and DX5 II is **asked for** (`0x1206`), and so is the DX5 II's
  EQ switch (`0x7132`), although the app only listens for them. The DX5 II answers both.
- A **push refuses** a config the device does not hold, instead of creating it as the app does.

## The DX5 II's settings

The app reads the settings with one request, `0x710C` as a read with data 0. The DX5 II answers 52
frames (kind `0x20`, `frames` 52, `frame` 0 to 51), one 32-bit word each. Its settings are
controls (`protocol.controls` of `topping-dx5-ii`). Words, as read from the DX5 II:

| Word | Setting | Written by | Values |
| --- | --- | --- | --- |
| 9 | volume | `0x7102` | attenuation in 0.5 dB steps (60 is -30 dB), 1 dB steps when word 32 is 1 |
| 10 | mute | `0x7103` | 0 or 1 |
| 11 | input | `0x7104` | 0 USB, 1 OPT, 2 COAX, 3 BT |
| 12 | output | `0x7105` | 0 to 6 |
| 13 | gain | `0x7117` | 0 or 1; absent on the line-only outputs (2, 5, 6) |
| 17 | balance | `0x7116` | signed tenths of a dB (0xFFFFFFFB is -0.5 dB) |
| 18 | PCM filter | `0x710D` | 0 to 7 |
| 19 | line mode | `0x710E` | 0 or 1 |
| 25 | brightness | `0x710A` | 0 to 2 |
| 32 | volume step | not a control | 1 for 1 dB steps |
| 33 | polarity | `0x711D` | 0 or 1 |
| 42 | crossfeed type | `0x712B` | 0 to 2 |

A write is a single frame (kind `0x20`, frame 1 of 1) with the value as data; the device stores it
in the setting's word at once and echoes one frame, the same command and data. The app also
throttles the volume to one write per 120 ms, and sends nothing for it when a line-only output
(2, 5 or 6) is in DAC mode (line mode 1); the handler refuses such a write (`rejected`) instead.
The handler does not throttle: a control write waits 60 ms.

Tried on the DX5 II on 2026-11-20: each of the 11 controls written, read back and restored. The
device also echoes each write and, on an input or output change, re-announces the crossfeed, the
active config and the EQ switch.

Left out, though the app does them: power, Bluetooth, USB mode, the display's pages and themes,
key assignments, scenes, memories, language, option masks and factory reset. The other four
families' settings are not driven (the E50 II, DX9 Discrete and D900 read the same command, with
other layouts).

## Tried on a DX5 II (2026-11-20)

The owner's DX5 II, firmware 2.58, driven by the handler from a script on the Mac it is plugged
into. The app's own traffic was recorded afterwards (below), which made the profile
`maintainer-verified`.

- It reports the product name `DX5 II` and the manufacturer `Topping` on `0x152a:0x8750`.
- The session starts, the firmware reads as 2.58 and the config list reads, all without the
  heartbeat. On the connection notice the device announces its versions, sample rate, serial
  number and EQ state by itself.
- It held five configs, Bass 1, Bass 2, Airy, Warm and Dynamic: low shelves on type 4 and high
  shelves on type 5, the editor's codes. Left and right were equal, the 11th band switched off.
- The second word of the list's header was 1414546522, not the active config. The handler read
  it as that at first; it now asks for the active config, which the device answers although the
  app only listens for it. The device also answers a read of its EQ switch, so the bridge reads
  whether the EQ is on.
- A config written back unchanged read back the same; one band changed (frequency and Q, at 0 dB
  with the EQ off) read back as written; the original was restored.

## Recorded with Topping's app (2026-11-20)

The WebHID recorder on `home.toppingaudio.com/peq` with the owner's DX5 II (firmware 2.58, USB
input, HP SE output): the app connecting, then Bass 1 edited on the PEQ page. The pre-gain went
from -2.9 to -3.0 dB; band 2's gain went from 0 to -1.5 dB, its frequency from 632 to 700 Hz and
its Q from 0.707 to 1.2345, each then back; the EQ switch went on and off. The file is
`packages/device-bridge/test/recordings/2026-11-20-topping-dx5-ii.json` (2487 events), and
`test/recording-topping.ts` checks it against the handler and the profile:

- the handler, given the recorded answers, reads firmware 2.58, the five configs (a sixth is
  refused) and the settings the app's screen showed, and reads config 0 as the app did: encoding
  it gives the config the app wrote back after connecting, frame for frame;
- the profile lists at least five writable configs and accepts every filter and pre-gain the app
  wrote;
- each of the app's eight full config writes (114 frames: pre-gain, then 11 bands, both channels)
  decodes and encodes back to the same frames with the handler's codec, and decodes to what the
  notes say; the single frames sent at an edit are in the config that follows; and the EQ switch
  writes are what `setEnabled` sends.

What it showed:

- **The full-config write is the handler's, frame for frame, pacing included.** The app's pause
  is 12 to 15 ms after the pre-gain and after every 10 band commands, as `push` waits (it sends
  no select, as the config is already active).
- **On connecting, the app writes the active config back** to the device as it read it.
- **The pre-gain word.** The app reads a word that is not in its table as the neighbouring 0.1 dB
  step towards 0, so a computed word shifts by 0.1 dB the first time the app sees it: the app
  showed -2.9 dB for a config the handler had written as -3.0, then wrote -2.9 back. The handler
  now sends the app's own words. The three steps the table repeats (-4.9, -10.4 and +7.8 dB) get
  a word halfway to the next step, which the app reads as the step meant.
- **The EQ switch is re-sent.** After each full write the app sends the switch's current state
  (`0x7132`) again; the handler does not.
- **The heartbeat** (`0x7134` = 1) is sent every 5 s, 27 times in the recording. The handler
  sends none and works without it.

## What only a device can settle

- The exact USB product name strings of the other four: their names are guesses from how the app
  matches.
- Whether writes survive a power cycle with no save command.
- How long a session survives without the heartbeat, and what the device shows after the bridge
  leaves without the app's shutdown notice.
- Turning the EQ on and off, and the sound of a written config, on the DX5 II.
- Whether the DX1 II answers the active-config read.
- The E50 II's config numbering, from 0 or from 1 (the app has both).
- The 11th band, and the D900's reserved band.
- Whether firmware below the page's minimums but above the app's works.

## Next

1. **Record the other four families** with the WebHID recorder in `tools/userscripts/`; the DX5 II
   is recorded and checked (below).
2. **Device settings as controls for the other four families**, which differ per family (the
   DX1 II's are not even known). The DX5 II's are done (above).
3. **Creating, renaming and deleting configs**, so a push to a config the device lacks can work.
