# @kensho/scene-gate

A deterministic checker for model-written game scenes in a small toy format, `scene-gate/1`. The format is mine, not any company's DSL. The checker answers three questions about a set of generated scenes:

1. How often are schema-valid scenes unplayable?
2. How stable are the verdicts across repeated generations?
3. Can one diagnostic-guided repair round fix them?

Every failure is a typed diagnostic `{ code, severity, pointer, message, evidence }`, where `pointer` is an RFC 6901 JSON Pointer into the scene. Diagnostics are sorted by pointer, then by code. The checks use integer millimetres only, and no clock, randomness or network.

> I wrote the specification and set the thresholds; Claude Code wrote the code and tests under my direction.

## The format

Integer millimetres, Y up. A solid ground plane at y = 0 is implicit. `pos_mm` is the centre of a box and `box_mm` its full size. `bounds_mm` is `[minx, miny, minz, maxx, maxy, maxz]`.

| Field | Meaning |
|---|---|
| `scene` | `"scene-gate/1"` |
| `bounds_mm` | the playable volume |
| `controller` | `{height_mm, radius_mm, jump_height_mm}`; the player box is `2r x height x 2r` |
| `spawn` | `{pos_mm}`, the player's feet |
| `entities[]` | `id`, `kind`, `box_mm`, `pos_mm`, optional `tags[]` |
| `rules[]` | `id`, `on`, `emit`; events are `collect:<id>`, `enter:<id>`, `open:<id>`, `signal:<name>` |
| `objectives[]` | `id`, `type`: `collect {tag, count}`, `reach {target}` or `unlock {target}` |

Entity kinds: `static`, `dynamic`, `door` (solid), `pickup`, `key` (not solid). A door has `requires` (a key id) and optional `guards[]` (ids behind the door).

The zod schema is `src/schema.ts`. The JSON Schema exports are in `schema/`: `scene-gate-1.json` is the reference, and `scene-gate-1.claude.json` and `scene-gate-1.gemini.json` drop the keywords those providers' structured outputs reject (see DECISIONS.md). A test fails if a committed file drifts from the schema. Regenerate them with `pnpm --filter @kensho/scene-gate schema`.

## The codes

Thresholds: 5 mm overlap tolerance, 20 mm support tolerance (`src/thresholds.ts`, pinned by a test).

| Code | Fails when | Pointer |
|---|---|---|
| `DUPLICATE_ID` | two entities, rules or objectives share an id | the later id |
| `UNRESOLVED_REF` | a rule event, a door's `requires`/`guards`, or an objective target names a missing id or an entity of the wrong kind | the reference |
| `OBJECTIVE_COUNT` | a collect objective needs more entities with its tag than exist | `/objectives/i/count` |
| `RULE_CYCLE` | the `on` -> `emit` event graph has a cycle | the rule closing the cycle |
| `PROGRESSION_CYCLE` | a key sits behind its own door, directly or via other doors | the door's `requires` |
| `SPATIAL_OVERLAP` | two solids overlap by more than 5 mm on every axis; a door may overlap statics | the later entity's `pos_mm` |
| `SPAWN_OBSTRUCTED` | the player box at spawn overlaps a solid by more than 5 mm | `/spawn/pos_mm` |
| `UNSUPPORTED_DYNAMIC` | a dynamic box's bottom is more than 20 mm above the highest support under it | its `pos_mm` |
| `OUT_OF_BOUNDS` | any box, or the player box at spawn, extends outside `bounds_mm` | its `pos_mm` |
| `UNREACHABLE_HEIGHT` | optional, off by default: a needed item is out of jump reach | its `pos_mm` |

Output that cannot be parsed, is truncated, is a refusal, or does not match the schema is `schema_invalid`. It is reported as its own verdict, with `SCHEMA_INVALID` diagnostics and a reason (`empty`, `refusal`, `truncated`, `unparseable`, `schema`), and never mixed into the semantic codes. A verdict is `pass`, `fail` (any error diagnostic) or `schema_invalid`, and carries a SHA-256 over the canonical JSON (sorted keys) of the diagnostics.

Where the specification was ambiguous I took the stricter reading and recorded it in [DECISIONS.md](DECISIONS.md).

## Repair

In the study a repair reply is a full corrected scene, and `repairFromScene(scene, reply)` computes the patch with `compare` and returns it with its operation count. `applyRepair(scene, patch)` applies an RFC 6902 patch to a copy of the scene and accepts it only if the multiset of error codes strictly shrinks and no new code appears. It refuses a patch that removes an objective or lowers a collect count, and one that changes an objective's tag or type. A reach or unlock objective may be retargeted to an existing entity of the right kind. It returns the accepted scene with before and after diagnostics, or a refusal with a reason.

## Running it

From the repository root:

```bash
pnpm --filter @kensho/scene-gate test
```

```bash
pnpm --filter @kensho/scene-gate mutation
```

```bash
pnpm --filter @kensho/scene-gate schema
```

```bash
pnpm --filter @kensho/scene-gate check-tapes <tapes-dir>
```

`scripts/smoke-schema.ts` (`pnpm --filter @kensho/scene-gate smoke-schema`) is a one-off check that each provider accepts its schema profile. It sends one request per provider, reading `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` from the repository `.env`, and prints only the HTTP status and whether the reply parses. It is not part of the study, writes no tapes, and has only been tested offline with an injected `fetch`.

`scripts/smoke-repair.ts` (`pnpm --filter @kensho/scene-gate smoke-repair <model>...`) sends one repair request per model for a fixture scene with a known error, built the way the study builds it, and prints one status line per model.

The mutation check disables each check in turn (its module is aliased to a no-op) and asserts the suite then fails. It exits non-zero if any check survives.

`check-tapes` re-checks recorded tapes offline and prints a JSON report: per-model verdict counts, the unplayable rate and flip rate with Wilson 95% intervals, repair outcomes, and any tape that failed to read. Add `--unreachable-height` to enable the optional check, and `--prompts prompts/prompts.json --system prompts/system.md` to flag tapes whose prompt or system hash differs from the frozen files.

In code:

```ts
import { evaluateRaw, verdictRecord } from '@kensho/scene-gate';

const record = verdictRecord(evaluateRaw(modelText)); // { verdict, hash, codes }
```

## Tapes and prompts

A tape (`src/harness.ts`) records one model call: model id, parameters, prompt hash, system hash, raw output, finish reason, token usage and timestamp. Tapes live at `<root>/<model>/<prompt_id>/<sample>.<kind>.json`, are written once and never overwritten, and everything else is derived from them. A `repair` tape holds the model's corrected full scene for the `generate` tape with the same model, prompt and sample; the patch is computed from it with `compare`.

`prompts/prompts.json` (20 prompts: 10 ordinary, 10 structured, none adversarial), `prompts/system.md` and `prompts/repair.md` (the user message of the repair request) are the study's inputs. They carry no status marker, because the last two are sent to the model; whether they are draft or frozen is recorded only in `PREREGISTRATION.md`, together with their SHA-256.

No API client exists. `ProviderClient` in `src/harness.ts` is the marked interface where one goes later. `src/transport.ts` (timeout, retries, backoff, attempt log), `src/spend.ts` (the $10 ledger) and `src/runner.ts` (the generation and repair loops, with the 10% transport-failure stop) drive it, with the client, the clock and `sleep` injected, and are tested offline with a fake client.

## Limits

- It is my own format, not a real game DSL. A pass says nothing about any engine.
- Boxes, not meshes. Everything is an axis-aligned box.
- No physics and no navmesh. "Playable" here means "passes these static checks"; nothing simulates the player, so a scene can pass and still be unwinnable (a wall between the spawn and a coin is not detected), or fail a check and still be playable.
- I wrote the checks and set the thresholds, so agreement between them and my own idea of "playable" proves nothing. Only a human-labelled sample of scenes can test whether the checks track real playability.
- Flip rate compares verdicts, not diagnostic hashes, and is computed over triples (three generations per prompt and model).
