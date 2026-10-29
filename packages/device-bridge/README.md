# @potatosalad775/eqcaps-device-bridge

Reads and writes parametric EQ on audio hardware: FiiO, Walkplay-chipset dongles, Moondrop,
KT Micro, Fosi Audio, Qudelix, JDS Labs, Nothing, Tanchjim, Edifier, Audeze and others, every
hardware device in the [eqcaps](https://github.com/potatosalad775/eqcaps) database. Protocols from
[devicePEQ](https://github.com/jeromeof/devicePEQ).

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
id and exact product name: `grantedHidDevice(identity)` if it is connected now, null if not.
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
needs. Byte options may be written as hex strings (`"0x21"`). `protocolProblem(protocol)` says
why a block can't be driven: an unknown handler (data newer than this bridge) or option.

| Handler | Transports | Options |
| --- | --- | --- |
| `fiio-usb-hid` | HID | `reportId` (default 7), `saveCommand` (default `0x19`; `0x21` on newer models) |
| `walkplay-hid` | HID | `defaultSlot` (slot of a write that names none, default 101), `enableCommand` (default true; false where `[1,1,0,…]` doesn't turn the EQ off, as on the NICEHCK PureAural) |
| `moondrop-usb-hid` | HID | – |
| `moondrop-old-fashioned-hid` | HID | – |
| `conexant-usb-hid` | HID | – |
| `ktmicro-usb-hid` | HID | `baseRegister` (default `0x26`), `bandRegisters` (`[{ "freq", "q" }]` per band, for models that skip or reorder registers), `customSlot` (default 3), `freqUnit` (Hz per unit of the frequency field, default 1; 2 where the firmware stores half the frequency), `slotRegister` and `preampRegister` (default true; false leaves the slot register 0x24, which also switches the EQ, or the preamp register 0x66 alone), `frameDelay` (ms between the frames of a push, default 0) |
| `fosi-audio-usb-hid` | HID | `reportId` (default 1), `bandwidth` (default 0), `defaultSlot` (default 7) |
| `qudelix-usb-hid` | HID | – (the report comes from the descriptor) |
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
and `ktmicro-usb-hid` turn the EQ off with a preset (KT Micro's default is slot 2); the others
refuse a `bypass` preset. Presets marked `"writable": true` (format 1.1) are the user memories a
write may target; once any preset is marked, the unmarked ones are built-in curves (SPEC §9). The
bridge passes the mark on in `capabilities.slots` and doesn't enforce it. A new option goes in `src/protocols.ts` (`OPTIONS`) and this table.

## Device controls

A profile's `protocol.controls` (format 1.2, SPEC §9.1) lists the device's settings besides the EQ:
volume, gain, DAC filter, upsampling, USB mode, sound modes, lights. They are opt-in: `pull`,
`push` and `setEnabled` never touch them.

```ts
const firmware = await device.firmware(); // "1.5.8", or null; read once
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
| `walkplay-hid` | `dacFilter`, `gainLevel`, `workMode`, `volume` (one byte each); `micGain`, `leftGain`, `rightGain` (dB, on a 1/256 grid). From NICEHCK's web app; `firmware()` too |

Errors are `BridgeError`s with a `code`: `unsupported-type`, `unrepresentable`, `unsupported`,
`timeout`, `bad-response`, `rejected`, `transport` or `invalid-request`.

License: MIT; see `NOTICE.md` for the projects it is ported from.
