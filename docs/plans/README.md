# Plans

Work in progress, one file per effort: what it is for, what is done, what is next. A plan is a
working note, not a source of truth. The format is defined only in [../SPEC.md](../SPEC.md),
decisions are recorded in [../DECISIONS.md](../DECISIONS.md), and what the project is now lives in
[../ARCHITECTURE.md](../ARCHITECTURE.md). Once the work has landed, a plan is moved to
[../history/](../history/) with an "Archived" note at the top, as `history/plan.md` was.

| Plan | Status |
| --- | --- |
| [fosi-audio.md](fosi-audio.md) | Device controls (format 1.2), the DS3 and the WebHID recorder done on `feat/device-controls`; recording a real DS3 and inspector support next |
| [nicehck.md](nicehck.md) | Walkplay firmware and controls, four NICEHCK profiles and the recorder adapter done on `feat/device-controls`; recording each device next |
| [walkplay.md](walkplay.md) | Walkplay's own app read against walkplay-hid: six disagreements (the commit first), unconfirmed until a device is recorded; recorder adapter done |
