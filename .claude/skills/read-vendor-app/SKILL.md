---
name: read-vendor-app
description: Read a device vendor's own EQ app (web bundle, Android APK, desktop app) for facts, and change eqcaps' handler and data to match it. Use when a vendor app is found for a device or protocol, when the bridge or a profile disagrees with one, or when asked to support a device "as its app drives it".
---

# Read a vendor app

The vendor's app is the reference for what the bridge sends and what the data says (D50).
Done so far for Walkplay (`docs/plans/walkplay.md`), NICEHCK (`nicehck.md`), Tanchjim
(`tanchjim.md`) and Fosi Audio (`fosi-audio.md`); read the closest one first.

## 1. Get the code, facts only

Work in the scratchpad, never in the repository: no bundle, decompiled source or decoding script
is committed or copied (D25). What becomes data or code is facts (frames, ranges, ids), written
in our own words.

- **Web app:** download its JS bundle. If it is obfuscated (javascript-obfuscator: a base64 string
  table per module, rotated at startup until a `parseInt` checksum matches), decode it
  statically: parse with `acorn`, rebuild each table's rotation, replace constant calls with their
  strings. Never execute the bundle. Note the bundle's file name and the date.
- **Android app:** decompile the APK with jadx. Note the package name and version.
- **Desktop app (native):** its code is out of reach; record its USB traffic instead (USBPcap +
  Wireshark on Windows).
- **Public config APIs** the app calls (NICEHCK's `config-sync`) are facts too.

## 2. Extract

For each device family the app supports:

- **Identity:** USB vendor/product ids, product names, Bluetooth names; how the app picks a
  protocol (by product name, by a backend lookup, by firmware).
- **Transport:** report ids, frame sizes, endpoint or control transfer, timeouts.
- **Reads:** each request and where the answer's fields sit.
- **Writes:** band frames, then everything after them: apply, save, pre-gain, extra commands, in
  order, with the delays between frames. Also what the app **never** sends (devicePEQ's commit
  had factory-reset commands no vendor app sends).
- **Data:** band count, filter types and their wire codes, frequency/Q/gain ranges and steps as
  the app's editor allows them, pre-gain, presets (built-in or writable), and device controls
  with their values. Unit conversions the app makes on the way (Tanchjim halves the frequency on
  some models).
- **Where the app is plainly broken** (Tanchjim computes peaking coefficients for every type).

## 3. Compare and change

List each disagreement with the handler (`packages/device-bridge/src/handlers/`), its base in
`data/bases/` and the profiles. Then change them to match the app, without waiting for a
recording:

- Behaviour that only this vendor's app has goes in a handler option, so other brands on the same
  handler keep theirs (`OPTIONS` in `src/protocols.ts` + the bridge README). New controls go in the
  handler's `controls` + the README.
- Data: a base per vendor and protocol (`tanchjim-walkplay`, `nicehck-walkplay`) holding the
  app's ranges, types, options and controls; device profiles extend it. A conversion the app
  makes is a `protocol` option and the domain stays in the app's units (D39).
- Cite the app as a `vendor-app` source: the app, its version and the classes or page read, e.g.
  `"TANCHJIM Android app 2.5.7.4 (com.tanchjim.android): StarGate2Command, …"`, or the web app's
  URL. Status stays `draft` until a device confirms it (SPEC §10).
- Put devicePEQ's differences in the profile's or base's `meta.notes`, and any deliberate
  deviation from the app with its reason.
- Tests: handler behaviour in `test/handlers.test.ts`, codec round trips, and captures or
  recordings where there are any. Run `npm run lint`, `npm run check`, `npm test` and
  `npm run data:validate`.
- A new option or control needs a bridge release before the data reaches `main` (AGENTS.md).

## 4. Write it down

In `docs/plans/<vendor>.md` (and its row in `docs/plans/README.md`): what the app does, the
disagreements, what changed, and what only a device can settle. Say how the code was read (tool,
version, bundle name, date) so the next read of a newer build can be compared.

## 5. Confirm on a device, when one is at hand

For a web app, record it with the WebHID recorder (`tools/userscripts/README.md`), adding an
adapter if the app is new; save to `packages/device-bridge/test/recordings/` and run
`recordings.test.ts`. Otherwise, push from the handler (uniPEQ with `release --pack` tarballs),
listen, replug and read back. Agreement on the owner's device makes a profile
`maintainer-verified`.
