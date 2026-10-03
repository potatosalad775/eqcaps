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

		// Write: what the user wants, fitted to the device, every band filled.
		if (profile) {
			const result = fit(profile, wantedFilters, wantedPreamp);
			const filters = complete(profile, result.slots).filters;
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

`device.capabilities` says what the protocol can do (`canRead`, `canWrite`, `readsPreamp`,
`readsSlot`, `writesPreamp`, `writesSlot`, `needsBandCount`, the filter `types` it has wire codes for, the
`wire` grid it can carry, preset `slots`, `disconnectOnSave`, `experimental`). A push with a
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
| `walkplay-hid` | HID | `defaultSlot` (slot of a write that names none, default 101) |
| `moondrop-usb-hid` | HID | – |
| `moondrop-old-fashioned-hid` | HID | – |
| `conexant-usb-hid` | HID | – |
| `ktmicro-usb-hid` | HID | `baseRegister` (default `0x26`), `bandRegisters` (`[{ "freq", "q" }]` per band, for models that skip or reorder registers), `customSlot` (default 3) |
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
refuse a `bypass` preset. A new option goes in `src/protocols.ts` (`OPTIONS`) and this table.

Errors are `BridgeError`s with a `code`: `unsupported-type`, `unrepresentable`, `unsupported`,
`timeout`, `bad-response`, `rejected`, `transport` or `invalid-request`.

License: MIT; see `NOTICE.md` for the projects it is ported from.
