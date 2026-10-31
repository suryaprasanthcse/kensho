# kensho

A proposer–verifier gate for prompt-to-3D game content: the model proposes, deterministic code decides, and nothing is loaded that a gate has not passed.

This repository is a monorepo (TypeScript with pnpm workspaces, plus Python placeholders). Only a small slice has code today:

| Package | What it does |
|---|---|
| `@kensho/ir` | IR schema, canonical JSON, domain-prefixed SHA-256 |
| `@kensho/diagnostics` | Diagnostic type and the code registry |
| `@kensho/synthetic_oracle` | Seeded GLB fixtures with known, injected defects |
| `@kensho/gates-asset` | The asset gate (`asset-gate`) |
| `@kensho/bundle` | Signed, content-addressed bundles |
| `@kensho/harness-render` | The render smoke test (`smoke`) |
| `@kensho/cli` | The `kensho` command |
| `@kensho/bench` | The proof runner |

Every other package is a placeholder with a README. All providers other than `synthetic_oracle` are typed stubs that throw `NOT_CONFIGURED`; nothing here calls a network service.

## Use

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm proof
```

The command line is run through a root script, never fetched from a registry:

```bash
pnpm kensho asset-gate path/to/file.glb --tier mobile
pnpm kensho smoke path/to/bundle-dir --tier mobile
```

`pnpm proof` regenerates the fixtures, runs both commands twice over all of them and writes `bench/out/results.json` and `bench/out/RESULTS.md`. Numbers are quoted only from that generated output.

Exit codes for both commands: 0 PASS, 1 FAIL, 2 ABSTAIN, 3 usage. A check that times out, crashes or cannot run yields ABSTAIN, never PASS.

## Licence

Apache License 2.0: see [LICENSE](LICENSE). Every package is still marked `private`, so nothing here can be published to a registry by accident.
