## What this changes

<!-- The device(s) or the code, and why. -->

## Evidence

<!--
For data changes: where do the values come from? Link vendor docs, describe the vendor app you
checked, or point at the measurement or read-back file in data/evidence/. The status you set must be
backed by it (CONTRIBUTING.md, SPEC §10).
-->

## Checklist

<!--
Adding or fixing a profile? The easiest way is the inspector's editor
(https://potatosalad775.github.io/eqcaps/edit): it checks the profile as CI will, writes the file
in the repository's format and opens this pull request for you. For a file written by hand,
`npm run format` puts it in that format (one line per object that fits, keys in the usual order).
-->

- [ ] The profile was written with the inspector, or I ran `npm run format` on it
- [ ] `npm run data:validate`, `npm run lint` and `npm test` pass locally
- [ ] Evidence files contain nothing personal (device names people chose, serial numbers, MACs)
- [ ] I agree that my contribution to `data/`, `schema/` and `conformance/` is dedicated to the
      public domain under CC0-1.0, and that my code is licensed under MIT (see CONTRIBUTING.md)
