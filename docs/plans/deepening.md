# Deepening: four modules that callers were writing for themselves

An architecture review (2026-11-21) of the hot spots of the last 150 commits found four places
where the knowledge of one concept was spread over its callers. This plan lands them in order.
Each step is one commit; none changes the format.

| Step | What | Where | Decisions | Status |
| --- | --- | --- | --- | --- |
| 1 | The device viewed as one EQ, in place of `eq` on every operation | `device-bridge` | D53 (note) | done 2026-11-21 |
| 2 | The write recipe as one engine operation, `plan` | `core`, SPEC §9 and §13 | D12 (note), D56 | done 2026-11-21 |
| 3 | The inspector's read session; the bridge's reading side; shared connect rules to their owners | inspector, `device-bridge`, `client` | D40 (note) | done 2026-11-22 |
| 4 | The editor's edit rules and its starting file, out of the route | inspector | none | next |

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

## 4. The editor's rules (next)

The six form edits that carry a rule (the id and its evidence ref, the band count, the type
order, the preamp mode, the status, a new source), the choice of the file an edit starts from and
which evidence refs count as present move from the edit route into `lib/`, each with a table
test. The plain setters stay in the route.
