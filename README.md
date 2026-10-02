# eqcaps

A vendor-neutral database of **EQ constraint profiles**: what an EQ engine (a hardware DSP or a
software EQ) actually accepts. Band count, filter types per slot, frequency/Q/gain domains with
quantization, conditional domains, cross-band rules, preamp, device identity and provenance.

> **Status: early development.** The format is a draft and not frozen. Nothing is published yet.

## What's here

| Path | Contents |
| --- | --- |
| [`docs/SPEC-DRAFT.md`](docs/SPEC-DRAFT.md) | The format definition (v1 draft) and engine semantics |
| [`docs/PLAN.md`](docs/PLAN.md) | Goals, architecture and roadmap |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every design decision, with rationale |
| [`schema/v1/`](schema/v1/) | JSON Schema for published profiles and authoring files |
| [`conformance/v1/`](conformance/v1/) | Fixtures and vectors any implementation can test against |
| [`packages/core`](packages/core/) | Types, semantic validator and (soon) the reference engine. Zero dependencies. |
| [`packages/client`](packages/client/) | Fetching, caching and device matching (Phase 3) |
| [`packages/build`](packages/build/) | Validation pipeline and data build used by CI |

## Development

Requires Node 22.18 or later.

```sh
npm install
npm run lint      # Prettier + ESLint
npm run check     # generated files up to date + typecheck
npm test
npm run build
npm run codegen   # after editing schema/v1/profile.schema.json
```

## License

Code (`packages/`, `apps/`, `scripts/`) is [MIT](LICENSE). Data, schema, conformance files and
everything published as JSON are dedicated to the public domain under [CC0 1.0](LICENSE-DATA).
Contributions are accepted under the same terms. See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the projects this one builds on.
