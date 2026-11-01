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
- **Skills for repeated procedures**, first "read a vendor app": decompile or decode, facts only
  (D25), change the handler and data to match, `vendor-app` source, devicePEQ's differences as
  notes. Done three times so far (Walkplay, NICEHCK, Tanchjim), each a little differently.

## Steps

1. List every rule now in CLAUDE.md, DECISIONS.md and the conventions, and mark stale or
   contradicting ones.
2. Write AGENTS.md from the list; move descriptive detail to ARCHITECTURE or CONTRIBUTING.
3. Point CLAUDE.md at it; add the vendor-app skill under `.claude/skills/`.
4. Check it by starting a fresh session on a past task (e.g. the Tanchjim TTGK read) and seeing
   whether it follows the vendor app without being told.
