# kensho

A proposer–verifier gate for prompt-to-3D game content: the model proposes, and deterministic code decides what passes.

**Start with [`packages/scene-gate`](packages/scene-gate).** It checks model-written game scenes in my own toy format, not any company's DSL. In its study, 49 of 57 schema-valid scenes from Gemini 3.5 Flash-Lite failed at least one of ten checks, and 34 of those failed only the bounds check. One repair round fully fixed 8 of the 49. Method, results and limits are in its [README](packages/scene-gate/README.md) and [RESULTS.md](packages/scene-gate/RESULTS.md).

I wrote the specifications, set the thresholds and ran the experiments; Claude Code wrote the code and tests under my direction, and the commit history says so.

This repository is a monorepo (TypeScript with pnpm workspaces, plus Python placeholders). Only a small slice has code today:

| Package | What it does |
|---|---|
| `@kensho/scene-gate` | Checks for model-written game scenes, with one diagnostic-guided repair round |
| `@kensho/ir` | IR schema, canonical JSON, domain-prefixed SHA-256 |
| `@kensho/diagnostics` | Diagnostic type and the code registry |
| `@kensho/synthetic_oracle` | Seeded GLB fixtures with known, injected defects |
| `@kensho/gates-asset` | The asset gate (`asset-gate`) |
| `@kensho/bundle` | Content-addressed bundles |
| `@kensho/harness-render` | The render smoke test (`smoke`) |
| `@kensho/cli` | The `kensho` command |
| `@kensho/bench` | The proof runner |

Every other package is a placeholder with a README. `library` and `hunyuan3d` are typed stubs that throw `NOT_CONFIGURED`. `hyper3d_rodin` is a real REST client that stays a stub until `HYPER3D_API_KEY` is set, and it has only been exercised against a local mock server.

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

## Secrets

Copy `.env.example` to `.env` and fill in `HYPER3D_API_KEY`. `.env` is ignored by git and must never be committed. Nothing in `pnpm test` or `pnpm proof` reads it or calls a network service.

## Licence

Apache License 2.0: see [LICENSE](LICENSE). Every package is still marked `private`, so nothing here can be published to a registry by accident.
