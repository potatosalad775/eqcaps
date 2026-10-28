# Userscripts

## eqcaps WebHID recorder

`eqcaps-webhid-recorder.user.js` records what a vendor's web app sends to a device over WebHID and
what the device answers, while you use the app as usual. On pages it knows, it also saves what the
app decoded from those answers. `packages/device-bridge/test/recordings.test.ts` then checks that
our handler reads the same answers the same way, sends the app's writes as the same bytes, and
that the device's profile offers what the app read.

The recorder only watches. It wraps the page's `HIDDevice` methods to log each report and never
sends anything itself. **Read all** asks the vendor app to run its own read actions: everything
sent is sent by the vendor's code, and the reads change nothing on the device.

Pages it knows:

| Page | Adapter | Devices |
| --- | --- | --- |
| Fosi Audio control center, `https://cc.fosiaudio.com` | `fosi-cc` | DS3 (checked); C1, C3, ZH1, ZH3 (recorded, not yet checked) |
| NICEHCK web app, `https://app.nicehck.cn` | `nicehck-app` | PureAural, StringSnow, Tears, 10th Anniversary Edition, Octave (checked against a simulated device only) |
| Walkplay web app, `https://peq.szwalkplay.com` | `walkplay-peq` | Walkplay-chipset devices (writes checked; snapshots recorded, not checked) |

On NICEHCK's app, **Read all** runs the reads the app makes when it connects (firmware, every band,
pre-gain, every control), and waits for the answers, which arrive as input reports. Open the
device's page first (Device or Equalizer); the connect page doesn't have the read action.

Walkplay's app has no **Read all**: it reads the device when it connects, so start the recording
before you connect, then use the app and press **Snapshot**.

### Recording a device

1. Install a userscript manager (Tampermonkey or Violentmonkey) in a Chromium browser, and open
   the raw file of `eqcaps-webhid-recorder.user.js` to install the script.
2. Open the vendor app. A small "eqcaps recorder" panel appears at the bottom right.
3. Connect the device in the app and open its page.
4. Press **Read all**. When it says done, the recording holds every read and a snapshot of the
   app's state.
5. Optionally, change things in the app the way you normally would (a band, the pre-gain, a
   control), then press **Snapshot** or **Read all** again. Each write the app sends is checked
   too. Write down what you did in the notes field: the firmware, the USB mode, what you changed.
6. Press **Export** and save the file to `packages/device-bridge/test/recordings/`, keeping its
   name (`<date>-<device>.json`).
7. Run `npx vitest --run packages/device-bridge/test/recordings.test.ts`. Each disagreement is one
   sentence: a fix for the handler, the profile, or a documented difference.

Record each USB mode or firmware you want checked as its own file, or switch modes and press
**Read all** again in the same recording.

### Privacy

A recording holds the device's USB ids and product name, the reports exchanged, the app's state
for the device (presets, bands, settings), the browser's user agent and your notes. WebHID doesn't
expose serial numbers. Read the file before you submit it, as for inspector evidence (INSPECTOR
§6).

### Format

```jsonc
{
  "recording": "eqcaps-webhid", "version": 1,
  "recordedAt": "2026-10-28T19:02:11.000Z",
  "tool": { "name": "eqcaps WebHID recorder", "version": 1 },
  "page": { "origin": "https://cc.fosiaudio.com", "path": "/#/ds3" },
  "userAgent": "…", "notes": "firmware 1.4.12, UAC 2.0",
  "devices": [{ "vendorId": 5418, "productId": 34971, "productName": "Fosi Audio DS3",
                "collections": [ … ] }],
  "snapshots": [{ "t": 5120.4, "label": "read all", "adapter": "fosi-cc", "store": "ds3Store",
                  "state": { … the app's device info … } }],
  "events": [
    { "t": 812.3, "device": 0, "op": "output", "reportId": 1, "data": "77a600…" },
    { "t": 815.9, "device": 0, "op": "feature-in", "reportId": 1, "data": "0177a6…" }
  ]
}
```

`op` is `output` (`sendReport`), `feature-out` (`sendFeatureReport`), `feature-in` (what
`receiveFeatureReport` returned, report id first) or `input` (an input report). `data` is hex. An
event whose call failed has `error` instead of, or as well as, `data`. `t` is milliseconds since
the page loaded; a snapshot's `t` is when it was taken, so the checks read only the answers
recorded before it.

### Adding a vendor app

Add an `@match` line for the app's origin and an adapter next to `fosi` and `nicehck`: how to find
the app's state for the connected device, its read actions, and how to snapshot the state (`fosi`
reads Vue's Pinia stores; `nicehck` walks React's hooks for a zustand store). Then add a checker
next to `test/recording-fosi.ts` that maps the app's state onto the handler's results, and list it
under the adapter's id in `recordings.test.ts`.
