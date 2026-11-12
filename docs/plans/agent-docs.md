# Agent docs: one short AGENTS.md of rules

Started 2026-11-01.

## Why

Agents read CLAUDE.md every session and the rest only when sent there. The rules they must follow
are spread over about 50 decisions, SPEC and the plans, and CLAUDE.md mixes them with description.
It also contradicted a rule: it said protocols come from devicePEQ while D39's dated note said
the vendor app comes first, and agents followed CLAUDE.md (the Space II commit, tanchjim.md).

## Shape

- **AGENTS.md** is the one agent file; CLAUDE.md only imports it (`@AGENTS.md`), as in uniPEQ.
  About 60–80 lines of short imperatives:
  - what the repo is (three lines);
  - commands;
  - sources of truth, in order: the vendor's app, recorded device answers, devicePEQ;
  - hard rules (always / never), one line each;
  - where things live, one line per doc.
- **A rule exists for agents only if it is a line in AGENTS.md.** DECISIONS.md stays as the human
  record of why, and is not where an agent looks up what to do.
- **SPEC.md is unchanged**: the public format definition.
- **Skills for repeated procedures**, first "read a vendor app": get at its code, facts only
  (D25), change the handler and data to match, `vendor-app` source, devicePEQ's differences as
  notes. Done three times so far (Walkplay, NICEHCK, Tanchjim), each a little differently.

## Steps

1. List every rule now in CLAUDE.md, DECISIONS.md and the conventions, and mark stale or
   contradicting ones.
2. Write AGENTS.md from the list; move descriptive detail to ARCHITECTURE or CONTRIBUTING.
3. Point CLAUDE.md at it; add the vendor-app skill (now in the maintainer's private folder, D52).
4. Check it by starting a fresh session on a past task (e.g. the Tanchjim TTGK read) and seeing
   whether it follows the vendor app without being told.

## Done (2026-11-01)

- **Rules listed** from CLAUDE.md, DECISIONS, the conventions and the plans. Stale or
  contradicting: the vendor-app rule had no decision of its own (only D39's note on conversions,
  and plans cited "CLAUDE.md" for it); CLAUDE.md still named modernGraphTool as the main consumer
  and the old `eqDeviceInfo` folder; nothing said that data using a new handler option must wait
  for a bridge release, though `main` deploys `/v1/` on every push (tanchjim.md).
- **AGENTS.md** written (commands, sources of truth, always / never, where things live); CLAUDE.md
  is `@AGENTS.md`. Description moved out: what the conventions explained is already in
  ARCHITECTURE §4–§9 and CONTRIBUTING.
- **D50**, the vendor's own app is the reference; D20 points at it, plans cite it.
- **Skill** `read-vendor-app`, from the Walkplay, NICEHCK, Tanchjim and Fosi reads. Moved on
  2026-11-12 from `.claude/skills/` to `../eqcaps_private/.claude/skills/`, beside the notes on
  how each app was read (D52).
- **Found on the way and fixed:** ARCHITECTURE §1 put DAC filters and mic gain out of scope (D49
  brought them in), §9 said the handlers come from devicePEQ, §11's roadmap was a month old; the
  bridge README still described `enableCommand` as working; INSPECTOR §3.5 and §4 left
  `writeControl` out of what the inspector never calls; DECISIONS named D49 as the next number;
  the plans README still said `feat/device-controls`, now merged; SPEC example F mentioned the
  importer; lines past 100 columns rewrapped (SPEC changes are editorial only).

## Next

- Step 4, the fresh-session check.
- A second skill if another procedure repeats: recording a device with the WebHID recorder and
  adding an adapter is the likely one (tools/userscripts/README.md covers it for people).
- Archive nicehck.md once the Octave is recorded or parked.
