# Agent docs: one short AGENTS.md of rules

Started 2026-11-01. AGENTS.md, D50 and the `read-vendor-app` skill landed that day; the rules a
script can check moved into `scripts/docs-check.ts` and ESLint's import boundaries on 2026-11-22.

## Why

Agents read CLAUDE.md every session and the rest only when sent there. The rules they must follow
were spread over about 50 decisions, SPEC and the plans, and CLAUDE.md mixed them with
description. It also contradicted a rule: it said protocols come from devicePEQ while D39's dated
note said the vendor app comes first, and agents followed CLAUDE.md.

## Shape

- **AGENTS.md** is the one agent file; CLAUDE.md only imports it (`@AGENTS.md`), as in uniPEQ.
  Short imperatives: what the repo is, commands, sources of truth in order (the vendor's app,
  recorded device answers, devicePEQ), hard rules, where things live.
- **A rule exists for agents only if it is a line in AGENTS.md.** DECISIONS.md stays as the human
  record of why, and is not where an agent looks up what to do.
- **A rule a script can check is a check, not a line**: it fails `npm run check` or the linter.
- **Skills for repeated procedures.** The first, reading a vendor app, is kept in the maintainer's
  private folder (D52).

## Next

- Check it by starting a fresh session on a past task (the Tanchjim read of its Walkplay-chip
  devices, say) and seeing whether it follows the vendor app without being told.
- A second skill if another procedure repeats: recording a device with the WebHID recorder and
  adding an adapter is the likely one (tools/userscripts/README.md covers it for people).
