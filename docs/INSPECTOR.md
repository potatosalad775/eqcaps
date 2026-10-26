# Inspector web app

A static web app at [potatosalad775.github.io/eqcaps](https://potatosalad775.github.io/eqcaps/)
where users, contributors and developers can browse the database, connect their own PEQ hardware,
see what the database says about it, check that against the device itself, and contribute the
result back. It is the main *authoring and verification* tool for the database.

Format semantics referenced here are defined in [SPEC.md](SPEC.md); code comments cite this file's
sections (`INSPECTOR §3.3`), so their numbers stay put.

## 1. Who it's for

| User | Wants | Tiers used |
| --- | --- | --- |
| EQ user | "Is my device supported, what are its limits, is my preset valid for it?" | T0, T1, T2 |
| Contributor | "My device isn't in the DB or the profile is wrong. Help me fix it with evidence." | T1–T4 |
| App developer | "How do I consume this? What does validate/fit do on my data?" | T0 (playground) |
| Protocol developer | "Unknown device. What does it expose?" | T1 (descriptor dump) |

## 2. Capability tiers

Each tier works without the ones above it. The inspector **never writes to a device** (DECISIONS D40).

### T0: Browse (no device)

- Search by brand, model, alias, USB id. Filter by status, kind and feature (has steps, partitioned, conditional…).
- **Profile view:** a per-slot chart (one row per slot on a log-frequency axis showing its freq
  window, variants drawn as alternative windows), plus gain/Q domains, type badges, rules,
  preamp, provenance with links to evidence, and raw JSON.
- **Playground:** paste filters (Equalizer APO text, AutoEQ `ParametricEQ.txt`, or JSON), pick a
  profile, and see `validateList` violations and the `fit` result as a diff. This is where app
  developers learn the engine.

### T1: Identify (read-only, no protocol needed)

- Connect via WebHID with empty filters (any HID device), WebSerial, or Web Bluetooth.
- Show the raw identity the browser exposes (see [research/prior-art.md §3](research/prior-art.md#3-identity-data-available-to-consumers)),
  the matched profiles with specificity, and whether the device bridge has a handler for it.
- **Descriptor dump** (WebHID): collections, usages, input/output/feature report IDs and sizes.
  Protocol developers get this without installing anything.
- Unknown device: a "Report this device" button produces a prefilled GitHub issue (identity JSON +
  descriptor dump, after PII review, §6).

### T2: Read (read-only, needs a handler with read-back)

- Pull the current EQ from the device and show the written values in canonical units.
- Run `validate` against the matched profile. A discrepancy is a finding. For example, the device
  reports a gain of `0.05` while the profile says `step: 0.1`, or 12 slots come back while the
  profile says 10.
- Show what the handler's codec can represent (if the handler exposes a codec, §4), which explains
  read-back rounding.

### T3: Guided read (read-only)

The user changes the EQ in the vendor's own app, step by step as the inspector asks, and the
inspector reads the device back after each step. What the vendor app let the user set becomes
`vendor-app` evidence for the profile. Details in §3.

### T4: Author and submit

- Editor (form + JSON) for **authoring files**, read from the repository (bases aren't
  published), that runs CI's own checks as the user types and shows a diff against the existing
  file (DECISIONS D35).
- Start from: an existing profile, a read-back or guided read, a base (`extends`), or blank. A
  device the database lacks starts from its protocol's wire limits, cited as `handler-code`. A
  device matched only by a group profile is offered **Add my device**: a profile of its own that
  extends the group's base, prefilled from its identity and read-back (D37).
- Submit without any backend:
  1. **Pull request:** open `https://github.com/potatosalad775/eqcaps/new/main?filename=data/profiles/<brand>/<id>.json&value=<urlencoded>`.
     GitHub forks automatically for non-collaborators and offers "Propose new file".
     Edits to an existing profile go through the `edit/` URL plus clipboard.
  2. **Issue** (fallback, and the route for large evidence files): issue form URL with prefilled
     fields; the evidence JSON is downloaded and attached by the user.
- Both routes are subject to URL length (~8 KB practical). The profile goes in the URL and evidence
  is always attached separately, since one link can only create one file.
- A read from the connect page arrives with its evidence file cited and is re-checked against
  every edit.
- The submit screen states that data contributions are CC0-1.0 (DECISIONS D25).

## 3. Guided reads (T3)

Learning a device's limits by writing test values and reading back what stuck needs firmware
that checks what it is sent, and many don't (Walkplay stores anything); every firmware bug also
becomes a risk to the user's device and hearing. An early "probe" mode did this and was removed
(DECISIONS D40). Guided reads turn it around: **the vendor's app does the writing**, inside its
own limits, and the inspector only reads. The limits found are the vendor's
UI limits, which SPEC §10 already treats as `vendor-app` evidence: a safe subset of what the
firmware accepts, not necessarily all of it.

### 3.1 Flow

1. The device is connected and read (T2), and matched to a profile or not.
2. The user picks **Guided read**. The page shows the steps it will ask for and a hearing notice:
   steps ask for the vendor app's extreme values (its largest gain, its narrowest Q), so take the
   headphones off or mute the output first.
3. Each step is one instruction ("In the vendor app, set band 1's gain as high as it goes"), a
   **Read** button, and what the read showed. The user may skip a step, and redo it.
4. After a read, the page says what changed since the last read. A step whose read shows no change
   says so and asks again: the user may not have saved in the vendor app, or the app may write
   only when it closes.
5. At the end: the findings, the evidence file to review (§6), and **Use in a profile**, which
   opens the editor with the findings as constraints, as today's read-back handoff does (D35).

### 3.2 Steps

Each step names one band and one field, and is chosen from what's still unknown. The first band
always; the last band too, and every band only when the first and last disagree.

- **Bands:** the user says how many bands the vendor app shows; the page reads that many and
  confirms each read answers.
- **Gain:** highest, then lowest, then "one step up from 0 dB" (the step).
- **Frequency:** lowest, highest, and one step up from a value the user reads off the app.
- **Q:** lowest and highest, and one step.
- **Types:** "set band 1 to each type the app offers, one per read", which records the wire code of
  each type the app uses, and which ones it offers.
- **Preamp**, where the protocol reads it: lowest, highest, one step.
- **Grid check:** a value with many decimals (1.111111) the user types into the app, where the
  app allows typing. It shows whether the app rounds typed values onto its own step or passes
  them on as they are, which the buttons can't show (§3.3).

Not planned: conditional domains (a window that changes with gain or type) and rules. The notes say
they weren't checked.

### 3.3 Inference

From the reads only: a bound is the value read at the extreme step; a step is the difference of
two reads one step apart, cross-checked by the GCD of every value the app set for that field
(not the device's defaults); a type is the code read after the user chose it. Values are read
through the wire's rounding: a device with 1/256 dB steps holds 0.1015625 for the app's 0.1, and
the shortest decimal within half a wire step is taken as the app's value.

A grid check decides between two kinds of app. If a typed 1.111111 reaches the device as its own
rounding onto the wire (1.109375 at 1/256), the app **passes typed values through**: the step is
the wire's, however coarse the app's buttons, and the bounds are the values the device holds
(Q 0.1015625, not 0.1), since those are what it is told. If the device holds the typed value
rounded to the app's step, the app's step stands. Where the app's step is the wire's, the two
can't be told apart and don't need to be. Without a grid check (an app with sliders only), the
step is the app's; the wire may carry finer values, but nothing the vendor offers sends them, so
the profile describes what the vendor supports. (Walkplay's web app, for one, has 0.1 dB buttons
but passes a typed 1.111111 through as the wire's 1.109375.)

A value that disagrees with the matched profile is a finding, as in T2. The result is a set of
constraints (band count, per-band domains, types, preamp), with notes for what wasn't asked or
didn't settle.

### 3.4 Connection

The vendor app and the inspector may not share the device:
- **Vendor web app in another tab** (Walkplay, NiceHCK): both can hold the device. Checked on a
  CrinEar Protocol Micro with Walkplay's web app in Chrome on macOS, opened in either order; the
  app writes on every change, and the inspector's next read shows it (DECISIONS D41).
- **Vendor phone or desktop app:** the device moves to the phone for each step and back. The page
  reconnects to a device it was already granted (`navigator.hid.getDevices()`) without the chooser,
  and checks it's the same device by its identity.

The design must work in the second case too: one read per step, the device reconnected for each.
Change detection reports every change since the last read, not only the one asked for: a user
may touch other controls (a preamp moved during the first check on hardware).

### 3.5 Safety

- The inspector never writes. No push, no `setEnabled`, nothing but reads.
- The hearing notice stays: the steps ask for extreme values, which the user sets.
- The last step asks the user to put their EQ back in the vendor app, and a final read confirms
  it matches the first read.

### 3.6 What read-back can't tell you

- **Read-back ≠ what you hear.** Firmware may store 15 dB while the DSP clips at 12, or store a Q
  it then ignores, or place a filter off the frequency it stores
  ([research/prior-art.md §2.1](research/prior-art.md#21-realization-compensation-devicepeq-upstream)).
  Only acoustic measurement shows how the device sounds, and the format doesn't record that
  (SPEC §8, DECISIONS D39). The evidence report says so.
- **Vendor-app limits are a subset.** The firmware may accept more than the app allows. A profile
  from a guided read describes what the vendor supports, which is what apps should send.

## 4. Device bridge

The inspector drives devices through `packages/device-bridge` (DECISIONS D33), and only reads:

| Need | What the bridge gives |
| --- | --- |
| Identify unknown devices | "any device" connect, and identity separate from the protocol: the client matches a device, the profile's `protocol` says which handler drives it (D42), and an unknown device gets its vendor's usual protocol, marked experimental |
| T2 attribution | every handler is a pure codec (`encode`, `decode`, `wire()`: the range and resolution each field can carry) plus a session, so the inspector can say what a value becomes on the wire without a device, and start a `handler-code` draft from the codec's limits |
| Descriptor dump | HID collections, usages and report sizes from the transport |
| Capability flags | whether a protocol reads, how many bands it needs told, whether it reports the preamp and the current preset |

The bridge also has `push` and `setEnabled` for apps. The inspector imports neither, and a test
(`no-writes.test.ts`) checks that.

## 5. Architecture

```
apps/inspector (Svelte 5 + Vite, static SPA)
  ├── uses packages/client       fetch index/profiles, cache, match identity → profiles
  ├── uses packages/core         resolveSlot / validate / fit / assign / complete
  ├── uses packages/device-bridge  connectors + handlers (+ codecs), pull only
  └── src/lib/guided/            guided reads: step planner, inference, evidence writer
```

- Deployed with the published data on the same origin (`/` = app, `/v1/…` = data).
- The client caches the index and bundle in `localStorage`, revalidated after 5 minutes so
  contributors see their merged changes quickly.
- Browser support: device features need Chromium (WebHID/WebSerial/Web Bluetooth) over HTTPS.
  T0 and T4 work in every browser, and the UI says why device tiers are unavailable instead of
  hiding them.

## 6. Evidence report and privacy

A read (T2) is recorded as one experiment:

```jsonc
{
  "evidenceVersion": 1,
  "tool": { "name": "eqcaps inspector", "commit": "da24539", "userAgent": "…" },
  "device": { "transport": "hid", "vendorId": "0x31b2", "productId": "0x0113",
              "productName": "Chu2 DSP", "firmware": "…" },   // firmware only if the user gives it
  "handler": "ktmicro-usb-hid",                                // "experimental": true when guessed
  "profile": "moondrop-chu-2-dsp",                             // the profile it was checked against
  "date": "2026-10-03",
  "experiments": [
    { "id": "read",
      "readBack": { "filters": [{ "type": "PK", "freq": 1400, "q": 7, "gain": 0 }, null], "preamp": 0 },
      "findings": ["Slot 3: q 7 is out of range (allowed: 0.1 – 5 in 0.001 steps)"] }
  ],
  "caveats": ["Read-back only: …", "Read-back shows the values the device was told, …"]
}
```

A profile cites it as a `community` source: it shows values the device holds, not its limits
(SPEC §10, DECISIONS D35). The file is named `<date>-<first 6 hex of its SHA-256>.json`.

A guided read (§3) adds the vendor app and one experiment per step (DECISIONS D41):

```jsonc
{
  "evidenceVersion": 1,
  "tool": { … }, "device": { … }, "handler": "walkplay-hid", "profile": "…", "date": "…",
  "vendorApp": { "name": "Walkplay EQ web app", "version": "…", "platform": "web" },  // typed by the user
  "experiments": [
    { "id": "read", "readBack": { … }, "findings": [] },
    { "id": "gain-max-1",
      "instruction": "In the vendor app, set band 1's gain as high as it goes.",
      "band": 1, "field": "gain", "ask": "max",
      "readBack": { "filters": [ … every band … ], "preamp": 0 },
      "changed": [{ "band": 1, "field": "gain", "from": 0, "to": 10 }],
      "conclusion": { "band": 1, "field": "gain", "max": 10 } },
    { "id": "q-min-1", "skipped": true },
    …
    { "id": "restore", "readBack": { … }, "changed": [] }   // against the first read
  ],
  "constraints": { "bands": 8, "gain": { "min": -10, "max": 10 }, … },
  "notChecked": ["conditional domains", "rules"],
  "caveats": [ … ]
}
```

A redone step is a new experiment with the same `id`; the last one counts. A profile cites the
file as a `vendor-app` source: it records the vendor app's limits (SPEC §10).

- **Never collected:** serial numbers, Bluetooth MAC addresses, IP addresses of network devices.
- **Reviewed before export:** Bluetooth names, which are often personal ("Alex's EH13"). The export
  screen shows every string field and lets the user redact it.
- Nothing is uploaded anywhere by the app itself. Submission is always a user-driven GitHub action.

Stored at `data/evidence/<profile-id>/<date>-<short hash>.json`, referenced from `meta.sources`.

## 7. Pages

| Route | Content |
| --- | --- |
| `/` | search + "Connect a device" |
| `/p/<id>` | profile view (T0) |
| `/playground` | validate/fit playground |
| `/connect` | T1 identify → T2 read → T3 guided read |
| `/edit/<id?>` | T4 editor + submit |
| `/docs` | consumer guide (how to use the CDN, client, engine) |
