# Preregistration: scene-gate study

**Status: DRAFT. Not frozen.** Nothing below binds anyone until the repository owner reviews it, fills the slots marked `TBD`, changes this line to `FROZEN`, and pushes the commit. Generation starts only after that push.

> I wrote the specification and set the thresholds; Claude Code wrote the code and tests under my direction.

## 1. Questions

1. How often are schema-valid scenes unplayable?
2. How stable are the verdicts across repeated generations of the same prompt?
3. Can one diagnostic-guided repair round fix them?

"Unplayable" means only: the scene is schema-valid and at least one check in `src/checks` reports an error. The checks are my own, on my own format; see the limits in `README.md`. Nothing here claims they measure playability in any real engine.

## 2. Models

Model IDs are exact strings sent to the API. They were read from the Gemini models page, https://ai.google.dev/gemini-api/docs/models, on **2026-11-01**. The page's own footer read "Last updated 2026-10-28 UTC".

| Slot | Model ID | Provider | Status on the page | Notes |
|---|---|---|---|---|
| 1 | `gemini-3.5-flash-lite` | Google, Gemini API | Stable | Proposed. Described as the fastest, most cost-effective 3.5 model. Accepted the Gemini schema profile on 2026-11-01 on both `generateContent` and `/v1beta/interactions` (HTTP 200, reply parses). |
| 2 | `TBD` | `TBD` | `TBD` | Owner decides: Claude Haiku via the Anthropic API (`claude-haiku-5-5`, not yet exercised with the Claude schema profile), or a second current Gemini tier from the list below. |

Other stable Gemini text models on the page that day, for the slot-2 decision: `gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.1-flash-lite`.

Excluded: every 1.5 model (none is on the page), every 2.x model (`gemini-2.0-*` are shut down; `gemini-2.5-*` are available only to earlier users), and every preview or shut-down model.

If a listed model is withdrawn before generation, the slot is re-decided by the owner and this document is re-frozen. It is not swapped silently.

## 3. Inputs, fixed at freeze

| Input | Value |
|---|---|
| Prompts | `prompts/prompts.json`, 20 prompts: 10 ordinary (`ord-01`..`ord-10`), 10 structured (`str-01`..`str-10`) |
| System prompt | `prompts/system.md` |
| Schema | `schema/scene-gate-1.gemini.json` for Gemini, `schema/scene-gate-1.claude.json` for Claude |
| Checks | the ten in `src/check.ts`; the optional `UNREACHABLE_HEIGHT` check is **off**, and `system.md` does not mention it |
| Thresholds | 5 mm overlap, 20 mm support (`src/thresholds.ts`) |
| Commit | `TBD` (the frozen commit hash) |
| SHA-256 of `prompts.json` | `TBD` |
| SHA-256 of `system.md` | `TBD` |

Each tape records the SHA-256 of its prompt text and of `system.md`. `check-tapes --prompts prompts/prompts.json --system prompts/system.md` reports any tape that differs from the frozen files.

## 4. Design

- **20 prompts x 3 runs per model = 60 scene generations per model.** Runs are numbered `sample` 0, 1, 2.
- Each run is an independent request: no earlier output is in its context, and nothing is cached or reused between runs.
- Every run of a model uses identical parameters (section 5). The only thing that differs between the three runs of a prompt is sampling.
- Requests go in a fixed order (prompt id, then sample), one at a time.
- Every response is written to a tape (`src/harness.ts`) before anything is computed from it. All verdicts are recomputed offline from tapes with `check-tapes`.

## 5. Default parameters

These are the proposed values; the owner confirms or edits them before freeze. They are recorded in each tape's `parameters`.

| Parameter | Value | Reason |
|---|---|---|
| Endpoint (Gemini) | `generateContent` (`/v1beta/models/<id>:generateContent`) with `generationConfig.responseMimeType = application/json` and `responseJsonSchema` | Verified 2026-11-01. `/v1beta/interactions` was verified too and is not used. |
| Structured output | the provider's schema profile, as the only output format | Measures what a model writes under the same constraint the schema gives |
| Temperature | provider default, not set | Sampling must vary between the three runs or the flip rate is trivially 0. Recorded value `TBD` after the default is read from the response metadata or docs at freeze |
| Top-p, top-k | provider default, not set | |
| Seed | not set | A fixed seed would make the three runs agree by construction |
| Max output tokens | 8192 | The smoke request used 4096 for an empty room; the larger prompts (ten crates, four rooms) need room. A cut-off output is not retried; it is a `schema_invalid` result with reason `truncated` |
| Thinking / reasoning | provider default | `TBD`: confirm whether thinking tokens count against the output limit for the chosen model |
| System prompt | `prompts/system.md`, sent as the system instruction | |
| User message | the prompt text, verbatim | |

## 6. Procedure

1. Generate 60 scenes per model into tapes of kind `generate`.
2. Re-check every tape offline. Each gets one verdict: `pass`, `fail` or `schema_invalid` (with its reason: `empty`, `refusal`, `truncated`, `unparseable`, `schema`).
3. **Repair round.** For every tape whose verdict is `fail`, send one repair request. It contains the original system prompt and prompt, the scene exactly as generated, and the diagnostics (code, pointer, message, evidence, in the checker's sorted order), and asks for an RFC 6902 patch. The reply is recorded as a tape of kind `repair`, applied with `applyRepair`, and judged by its acceptance rule: the multiset of error codes must strictly shrink, no new code may appear, and no objective may be removed, weakened or retargeted away from a valid target. There is exactly one repair round and one request per failing scene; a refused patch is not retried and the repaired scene is not repaired again.
4. `schema_invalid` and `pass` scenes get no repair request.
5. Compute the metrics in section 7 with `check-tapes` and publish all of them, including the ones that look bad.

**Not yet defined, must be before freeze:** the repair prompt text and the JSON Schema that constrains a patch reply. The repair round cannot run until both exist and are frozen alongside `prompts.json`.

**Transport errors.** A request that fails with a network error, HTTP 429 or HTTP 5xx is repeated unchanged, at most 3 attempts in total, with increasing delays. A response with HTTP 200 is recorded whatever it says, including a refusal or a truncated reply, and is never re-rolled. Any other 4xx (a rejected schema, an invalid key, an unknown model) stops the run: it is a setup error, not a result.

## 7. Metrics

Intervals are Wilson 95% intervals (`src/stats.ts`). No significance tests are run, and models are never pooled.

| Metric | Definition | Reported for |
|---|---|---|
| M1 Unplayable rate | `fail` / (`pass` + `fail`): schema-valid scenes that fail at least one check | each model; and each model by prompt category (ordinary, structured) |
| M2 Schema-invalid rate | `schema_invalid` / all generations, with the count of each reason | each model |
| M3 Flip rate | of (prompt, model) triples with exactly three verdicts, the share whose three verdicts are not all the same. The verdict is compared, not the diagnostic hash | each model |
| M4 Repair acceptance | accepted repairs / failing scenes that were sent for repair | each model |
| M5 Repair success | accepted repairs whose scene then has no error (verdict `pass`) / the same denominator | each model |
| D1 Codes | per check code, the number of scenes that have it | each model, descriptive only |
| D2 Refusals | repair refusals by reason | each model, descriptive only |

Three runs per prompt are too few for any claim about a single prompt. Per-prompt results are listed but not interpreted.

## 8. Stopping rules

- **Fixed sample.** The study is complete when each model has 60 generation tapes and the repair round has run for every failing scene. There is no early stopping, no extension "to firm up" an interval, and no peeking at results to decide whether to continue.
- **Nothing changes after freeze:** prompts, system prompt, schema profiles, parameters, thresholds, checks. A scene is never regenerated because its outcome was disappointing.
- **A checker bug found after freeze** is recorded in a dated changelog below, fixed in a new commit, and every tape is re-checked offline. Both the old and the new results are reported. No tape is regenerated, because the tapes are the evidence and the checks are recomputed from them.
- **A defect in a prompt found after freeze** is recorded, not edited. Its results stay in the totals, and a second table excludes it, labelled as such.
- **Abort** (stop and report, do not retry later with changes) if: the provider rejects the schema (HTTP 400), the key is rejected (401 or 403), or three requests in a row exhaust their transport retries. A run that aborts keeps its tapes and is reported as incomplete.
- **Budget:** `TBD`. The owner states a maximum spend per model; if it would be exceeded the run stops at the last complete prompt.

## 9. Human labels (open)

The checks are mine, so agreement between them and my own idea of "playable" proves nothing. A human-labelled sample is the only test of whether a `pass` or a `fail` means something. Whether to label one, how many scenes, who labels them, and the labelling guide are `TBD`. If it is not done, the results are reported as agreement with these static checks only.

## 10. Changelog

| Date | Change |
|---|---|
| 2026-11-01 | Draft written. Models read from the Gemini models page. No generation has run. |
