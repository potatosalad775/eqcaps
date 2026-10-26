# eqcaps

**What can this EQ actually do?** eqcaps is an open database that answers that question for
hardware DSPs (USB dongles, DACs, headphones) and software equalizers, in one vendor-neutral
format any EQ app can read.

A parametric EQ preset made for one device often can't be sent to another as it is. One device
has 8 bands and another 10, shelves may only be allowed in some slots, gain may stop at ±10 dB, Q
may move in coarse steps, or the frequencies may come from a fixed list. eqcaps records those
limits per device, with where each one came from. It also ships an engine that fits any preset
into them.

- **Browse the database and check your device:** [potatosalad775.github.io/eqcaps](https://potatosalad775.github.io/eqcaps/)
- **An app built on it:** [uniPEQ](https://unipeq.com) ([source](https://github.com/potatosalad775/uniPEQ)),
  a parametric EQ for USB audio hardware, on the web and Android
- **Data:** `https://potatosalad775.github.io/eqcaps/v1/` (static JSON, CORS-enabled, CC0)

## What a profile looks like

```jsonc
{
  "id": "jds-labs-element-iv",
  "kind": "hardware",
  "device": { "brand": "JDS Labs", "model": "Element IV" },
  "match": { "usb": [{ "vendorId": "0x152a", "productId": "0x88fa" }] },
  "bandCount": 12,
  "band": {                                      // every slot, unless overridden below
    "types": ["PK"],
    "freq": { "min": 20, "max": 20000 },
    "q": { "min": 0.1, "max": 10 },
    "gain": { "min": -12, "max": 12 }
  },
  "bands": [
    { "index": [0, 1], "types": ["LSC"] },       // the first two slots: low shelves only
    { "index": [10, 11], "types": ["HSC"] }      // the last two: high shelves only
  ],
  "meta": { "status": "draft", "sources": [ … ] }
}
```

Domains can also be stepped (`{ "min": -12, "max": 12, "step": 0.5 }`), a fixed list
(`{ "values": [31, 62, 125, …] }`) or depend on other fields (a frequency window that narrows at
high gain). Profiles can also carry cross-band rules and the preamp. Units are always Hz, dB and
RBJ-cookbook Q. The full format is in [docs/SPEC.md](docs/SPEC.md).

## Use it in your app

```sh
npm install @potatosalad775/eqcaps-client @potatosalad775/eqcaps-core
```

```ts
import { createClient } from '@potatosalad775/eqcaps-client';
import { complete, fit, validateList } from '@potatosalad775/eqcaps-core';

const client = createClient();
const { best } = await client.matchDevice({ usb: { vendorId, productId, productName } });
const profile = best && (await client.loadProfile(best.id));

if (profile) {
	validateList(profile, filters); // while editing: flag what the device won't take
	const { slots } = fit(profile, filters, preamp); // before writing: the closest valid preset
	const written = complete(profile, slots).filters; // every band filled, ready to send
}
```

The client never throws into your app. Offline or on any error you get no profile, and your app
carries on without constraints. You can embed `bundle.json` from a
[release](https://github.com/potatosalad775/eqcaps/releases) as an offline snapshot.

| Package | What it does |
| --- | --- |
| [`@potatosalad775/eqcaps-core`](packages/core/) | Types, profile validator and the engine (`validate`, `fit`, `complete`, …). Zero dependencies. |
| [`@potatosalad775/eqcaps-client`](packages/client/) | Fetching, caching and matching a connected device to its profile. |
| [`@potatosalad775/eqcaps-device-bridge`](packages/device-bridge/) | Reads and writes EQ on the database's hardware over USB HID, serial and Bluetooth. Driven by the profiles, with no browser types in its handlers. |

Not on TypeScript? The data is plain JSON with a JSON Schema, and `conformance/v1/` holds test
vectors for porting the engine.

## Contribute

Most profiles were seeded from existing open-source tools and are still marked `draft`. Checking
one against a real device is the most useful thing you can do:

1. Open the [inspector](https://potatosalad775.github.io/eqcaps/), connect your device (Chrome or
   Edge), and see how it compares with its profile.
2. Run a **guided read**: you change the EQ in the vendor's own app, and the inspector records
   what it allows. The inspector only reads; it never writes to your device.
3. Edit the profile and submit it. The inspector opens the pull request on GitHub for you.

Or write the JSON by hand. [CONTRIBUTING.md](CONTRIBUTING.md) covers both, plus development
setup.

## Documentation

| | |
| --- | --- |
| [docs/SPEC.md](docs/SPEC.md) | The format (v1) and the engine's semantics |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the parts fit together, data flow, roadmap |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why things are the way they are |
| [docs/INSPECTOR.md](docs/INSPECTOR.md) | The inspector: tiers, guided reads, safety, privacy |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Adding devices, evidence, development |

## License

Code (`packages/`, `apps/`, `scripts/`) is [MIT](LICENSE). Data, schema, conformance files and
everything published as JSON are dedicated to the public domain under [CC0 1.0](LICENSE-DATA), so
any app can embed them. Built on [devicePEQ](https://github.com/jeromeof/devicePEQ),
modernGraphTool and AutoEQ: see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
