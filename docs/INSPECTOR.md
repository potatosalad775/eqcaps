# Inspector web app

A static web app where users, contributors and developers can browse the database, connect their
own PEQ hardware, see what the database says about it, check that against the device itself, and
contribute the result back. It is the main *authoring and verification* tool for the database.

Format semantics referenced here are defined in [SPEC-DRAFT.md](SPEC-DRAFT.md).

## 1. Who it's for

| User | Wants | Tiers used |
| --- | --- | --- |
| EQ user | "Is my device supported, what are its limits, is my preset valid for it?" | T0, T1, T2 |
| Contributor | "My device isn't in the DB or the profile is wrong. Help me fix it with evidence." | T1–T4 |
| App developer | "How do I consume this? What does validate/fit do on my data?" | T0 (playground) |
| Protocol developer | "Unknown device. What does it expose?" | T1 (descriptor dump) |

## 2. Capability tiers

Each tier works without the ones above it. Tiers T0–T2 and T4 **never write to a device**.

### T0: Browse (no device)

- Search by brand, model, alias, USB id. Filter by status, kind and feature (has steps, partitioned, conditional…).
- **Profile view:** a per-slot chart (one row per slot on a log-frequency axis showing its freq
  window, variants drawn as alternative windows), plus gain/Q domains, type badges, rules,
  realization laws (marked measured or not), preamp, provenance with links to evidence, and raw
  JSON.
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

- Pull the current EQ from the device and show the written values in canonical units. When the
  profile has `realization` laws, also show what the listener gets (`toRealized`).
- Run `validate` against the matched profile. A discrepancy is a finding. For example, the device
  reports a gain of `0.05` while the profile says `step: 0.1`, or 12 slots come back while the
  profile says 10.
- Show what the handler's codec can represent (if the handler exposes a codec, §4), which explains
  read-back rounding.

### T3: Probe (writes to the device; explicit opt-in)

Automated push → pull experiments that **derive** constraints from the device's own behaviour, and
output a draft profile plus an evidence report. Details in §3.

### T4: Author and submit

- Schema-aware editor (form + JSON) with live semantic validation and a diff against the existing
  profile.
- Start from: an existing profile, a probe result, a base (`extends`), or blank.
- Submit without any backend:
  1. **Pull request:** open `https://github.com/potatosalad775/eqcaps/new/main?filename=data/profiles/<brand>/<id>.json&value=<urlencoded>`.
     GitHub forks automatically for non-collaborators and offers "Propose new file".
     Edits to an existing profile go through the `edit/` URL plus clipboard.
  2. **Issue** (fallback, and the route for large evidence files): issue form URL with prefilled
     fields; the evidence JSON is downloaded and attached by the user.
- Both routes are subject to URL length (~8 KB practical). The profile goes in the URL and evidence
  is always attached separately.
- The submit screen states that data contributions are CC0-1.0 (DECISIONS D25).

## 3. Probe methodology (T3)

### 3.1 Preconditions

Probing is offered only when all of these hold. Otherwise the UI explains which one fails.

- The bridge handler supports **read-back** (`canRead`). Write-only devices can't be probed (EarFun,
  Edifier).
- The handler supports **raw push**: no `normalizeFiltersForDevice`, no clamping in the app layer,
  and no `fit` or `toWritten` (§4). Codec-level clamps are known separately (§4) so results
  can be attributed.
- The device does not `disconnectOnSave`, or the handler supports automatic reconnection.
- The user has acknowledged the safety notice (§3.4).

### 3.2 Protocol

1. **Backup:** pull the current slot. Keep it in memory, offer it as a download, and show it on screen.
2. **Pick the target slot.** Prefer an inactive custom slot if the device has several, so nothing
   audible changes during the run.
3. **Experiments.** Each one is a set of pushes followed by pulls and a diff. To keep write counts
   low, each push tests **all slots in parallel**, with each slot carrying its own test value.

| Question | Method | Inference |
| --- | --- | --- |
| Slot count | push N = max(64, codec limit) bands with distinct marker gains | bands returned; truncation point |
| Gain range per slot | binary search each bound per slot, starting from ±30 dB | stored value clamps at bound, or write rejected |
| Gain step | push non-grid values (0.01, 0.13, 0.26, 0.37, 0.49) | read-back values → largest step consistent with all observations |
| Q range / step | same as gain, in log space | |
| Freq range / step per slot | binary search per slot bound (finds partitions); non-grid values for step | per-slot windows → `bands[]` overrides |
| Value sets | if read-back snaps to irregular values, sweep and collect distinct outputs | `values` |
| Types per slot | push each type to each slot | type kept / coerced / gain zeroed |
| Conditional domains | repeat freq-bound searches with gain > 0 and gain < 0, and per type | differing windows → `variants` |
| Ordering | push descending frequencies | device reorders, rejects, or accepts → `ascendingFrequency` |
| Preamp | same as gain on the preamp field, if the handler exposes it | `preamp` |

4. **Restore** the backup, then pull and confirm the restore. If restoring fails, keep the backup
   prominently on screen with instructions.
5. **Emit** a draft profile (`meta.status: draft`, `source.kind: probe`, `by` set to the
   contributor) and an evidence report. Submitted together, they let a maintainer raise the profile
   to `community-verified` (SPEC §10).

Step inference: given observed pairs (sent → stored), the step is the largest `s` such that every
stored value is on the `s` grid and every sent value projects to its stored value. Candidates come
from a list of known steps (1/4096 … 1) plus the GCD of stored differences. Anything not cleanly
explained is reported as "no uniform grid" and the profile falls back to `values`.

### 3.3 Write budget

A full probe is about 15 binary-search rounds × (gain, Q, freq bounds) plus step, type and condition
tests, roughly 80–120 writes. A **quick probe** (slot count, gain range and step only) is about 25.
Flash endurance is typically ≥ 10k cycles, so this is safe, but the UI shows the planned count before
starting, and the counter while it runs.

### 3.4 Safety

- **Hearing:** probes write large gains (up to +30 dB). The notice requires headphones off or
  output muted, and the UI repeats it before the first write.
- Never probe the active slot while audio could be playing, if a spare slot exists.
- Abort cleanly on disconnect or error, and always attempt restore.
- Rate-limit writes (default ≥ 100 ms apart; handler-specific overrides).
- No firmware, DFU or non-EQ commands are ever sent. The bridge exposes only EQ push/pull/enable to
  the probe engine.

### 3.5 What probing cannot tell you

- **Read-back ≠ realized response.** Firmware may store 15 dB while the DSP clips at 12, or store a
  Q it then ignores, or realize a Q or frequency that differs from what it stores
  ([research/prior-art.md §2.1](research/prior-art.md#21-realization-compensation-devicepeq-upstream)).
  Only acoustic measurement (`source.kind: measurement`) verifies realization, and it's the only
  evidence that can establish `realization` laws (SPEC §8). The evidence report states this
  explicitly. devicePEQ's REW-driven verification page and its browser-native sweep
  capture are prior art for a later measurement tier
  ([research/prior-art.md §5](research/prior-art.md#5-upstream-assets-worth-reusing)). That tier
  isn't planned for v1.
- **Whole-set rejection.** Some devices reject an entire write if one band is invalid, so the
  parallel strategy degrades to per-slot searches (more writes). The probe engine detects this
  ("nothing changed") and switches strategy.
- **Silent resets.** Some devices reset to defaults on invalid input. Detected by markers in other
  slots changing unexpectedly. Reported, not interpreted.

## 4. Device bridge requirements

The inspector uses `packages/device-bridge`, extracted from modernGraphTool's `src/lib/device-peq`
(MIT, based on devicePEQ 0BSD). The extraction adds:

| Need | Change |
| --- | --- |
| Identify unknown devices | connectors accept "any device" mode; identity separated from handler lookup |
| T2/T3 attribution | **split each handler into a pure codec** (`encode(bands) → bytes`, `decode(bytes) → bands`) and transport I/O. The codec alone can be probed offline (encode→decode) to learn wire-level limits with no hardware, which feeds `handler-code` sources automatically. It also gives a virtual device for tests and UI work. |
| Raw push | `push(..., { raw: true })` sends written values straight to the codec: no `normalizeFiltersForDevice`, no clamping. With realization in profiles (SPEC §8) the bridge has no compensation to bypass, unlike devicePEQ, which needed a verification-only switch. |
| Portable transports | handlers talk to a transport interface (open, send/receive reports or bytes, close) with no browser types. WebHID, Web Serial, Web Bluetooth and fetch are the browser implementations. The Android app supplies a native USB one (DECISIONS D27). |
| Capability flags | `canRead`, `canWrite`, `slots`, `disconnectOnSave`, `supportsPreamp` exposed per handler |
| Link to DB | registrations reference a profile **id** instead of carrying `minGain`/`maxGain`/`maxFilters`/`supportsLSHSFilters`. Protocol-only fields (`reportId`, `schemeNo`, `baudRate`, slots…) stay in the bridge. |

Handlers are migrated incrementally: an unmigrated handler still supports T1/T2 and simply can't be
probed. Upstream devicePEQ's recorded device captures (`tests/captures/`, real device exchanges
per model) become codec regression tests and seed the virtual device.

## 5. Architecture

```
apps/inspector (Svelte 5 + Vite, static SPA)
  ├── uses packages/client       fetch index/profiles, cache, match identity → profiles
  ├── uses packages/core         resolveSlot / validate / fit / assign / complete / toRealized / toWritten
  ├── uses packages/device-bridge  connectors + handlers (+ codecs)
  └── probe engine (in-app module) experiment planner, inference, evidence writer
```

- Deployed with the published data on the same origin (`/` = app, `/v1/…` = data).
- Works offline for T0 once the data is cached (service worker, optional).
- Browser support: device features need Chromium (WebHID/WebSerial/Web Bluetooth) over HTTPS.
  T0 and T4 work in every browser, and the UI says why device tiers are unavailable instead of
  hiding them.

## 6. Evidence report and privacy

```jsonc
{
  "evidenceVersion": 1,
  "tool": { "name": "inspector", "version": "0.3.0", "bridge": "0.3.0", "userAgent": "…" },
  "device": { "transport": "hid", "vendorId": "0x2972", "productId": "0x0047",
              "productName": "…", "firmware": "1.4" },
  "handler": "fiio-usb-hid",
  "date": "2026-09-30",
  "backupRestored": true,
  "experiments": [
    { "id": "gain-max-slot0", "pushes": [ { "sent": { }, "readBack": { }, "ms": 140 } ], "conclusion": { } }
  ],
  "derivedProfile": { },
  "caveats": ["read-back only; realization not verified"]
}
```

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
| `/connect` | T1 identify → T2 read → T3 probe wizard |
| `/edit/<id?>` | T4 editor + submit |
| `/docs` | consumer guide (how to use the CDN, client, engine) |
