# Plans

Work in progress, one file per effort: what it is for, what is done, what is next. A plan is a
working note, not a source of truth. The format is defined only in [../SPEC.md](../SPEC.md),
decisions are recorded in [../DECISIONS.md](../DECISIONS.md), and what the project is now lives in
[../ARCHITECTURE.md](../ARCHITECTURE.md). Once the work has landed, a plan is moved to
[../history/](../history/) with an "Archived" note at the top, as `history/plan.md` was.

| Plan | Status |
| --- | --- |
| [fosi-audio.md](fosi-audio.md) | Device controls (format 1.2), the DS3 (recorded, maintainer-verified) and the WebHID recorder done; inspector support and more Fosi devices next |
| [nicehck.md](nicehck.md) | Walkplay firmware and controls, four NICEHCK profiles (recorded, maintainer-verified) and the recorder adapter done; the Octave waits for an owner |
| [walkplay.md](walkplay.md) | Walkplay's own app read against walkplay-hid; the commit now follows the vendor apps (2026-11-01); recorder adapter done |
| [tanchjim.md](tanchjim.md) | Tanchjim's KT Micro devices follow the vendor app (handler options, two bases, 8 new profiles); FOLA identified; the app's Walkplay-chip (TTGK) devices profiled and written as the app does; Space II retest next; Luna has no EQ |
| [agent-docs.md](agent-docs.md) | AGENTS.md, the `read-vendor-app` skill and D50 done (2026-11-01); a fresh-session check next |
| [fiio.md](fiio.md) | FiiO, Snowsky and JadeAudio aligned with FiiO Control (limits, types, presets, `bandCount()`, 12 new profiles); K17 family, K15 and recording next |
