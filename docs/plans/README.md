# Plans

Work in progress, one file per effort: what it is for, what was found, what is open. A plan is a
working note, not a source of truth, and not a changelog: `git log` has what changed. The format is
defined only in [../SPEC.md](../SPEC.md), decisions are recorded in
[../DECISIONS.md](../DECISIONS.md), and what the project is now lives in
[../ARCHITECTURE.md](../ARCHITECTURE.md). Once the work has landed and nothing cites the plan, it is
deleted: the repository's history keeps it.

| Plan | Status |
| --- | --- |
| [fosi-audio.md](fosi-audio.md) | The DS3 recorded and `maintainer-verified`; next the inspector reading the firmware and controls, and profiles for the C1, C3, ZH1 and ZH3 once their preset layout is known (a recording, or the handler writing after the built-in presets as the app does) |
| [nicehck.md](nicehck.md) | All four of the owner's NICEHCK devices recorded and `maintainer-verified`; the Octave waits for an owner to record it |
| [walkplay.md](walkplay.md) | Walkplay's web and Android apps followed by every group (schemes 17 and 19 on the KT Micro handler) and 12 of the 19 other-brand profiles; next a recording of a Walkplay-scheme device, the pre-gain in byte 34, noise reduction, and the seven profiles the catalog can't place |
| [tanchjim.md](tanchjim.md) | The KT Micro (FeiFan) and Walkplay (TTGK) devices follow the app; the FOLA tried, not yet `maintainer-verified`; next its by-ear pass, the TTGK coefficient test, a recording and the Space II retest; the Luna has no EQ |
| [agent-docs.md](agent-docs.md) | AGENTS.md, D50 and the `read-vendor-app` skill done; the rules a script can check are checks (2026-11-22); next a fresh-session check |
| [kiwi-ears.md](kiwi-ears.md) | Follows the web EQ; the Allegro Mini recorded and `maintainer-verified`; next whether the global gain acts before or after the EQ, and the devices nobody here has |
| [moondrop.md](moondrop.md) | Follows the web app (1.8.0); every profile `draft`, nothing confirmed on a device; next a device to test on, a recorder adapter and the newer build compared |
| [fiio.md](fiio.md) | FiiO, Snowsky and JadeAudio follow FiiO Control 4.4.6, all `draft`; next the K17 family and the K15 over serial, a recorder adapter for the band counts, and the EQ switch |
| [qudelix.md](qudelix.md) | The 5K and 5K Plus follow the Chrome app 4.0.3.1 and are `maintainer-verified` (both EQs, the headphone EQ's left and right apart, the settings as controls); the T71 `draft` and `experimental`; next the settings checked against the app's screen |
| [topping.md](topping.md) | Topping Home drives five families; the DX5 II `maintainer-verified` (EQ, configs, settings, left and right apart), the other four `draft`; next recording them, their settings as controls, and the D900's config layout |
