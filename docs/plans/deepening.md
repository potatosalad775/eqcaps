# Deepening: four modules that callers were writing for themselves

An architecture review (2026-11-21) of the hot spots of the last 150 commits found four places
where the knowledge of one concept was spread over its callers. This plan lands them in order.
Each step is one commit; none changes the format.

| Step | What | Where | Decisions | Status |
| --- | --- | --- | --- | --- |
| 1 | The device viewed as one EQ, in place of `eq` on every operation | `device-bridge` | D53 (note) | done 2026-11-21 |
| 2 | The write recipe as one engine operation, `plan` | `core`, SPEC §9 and §13 | D12 (note), D56 | done 2026-11-21 |
| 3 | The inspector's read session; the bridge's reading side; shared connect rules to their owners | inspector, `device-bridge`, `client` | D40 (note) | done 2026-11-22 |
| 4 | The editor's edit rules and its starting file, out of the route | inspector | none | done 2026-11-22 |
| 5 | The schema's value lists generated; option readers typed and total; the README's tables checked | `core`, `device-bridge`, inspector | D13 (note) | done 2026-11-22 |
| 6 | Capabilities said once: method-backed flags by default, `writesPreamp` from the wire grid | `device-bridge` | none | next |

## 1. The device viewed as one EQ (done)

`openDevice` gives the device viewed as the EQ its profile describes; `device.eq(id)` gives it
viewed as a listed one (SPEC §9.2), over the same connection and queue. `pull`, `push`,
`currentSlot`, `eqEnabled`, `setEnabled`, `slots`, `createSlot`, `renameSlot`, `deleteSlot` and
`bandCount` no longer take an EQ; `capabilities.slots` and `capabilities.perChannel` are the
view's. `capabilities.eqs` is unchanged: the listed EQs, the same from every view (the bridge
can't list the profile's own beside them, since its label is the profile's `engine`). A handler
gives its capabilities per EQ (`capabilities(transport, options, eq)`), which replaces
`perChannelEqs`.

Breaking for the bridge on npm, so the next bridge release is a minor of 0.x that apps must
follow. For uniPEQ (not edited from here):

- `device.pull({ eq })`, `device.push({ ..., eq })`, `createSlot({ eq })` become
  `device.eq(id).pull()`, `.push({ ... })`, `.createSlot()`.
- `currentSlot(eq)`, `eqEnabled(eq)`, `slots(eq)`, `bandCount(eq)`, `deleteSlot(slot, eq)`,
  `setEnabled(on, slot, eq)` and `renameSlot(slot, name, eq)` lose the argument and are called on
  the view.
- `eqView` in `device-eqs.ts` keeps pairing the EQ's profile (`eqProfile`, the band count the
  device reports) with the device, and takes `conn.device.eq(id)` for the device: the rebinding of
  ten methods and the swap of `slots` and `perChannel` go.
- `capabilities.perChannelEqs` is gone; nothing in uniPEQ read it.

## 2. The write recipe as `plan` (done)

`plan(profile, wanted, { writesPreamp, perChannel, held })` in `core` (SPEC §13.10, D56, vectors
in `conformance/v1/plan.json`): `fit`, then `complete` with what the device holds as hints, for
each channel that is written. It returns the write (`filters`, `preamp`, `right`: what the
bridge's `push` takes) and each channel's `fit` result and warnings. The right channel goes out
apart only where the profile says `independent`, the write is `perChannel` and one is wanted; the
preamp only where the write carries one and the mode is `manual` or `unknown` (SPEC §9, rules for
consumers), which is what uniPEQ did and the bridge's README and recipe test didn't.
`recipe.test.ts` now plans and pushes every EQ and channel of every profile, with hints.

For uniPEQ (not edited from here): `planChannel` in `push-plan.ts` becomes a mapping of
`plan(...).channels[i].fit` to its `PlanChange`s; `sendsPreamp`, `drivesChannelsApart` and the
`right` assembly are `plan`'s. Where the EQ on screen is linked and the device drives its channels
apart, `plan` leaves `right` out (the bridge writes both alike) where uniPEQ sent the left twice.

## 3. Connecting (done)

- **The inspector's read session** (`apps/inspector/src/lib/read-session.ts`): the device the
  user chose, its matches, the profile and protocol in use, the open device, the EQ and the read
  are one `ReadSession`, which the connect route shows. It is tested with an index of its own and
  a device that answers from memory. The route keeps the browser's choosers and the markup. A
  read now always asks for the EQ's band count (its profile's, else what the user typed), where
  the route passed it only without a profile and otherwise relied on the count the device was
  opened with, which was stale when a profile loaded after the first read.
- **The reading side** (`openReader`, `DeviceReader` in the bridge): a device with its reads
  only, on every view. The inspector's `lib/device.ts` is gone and it imports no `openDevice`
  (D40, note of 2026-11-22).
- **Rules to their owners**: `protocolFor` in the bridge (the chosen profile's protocol, a
  matched profile's, a vendor guess, and which it was); `ties` and `firmwareDecides` in the
  client's match result; `wireConstraints` in the bridge, which the editor's draft now starts
  from.

Not done here, and still open in `fosi-audio.md`: the inspector reading the firmware and matching
again where `firmwareDecides`. The session is where it goes.

For uniPEQ (not edited from here): `resolve` in `connect.ts` can take `protocolFor`; `topTies`
is `ties`; `readFirmware`'s "is it worth asking" is `firmwareDecides` (tighter: only the top
matches count); `guessedProfile` can start from `wireConstraints`.

## 4. The editor's rules (done)

- **Edits that carry a rule** (`lib/editor-form.ts`, the file in and the file out): the id and
  the evidence that moves with it, the band count (inherited, unbounded or a number), the types
  in the format's order, the preamp mode, the status and its `replacedBy`, and the sources, notes
  and contributors. The eight plain setters (brand, model, group, aliases, engine, extends, a band
  field's domain, the preamp's) stay in the route.
- **How an edit begins** (`lib/editor-start.ts`): which file it starts from (an existing file as
  it is, or citing a handoff; a copy as a draft; a profile for the device read; a blank file),
  where the handoff's evidence is cited, and which evidence the check takes as present. The route
  fetches; the choice is tested.

Two behaviours changed on the way, both in the tests: ticking a type no longer drops a vendor's
own type (`x-…`) the form has no box for, and an edit of the notes, the contributors, the status
or a source on a file whose `meta` was deleted in the JSON puts `meta` back as a draft's, where
it threw. A copy may now be made of a base too.

## 5. Value lists and option readers (done)

- **Value lists.** `scripts/codegen.ts` writes `packages/core/src/types/values.generated.ts`:
  `FILTER_TYPES`, `PREAMP_MODES`, `CONTROL_KINDS`, `CONTROL_ROLES`, `SOURCE_KINDS`, `STATUSES`, each
  from its place in the schema (D13, note of 2026-11-22). The bridge's roles and kinds and the
  editor's lists import them; the editor's source kinds now show in the schema's order.
- **Option readers.** `OPTIONS` in `src/protocols.ts` has a reader for every option of every
  handler, typed to the option: a missing one, or one of another type, doesn't compile. For that,
  what three handlers work out themselves and tell their codec left their options types
  (`QudelixUsbHidCodecOptions`, `QudelixV2UsbHidCodecOptions`, `AirohaCodecOptions`,
  `NothingCodecOptions`). A reader for an option a handler with no options doesn't take still
  compiles.
- **The README's tables** are checked by `protocols.test.ts`: a row per handler naming each of
  its options, and each control a handler drives.

## What is left

- A bridge release (breaking: step 1), then `core` and `client` (additive), before apps take
  them; the owner's, run locally. uniPEQ's follow-up is listed under each step above.
- The inspector reading the firmware and matching again where `firmwareDecides`
  (`fosi-audio.md`).
- Step 6 above.
- Two candidates of the review were withdrawn, with the reasons in D33's note of 2026-11-22: the
  codec saying what each frame is, and a handler's per-device state owned by the bridge device.
  What is left of them needs no step: a step list for KT Micro's and Topping's `push`, and one
  "once per transport" helper for Qudelix and Topping, each when that file is next touched.
