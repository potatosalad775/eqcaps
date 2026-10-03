# eqcaps

A vendor-neutral database of **EQ constraint profiles**: what an EQ engine (a hardware DSP or a
software EQ) actually accepts. Band count, filter types per slot, frequency/Q/gain domains with
quantization, conditional domains, cross-band rules, preamp, device identity and provenance.

> **Status:** format v1 is frozen (2026-10-03) and published under `/v1/`. Most profiles are
> seeded drafts; checking them against real devices is the most useful contribution.

## What's here

| Path | Contents |
| --- | --- |
| [`docs/SPEC.md`](docs/SPEC.md) | The format definition (v1) and engine semantics |
| [`docs/PLAN.md`](docs/PLAN.md) | Goals, architecture and roadmap |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every design decision, with rationale |
| [`schema/v1/`](schema/v1/) | JSON Schema for published profiles and authoring files |
| [`conformance/v1/`](conformance/v1/) | Fixtures and vectors any implementation can test against |
| [`packages/core`](packages/core/) | Types, semantic validator and the reference engine. Zero dependencies. |
| [`packages/client`](packages/client/) | Fetching, caching and device matching. Never throws into the host app. |
| [`packages/device-bridge`](packages/device-bridge/) | Reads and writes EQ on every hardware device in the database over HID, serial and Bluetooth, behind transport interfaces with no browser types. |
| [`data/`](data/) | The profiles (`profiles/<brand>/<id>.json`) and shared bases. See [CONTRIBUTING.md](CONTRIBUTING.md). |
| [`packages/build`](packages/build/) | Validation pipeline and data build used by CI |
| [`apps/inspector`](apps/inspector/) | The web app at [potatosalad775.github.io/eqcaps](https://potatosalad775.github.io/eqcaps/): browse profiles, try the engine on your filters, read a connected device and check it against its profile, edit a profile and submit it as a pull request |

## Development

Requires Node 22.18 or later.

```sh
npm install
npm run lint      # Prettier + ESLint
npm run check     # generated files and conformance vectors up to date + typecheck
npm test
npm run build
npm run codegen   # after editing schema/v1/profile.schema.json
npm run conformance  # after changing engine behaviour or scripts/conformance.ts
npm run data:validate  # check data/ as CI does
npm run data:build     # publish /v1/ into dist/site/
npm run inspector:dev  # the inspector, reading the local dist/site/v1/ and data/
npm run release -- 0.2.0-rc.1 --pack  # package tarballs in dist/pack/, to try in another app
```

`@potatosalad775/eqcaps-core` and `@potatosalad775/eqcaps-client` are on npm; the device bridge
will be `@potatosalad775/eqcaps-device-bridge` from the next release.

## License

Code (`packages/`, `apps/`, `scripts/`) is [MIT](LICENSE). Data, schema, conformance files and
everything published as JSON are dedicated to the public domain under [CC0 1.0](LICENSE-DATA).
Contributions are accepted under the same terms. See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the projects this one builds on.
