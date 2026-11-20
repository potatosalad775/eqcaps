# @potatosalad775/eqcaps-device-bridge

Reads and writes parametric EQ on audio hardware: FiiO, Walkplay-chipset dongles, Moondrop,
KT Micro, Fosi Audio, Qudelix, Topping, JDS Labs, Nothing, Tanchjim, Edifier, Audeze and others, every
hardware device in the [eqcaps](https://github.com/potatosalad775/eqcaps) database. Protocols
ported from [devicePEQ](https://github.com/jeromeof/devicePEQ), and changed to do what each
vendor's own app does where one is known.

- **No platform types.** Handlers talk to two small transport interfaces (`HidTransport`,
  `StreamTransport`). Browser transports for WebHID, Web Serial and Web Bluetooth are in
  `@potatosalad775/eqcaps-device-bridge/browser`; a native app (an Android Capacitor plugin, say)
  implements the interfaces over its own USB stack.
- **Driven by the database.** The bridge knows how to talk to a device, not what it accepts or
  which device it is. The client matches a connected device to its eqcaps profile; the profile
  says what the device accepts (fit and complete with `@potatosalad775/eqcaps-core` before
  writing) and, in its `protocol`, which handler drives it with which settings.
  `protocolForMatches(matches)` gives the protocol of the most specific match that has one this
  bridge can drive; `protocolOf(profile)` reads one profile's or index entry's. A device added to
  the database on a protocol the bridge already speaks needs no new bridge release.
- **Writes exactly what it is given.** No clamping, padding, type conversion or compensation. A
  value the wire can't carry or a type the protocol has no code for is a `BridgeError`, before
  anything is sent.

```ts
import { createClient } from '@potatosalad775/eqcaps-client';
import { complete, fit } from '@potatosalad775/eqcaps-core';
import {
	guessProtocol,
	identityOf,
	openDevice,
	protocolForMatches
} from '@potatosalad775/eqcaps-device-bridge';
import { requestHidDevice } from '@potatosalad775/eqcaps-device-bridge/browser';

const client = createClient();
const index = await client.loadIndex();
// The browser's chooser, offering the database's devices; null if cancelled.
const transport = await requestHidDevice({ entries: index?.profiles ?? [] });
if (transport) {
	const { best, matches } = await client.matchDevice(identityOf(transport));
	const profile = best ? await client.loadProfile(best.id) : null;
	const protocol =
		protocolForMatches(matches)?.protocol ?? guessProtocol(transport.vendorId);
	if (protocol) {
		const device = openDevice(transport, protocol, profile ? { profile } : {});

		// Read: written values, as the device holds them.
		const state = await device.pull();

		// Write: what the user wants, fitted to the device, every band filled. With the read-back
		// as hints, bands the user left empty keep what the device holds, written flat.
		if (profile) {
			const result = fit(profile, wantedFilters, wantedPreamp);
			const filters = complete(profile, result.slots, { hints: state.filters }).filters;
			const preamp = profile.preamp.mode === 'manual' ? result.preamp : undefined;
			await device.push({ filters, ...(preamp === undefined ? {} : { preamp }) });
		}
	}
}
```

Offline, match against an embedded `bundle.json` with the client's `matchDevice` instead.
Serial ports and BLE devices are chosen first and opened once the protocol is known:
`requestSerialPort()` and `requestBleDevice()` return the device's `identity` and an
`open(protocol)`. A Bluetooth serial port shows only its service class, which several devices
share: ask the user which device it is.

A HID device this site was granted can be opened again without the chooser, by vendor id, product
id and exact product name: `grantedHidDevice(identity)` if it is connected now, null if not. Pass
several identities for a device that comes back as any of them (the Fosi DS3 changes its USB ids
with its USB mode).
`waitForGrantedHidDevice(identity, { timeoutMs })` waits for it, on `navigator.hid`'s `connect`
event or a `getDevices()` poll, and gives null after the timeout; it never shows the chooser,
which needs a click. After a push that returns `reconnect: true` (a `disconnectOnSave` device
restarting to save), pass `ignoreCurrent: true`: the old handle stays listed for a moment and
fails once the device goes. Some devices keep their HID interface through the restart and only
drop the audio one (the Tanchjim FOLA on macOS); `reuseAfterMs` takes the old handle back if it
is still listed by then. `onEvent` reports the browser's connect and disconnect events for the
device, and whether an old handle went or was reused, for telling these cases apart.

`device.capabilities` says what the protocol can do (`canRead`, `canWrite`, `readsPreamp`,
`readsSlot`, `writesPreamp`, `writesSlot`, `needsBandCount`, the filter `types` it has wire codes for, the
`wire` grid it can carry, preset `slots`, `disconnectOnSave`, `experimental`, `readsFirmware`,
`readsEnabled`, and the device `controls` it drives). Where the EQ switch is separate from the
preset (`readsEnabled`), `eqEnabled()` reads it, and `currentSlot()` gives the preset whether the
EQ is on or off. A push with a
`preamp` or `slot` the protocol can't write is refused, not sent without it, and so is a pull of
a `slot` the protocol can't read. Each handler's `codec`
turns a push request into frames and back without a device, for checking what a value becomes on
the wire. `analyzeCodec(protocol)` works out offline what a protocol's writes can carry: the band
counts one write takes, the filter types with wire codes, and each field's wire range and
resolution as an eqcaps domain. That is `handler-code` knowledge (SPEC §10): what a device can be
sent, not what it accepts. `handlerCodeUrl(handler, commit)` is the source `ref` for it.

## Handlers and their options

A profile's `protocol` (eqcaps SPEC §9) names one of these handlers, with the options its device
needs. Byte options may be written as hex strings (`"0x19"`). `protocolProblem(protocol)` says
why a block can't be driven: an unknown handler (data newer than this bridge) or option.

| Handler | Transports | Options |
| --- | --- | --- |
| `fiio-usb-hid` | HID | `reportId` (default 7), `saveCommand` (default `0x19`, the save FiiO Control sends; its `0x21` is factory reset, so no profile sets this) |
| `walkplay-hid` | HID | `defaultSlot` (slot of a write that names none, default 101), `enableCommand` (ignored; no Walkplay device has an EQ switch, and profiles published with it still load), `micGainDone` (default false; true follows a mic gain write with `[1,0x04]`, as NICEHCK's app does), `afterControl` (what follows a control write, by control id: `"done"` is `[1,0x04]`, `"save"` the apply and save of an EQ write; Tanchjim's app sends `done` after volume and `save` after mic gain), `preampWithBands` (default false; true sends the pre-gain right after the bands, before the apply and save, with no `[1,0x04]`, as Tanchjim's app does), `frameDelay` (ms between push frames; default 20 after a band, 50 after the rest) |
| `moondrop-usb-hid` | HID | `bandFrame` (`"biquad"`, the default: 36 bytes with Q2.30 coefficients and the slot; `"compact"`: 14 bytes of freq, q, gain and type; `"wide"`: 34 bytes with the coefficients zero), `commit` (what follows the bands: `"apply"`, the default, one `[1,0x0A,4,0,0,FF,FF]`; `"commit"`, `[1,0x60,0]`; `"none"`, nothing, with the 50 ms wait kept), `customSlot` (the slot a push selects and a `biquad` frame names, default 7), `selectSlot` (default true; false skips the `[1,0x0F,1,slot]` that starts a push), `duckPreamp` (default false; true writes -128 dB as the pre-gain before the bands, and the real one after the commit), `saveOffsets` (default false; true ends a push with `[1,4,0]`), `linkCheck` (default false; true asks `[0x80,0x31,0]` before each part of a push and before a pull or control access, for a dongle with a headset, and refuses with `rejected` when byte 3 is 0), `ledCommand` (the command of the `led` control, default `0x28`; BLUE ROSE uses `0x18`). Every frame sent, read requests included, is zero-padded to the size the HID descriptor declares for report `0x4B` (63 bytes where it declares none), and never truncated, as the app does. |
| `moondrop-old-fashioned-hid` | HID | – (a packet, read requests included, is zero-padded to the descriptor's size for report 75 when that is larger than its 10 bytes) |
| `conexant-usb-hid` | HID | – |
| `ktmicro-usb-hid` | HID | `baseRegister` (default `0x26`), `bandRegisters` (`[{ "freq", "q" }]` per band, for models that skip or reorder registers), `customSlot` (default 3), `freqUnit` (Hz per unit of the frequency field, default 1; 2 where the firmware stores half the frequency), `slotRegister` and `preampRegister` (default true; false leaves the slot register 0x24, which also switches the EQ, or the preamp register 0x66 alone), `frameDelay` (ms between the frames of a push, default 0), `enableRegister` (the register of an EQ switch, 1 on and 0 off, on firmware without slots: a push turns it on first, and the slot register is left alone), `enableLast` (with `enableRegister`, a push writes the 1 after the bands and preamp, just before the commit; Walkplay's app), `writeAck` (byte 6 of the answer to a good write; each write then waits for its answer, and another flag is `rejected`), `writeWait` (ms each write waits for the device's answer to its register, going on whether or not one comes and without reading it; only a timeout is let go, and `writeAck` takes over when set; default none), `bandDelay` (ms after each band's two frames, default 0), `typeFlag` (bits OR-ed into every band's type byte on write and cleared from it on read, default 0; Walkplay's app sets bit 3, so 8), `gainRegister` (the register `globalGain` and `globalGainDb` use, default `0x3b`) |
| `topping-usb-hid` | `volume` and `balance` (dB; the device holds the volume as attenuation in 0.5 dB steps, or 1 dB in its 1 dB step mode, and the balance as signed tenths); `mute`, `input`, `output`, `gain`, `lineMode`, `dacFilter`, `polarity`, `crossfeed`, `brightness` (the device's own numbers). DX5 II only; the other families' settings are not driven. A volume write is refused (`rejected`) while a line output is in DAC mode, as the app sends nothing then. From Topping's web app; tried on a DX5 II |
| `fosi-audio-usb-hid` | HID | `reportId` (default 1), `bandwidth` (default 0), `defaultSlot` (default 7) |
| `qudelix-usb-hid` | HID | –. EQs: the user EQ by default, and `spk`, the speaker (headphone) EQ. For the 5K (firmware 3.0.0 and later; older is `unsupported`) and the T71, as Qudelix's app for Chrome drives them, reading and writing. The framing comes from the vendor id (`0x0a12` or `0x1fc9`) and the descriptor, the model from the device's answer to the opening request (sent once the device has been quiet for 20 ms, answered within 5 s), and the EQ mode from the device: in the 5K's single-EQ mode the default EQ is its 20-band EQ and `spk` is `unsupported`. The speaker EQ is written left and right alike, in the one frame the app sends for both channels, and read from the left channel (`log` says when the right differs); a speaker EQ of 4 or 8 channels (the T71's crossover drivers) is `unsupported`. The T71's 5-channel user EQ is written on every channel. A push waits for the device's echo of each band before the next (a 5K can stop answering after 20 back to back); a device that sends none gets them at once. Slots are the app's preset indexes (0–21 built in, then the EQ's custom presets from 22); a push to a slot saves it with an empty name, the app's default. `bandCount()`, `eqEnabled()`, `currentSlot()` and `firmware()` ask the device. |
| `qudelix-v2-usb-hid` | HID | –. EQs as for `qudelix-usb-hid`. For the 5K Plus, as Qudelix's app for Chrome drives it: messages of elements in fragments, each but the last acknowledged within 1 s; a missing or bad acknowledgement fails the operation and closes the session, which the next operation opens again. In single-EQ mode the default EQ is the 30-band EQ. As in the app, a push requests the stored preset and sets the whole configuration (to switch the EQ on), the attributes (to make it parametric) and, for a pre-gain, the whole preset with only the pre-gain and type changed. |
| `topping-usb-hid` | HID | `family` (`dx1`, the default, `dx5`, `e50`, `dx9d` or `d900`: the DX1 II, DX5 II, E50 II, DX9 Discrete and D900, which share USB id `0x152a:0x8750` and differ in how a session starts, how the config list is asked for and where the firmware, the active config and the EQ switch are read). As Topping's web app drives them, reading and writing. A slot is one of the device's stored configs (3 on the DX1 II and E50 II, 10 on the others), which a push needs to exist already. The pre-gain is computed for every family. The DX5 II and E50 II refuse firmware older than the app's minimum (2.37 and 1.52) as `unsupported`; the D900 does when its capabilities answer is not the one the app requires. Tried on a DX5 II; the other four are unchecked. |
| `jds-labs-usb-serial` | serial | – |
| `nothing-usb-serial` | serial | `customSlot` (default 5) |
| `fiio-usb-serial` | serial | `saveCommand` (default `0x19`) |
| `fiio-f110` | serial, BLE | – |
| `tanchjim-rita-serial` | serial | – |
| `moondrop-edge-serial` | serial | – |
| `edifier-serial` | serial | – |
| `airoha` | serial, BLE | – |

The rest of the block is the same for every handler: `presets` (`[{ "id", "name" }]`, the
device's EQ memories), `disconnectOnSave`, `baudRate` (serial; default 115200 over USB, 9600 over
Bluetooth) and `experimental`. A preset marked `"bypass": true` is the one that turns the EQ off:
`setEnabled(false)` selects it, and reading it back reports no current slot. Only `fiio-usb-hid`
and `ktmicro-usb-hid` turn the EQ off with a preset (KT Micro's default is slot 2, unless its
`enableRegister` is set); the others refuse a `bypass` preset. Presets marked `"writable": true` (format 1.1) are the user memories a
write may target; once any preset is marked, the unmarked ones are built-in curves (SPEC §9). The
bridge passes the mark on in `capabilities.slots` and doesn't enforce it. A new option goes in `src/protocols.ts` (`OPTIONS`) and this table.

## Other EQs

A profile's `protocol.eqs` (format 1.3, SPEC §9.2) lists the device's EQs besides the one the
profile describes: Qudelix's speaker EQ under its user EQ. One connection drives them all, and
each operation says which EQ it is for.

```ts
import { eqProfile } from '@potatosalad775/eqcaps-core';

for (const eq of device.capabilities.eqs) console.log(eq.id, eq.name, eq.bandCount, eq.slots);
const held = await device.pull({ eq: 'spk' });
const spk = eqProfile(profile, 'spk')!; // the profile of that EQ: its band count and presets
const result = fit(spk, wantedFilters, wantedPreamp);
const filters = complete(spk, result.slots, { hints: held.filters }).filters;
await device.push({ filters, eq: 'spk' });
await device.eqEnabled('spk'); // also currentSlot(eq), bandCount(eq), setEnabled(on, slot, eq)
```

Without `eq`, every operation is about the profile's own EQ, as on a device with one.
`capabilities.eqs` holds the listed EQs this bridge's handler drives, each with its own preset
`slots`; one the handler doesn't know is left out, and naming an EQ that isn't there is an
`invalid-request`. The EQs are independent: a push to one leaves the others as they are. A
handler names its EQs in `eqs` and reads the operation's from `ctx.eq`; a new one goes there and
in the table above.

## Device controls

A profile's `protocol.controls` (format 1.2, SPEC §9.1) lists the device's settings besides the EQ:
volume, gain, DAC filter, upsampling, USB mode, sound modes, lights. They are opt-in: `pull`,
`push` and `setEnabled` never touch them.

```ts
const firmware = await device.firmware(); // "1.5.8", or null; read once
const bands = await device.bandCount(); // what the device reports (`readsBandCount`), or null
const values = await device.readControls(); // { uacMode: 0, upsample: 0, gameMode: null, … }
const off = eqDisabledBy(device.capabilities.controls, values); // from eqcaps-core
await device.writeControl('volume', 24); // only when the user changed it
```

`capabilities.controls` holds the profile's controls this bridge drives. `readControls()` gives
null for a control the device doesn't have now: its `firmware` range doesn't hold (unknown firmware
counts as outside it), or the control its `when` names holds another value. `writeControl` refuses
a value the control doesn't take (`invalid-request`) and a control the device doesn't have now
(`unsupported`), then reads the value back (`rejected` if it didn't take). For a control marked
`reconnect` it skips the read-back and returns `{ reconnect: true }`: the device may drop the
connection or come back as another USB device, so match it again. `firmware()` also lets an app
pick between profiles that only the firmware tells apart: match without it, open the device with
the protocol they share, read the firmware, and match again.

Control ids are each handler's vocabulary. `protocolProblem` refuses a control the handler doesn't
drive, or a kind or role this bridge doesn't know; `protocolOf` leaves such a control out (or just
its role), so data newer than the bridge still drives the rest.

| Handler | Controls |
| --- | --- |
| `fosi-audio-usb-hid` | `volume`, `gainMode`, `filterMode`, `gameMode`, `upsample`, `uacMode`, `led` (one byte each, the device's own values) |
| `walkplay-hid` | `dacFilter`, `gainLevel`, `workMode`, `volume` (one byte each); `dre` (toggle, held as 0 on, 1 off; Tanchjim's app); `micGain`, `leftGain`, `rightGain` (dB, on a 1/256 grid). From NICEHCK's and Walkplay's web apps; `firmware()` too |
| `moondrop-usb-hid` | `globalGain` (dB on a 1/256 grid: read with `[0x80,3,0]`, written with `[1,3,2,s16 LE]` and the offset save `[1,4,0]`); then features that are read with `[0x80,cmd,0]` (the value at byte 3) and written with `[1,cmd,1,value]`, 50 ms, and no save: `dacFilter` (`0x11`), `dacMode` (`0x1D`), `led` (`0x28`, or `ledCommand`; 0 or 1), `gainLevel` (`0x26`), `ancMode` (`0x25`), `dualMicEnc` (`0x34`; 0 or 1); `promptTone` (on or off, 0 or 1) and `promptToneVolume`, which are bytes 0 and 1 of the three-byte `0x2B` (on, volume, tone): a write reads the three, changes its own and writes all three back, so the tone is never changed. A value that is not a whole number from 0 to 255 (0 or 1 for the toggles) is `unrepresentable`; the ones a device takes are the profile's. With `linkCheck`, the link is asked about before each read and write. From Moondrop's web app; `firmware()` too |
| `ktmicro-usb-hid` | `globalGain` (the KT0211L's DAC gain register 0x3b as a step), `globalGainDb` (the same register in dB on models that hold it so, minus ten times the dB); both use `gainRegister` in place of 0x3b when it is set (Walkplay's SchemeNo19 holds the dB in 0x57). From Kiwi Ears' web app and Walkplay's Android app |

Errors are `BridgeError`s with a `code`: `unsupported-type`, `unrepresentable`, `unsupported`,
`timeout`, `bad-response`, `rejected`, `transport` or `invalid-request`.

License: MIT; see `NOTICE.md` for the projects it is ported from.
