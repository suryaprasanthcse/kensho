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
| 1 | `gemini-3.5-flash-lite` | Google, Gemini API | Stable | Described as the fastest, most cost-effective 3.5 model. Accepted the Gemini schema profile on 2026-11-01 on both `generateContent` and `/v1beta/interactions` (HTTP 200, reply parses), and returned an accepted repair for the repair fixture. |
| 2 | `gemini-3.8-flash` | Google, Gemini API | Stable (New) | Decided by the owner. On 2026-11-01 it returned an accepted repair for the repair fixture, with the Gemini schema profile as the reply schema (HTTP 200). The stand-alone schema smoke request on it did not complete: HTTP 503, then two timeouts (60 s and 120 s). That is recorded here, not explained. |

The two models differ in tier (Flash-Lite and Flash) and in price, so results are compared per model and never pooled.

Other stable Gemini text models on the page that day, not used: `gemini-4-argon`, `gemini-3.6-flash`, `gemini-3.1-flash-lite`.

Excluded: every 1.5 model (none is on the page), every 2.x model (`gemini-2.0-*` are shut down; `gemini-2.5-*` are available only to earlier users), and every preview or shut-down model.

If a listed model is withdrawn before generation, the slot is re-decided by the owner and this document is re-frozen. It is not swapped silently.

## 3. Inputs, fixed at freeze

| Input | Value |
|---|---|
| Prompts | `prompts/prompts.json`, 20 prompts: 10 ordinary (`ord-01`..`ord-10`), 10 structured (`str-01`..`str-10`) |
| System prompt | `prompts/system.md`, used for generation and, unchanged, for repair |
| Repair prompt | `prompts/repair.md`, the user message of the repair request |
| Schema | `schema/scene-gate-1.gemini.json`, the reply schema of both generation and repair (both models are Gemini; `schema/scene-gate-1.claude.json` is not used) |
| Checks | the ten in `src/check.ts`; the optional `UNREACHABLE_HEIGHT` check is **off**, and `system.md` does not mention it |
| Thresholds | 5 mm overlap, 20 mm support (`src/thresholds.ts`) |
| Commit | `TBD` (the frozen commit hash) |
| SHA-256 of `prompts.json` | `d63407a796f967b402985665fb77f0f9c096916e147c34ae7ff288a3cedee26f` |
| SHA-256 of `system.md` | `09ff30a17d6e4590df4f1b91eaa224174eb4da94bf871e7e0a1031eb72bf415a` |
| SHA-256 of `repair.md` | `1e9b2f37737e9a7a3a880a114b2a55cff7c4800d1ee46905db59293142a3fd9e` |

Each tape records the SHA-256 of its prompt text and of `system.md`. `check-tapes --prompts prompts/prompts.json --system prompts/system.md` reports any tape that differs from the frozen files. (It does not check `repair.md`; its hash is recorded above.) The three hashes are of the files' bytes as committed (LF line endings), computed on 2026-11-01 over the DRAFT files. A test recomputes them, so any edit to one of the files before freeze fails the suite until the hash here is updated on purpose.

## 4. Design

- **20 prompts x 3 runs per model = 60 scene generations per model.** Runs are numbered `sample` 0, 1, 2.
- Each run is an independent request: no earlier output is in its context, and nothing is cached or reused between runs.
- Every run of a model uses identical parameters (section 5). The only thing that differs between the three runs of a prompt is sampling.
- Requests go in a fixed order (prompt id, then sample), one at a time.
- Every response is written to a tape (`src/harness.ts`) before anything is computed from it. A request that gets no reply is written to a tape too (section 6). All verdicts are recomputed offline from tapes with `check-tapes`.
- A request that already has a tape is never sent again, so a run that is interrupted and restarted continues where it stopped and never regenerates anything.

## 5. Parameters

Every parameter that is not listed as set below is **omitted from the request**, so the provider's default applies. In particular **temperature, top-p, top-k, seed and thinking are all omitted**. Nothing about the sampling is chosen by this study; what the provider did is whatever its default was on the day. A model's default can change without notice, which is a limit of this design, not something it controls.

| Parameter | Value | Reason |
|---|---|---|
| Endpoint | `generateContent` (`/v1beta/models/<id>:generateContent`), `generationConfig.responseMimeType = application/json`, `generationConfig.responseJsonSchema` | Verified 2026-11-01. `/v1beta/interactions` was verified too and is not used. |
| Reply schema | the Gemini profile of the scene schema, for generation and for repair | The same constraint for both rounds |
| Temperature, top-p, top-k | omitted (provider default) | The three runs of a prompt must be able to differ, and no value is chosen here |
| Seed | omitted | A fixed seed would make the three runs agree by construction |
| Thinking | omitted (provider default) | Thinking tokens are billed as output tokens. Per the thinking page, the default is on: `gemini-3.5-flash-lite` at minimal, `gemini-3.8-flash` at medium |
| `maxOutputTokens` | 16384 | The only generation limit that is set. Thinking tokens **count against it**: https://ai.google.dev/gemini-api/docs/thinking, read 2026-11-01 (page "Last updated 2026-10-14 UTC"), says the limit "sets the maximum number of tokens a response can generate, including thought tokens", and that a reply can be cut off or empty if the limit is reached while the model is still thinking. That page documents the parameter as `max_output_tokens` on the Interactions API; the `generateContent` reference text for `maxOutputTokens` could not be read, so the same meaning is assumed for it. The value was doubled from 8192 for this reason. A cut-off reply is not retried; it is `schema_invalid` with reason `truncated` |
| System message | `prompts/system.md` | |
| User message | generation: the prompt text, verbatim. Repair: `prompts/repair.md` rendered (section 6) | |
| Request timeout | 180 s per attempt | The stand-alone schema smoke on `gemini-3.8-flash` timed out at 120 s while its repair smoke finished inside 120 s. A timeout is a transport error and follows the policy in section 6 |

**Usage is logged per tape.** Each tape's `usage` holds the token counts the provider reported (for Gemini `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount`). Usage is never used by a check or a metric, and it is what the spend cap (section 8) is computed from, together with the attempt log (section 6).

## 6. Procedure

1. Generate 60 scenes per model into tapes of kind `generate`.
2. Re-check every tape offline. Each gets one verdict: `pass`, `fail` or `schema_invalid` (with its reason: `empty`, `refusal`, `truncated`, `unparseable`, `schema`).
3. **Repair round.** For every tape whose verdict is `fail`, send one repair request.
   - **System message:** `prompts/system.md`, unchanged.
   - **User message:** `prompts/repair.md` with three parts filled in: the original prompt text; the scene (two-space indented JSON of the scene as generated); and its diagnostics, each as `code`, `pointer`, `message`, `evidence`, in the checker's sorted order. It asks for the corrected full scene, fixing the listed errors without removing objectives, lowering collect counts, or changing objective tags or types.
   - **Reply:** a full scene, under the same schema profile as a generation. It is recorded as a tape of kind `repair`.
   - **Patch:** the RFC 6902 patch from the original scene to the reply is computed in code with fast-json-patch's `compare`. The model never writes a patch.
   - **Acceptance:** the patch goes through `applyRepair` unchanged: the multiset of error codes must strictly shrink, no new code may appear, no objective may be removed, have its tag or type changed, or have its count lowered, and an objective's target may change only if the old one was flagged as unresolved and the new one exists and has the right kind.
   - There is exactly one repair round and one request per failing scene. A refused repair is not retried and the repaired scene is not repaired again. A reply that is not a JSON object is refused as `unparseable_reply`.
   - The number of operations in the computed patch is recorded for every repair (metric M6).
4. `schema_invalid` and `pass` scenes get no repair request.
5. Compute the metrics in section 7 with `check-tapes` and publish all of them, including the ones that look bad.

**Transport policy.** It is implemented in `src/transport.ts` and `src/runner.ts` and pinned by tests that use a fake provider client. There is no real client yet.

- **Timeout:** 180 s per attempt.
- **Retries:** up to 3 retries, so at most 4 attempts, after waits of 2 s, 4 s and 8 s (exponential, no jitter), and **only** after HTTP 429, 500, 502, 503 or 504, a timeout, or a network error. A 2xx reply whose body cannot be read is treated like a network error.
- **Never retried:** any 4xx other than 429, and any reply that arrived. A reply with HTTP 200 is final whatever it says: a refusal, a truncated text and an empty text are results, not failures, and are never re-rolled. A 4xx other than 429 (a rejected schema, an invalid key, an unknown model) is a setup error and stops the run as `rejected`, with no tape.
- **A 5xx that is not on the list** (501, 505 and up) is not retried: the request is recorded as a `transport_failure` after its single attempt.
- **Every attempt is logged on the tape** (`attempts`): its number, start time, duration, the HTTP status or the error class (never the error message), the usage the provider reported, and the cost it counted against the cap.
- **After the retries**, a request with no reply is written as a tape with `outcome: transport_failure`, empty `raw_output` and its attempt log. A transport failure is **reported separately from `SCHEMA_INVALID`** (it is not a statement about the model's scene), **kept in every denominator** (section 7), and **never regenerated**.
- **The 10% rule.** If the transport failures of a model's generations exceed 10% of its 60 planned generations (7 or more), that model stops and is reported **incomplete**. Its tapes are kept, and the other model carries on. On a restart the failures already on tapes still count, so a stopped model stays stopped. Transport failures of repair requests are recorded and counted as repairs that did not succeed, but they do not stop a model.

## 7. Metrics

Intervals are Wilson 95% intervals (`src/stats.ts`). No significance tests are run, and models are never pooled.

| Metric | Definition | Reported for |
|---|---|---|
| M1 Unplayable rate | `fail` / (`pass` + `fail`): schema-valid scenes that fail at least one check. Also reported as `fail` / all 60 generations, so that schema-invalid outputs and transport failures stay visible in the denominator | each model; and each model by prompt category (ordinary, structured) |
| M2 Outcome shares | each of `pass`, `fail`, `schema_invalid` and `transport_failure` / all 60 generations, transport failures included, with the count of each `schema_invalid` reason | each model |
| M3 Flip rate | of (prompt, model) triples with exactly three outcomes, the share whose three outcomes are not all the same. `transport_failure` counts as an outcome, so a triple with one is a flip; the rate over the triples that contain no transport failure is reported beside it. The outcome is compared, not the diagnostic hash | each model |
| M4 Repair acceptance | accepted repairs / failing scenes that were sent for repair. A repair request that ended as a transport failure is in the denominator and is not accepted | each model |
| M5 Repair success | accepted repairs whose scene then has no error (verdict `pass`) / the same denominator | each model |
| M6 Repair size | operations in the patch computed from each repair reply: count, total, median and maximum, over all replies that were JSON objects and over accepted repairs only. A small patch means a local fix; a large one means the model rewrote the scene | each model |
| D1 Codes | per check code, the number of scenes that have it | each model, descriptive only |
| D2 Refusals | repair refusals by reason, `transport_failure` and `unparseable_reply` included | each model, descriptive only |
| D3 Attempts and spend | attempts made, and micro-dollars counted against the cap, by model and in total | each model, descriptive only |

Three runs per prompt are too few for any claim about a single prompt. Per-prompt results are listed but not interpreted.

## 8. Stopping rules

- **Fixed sample.** The study is complete when each model has 60 generation tapes and the repair round has run for every failing scene. There is no early stopping, no extension "to firm up" an interval, and no peeking at results to decide whether to continue.
- **Nothing changes after freeze:** prompts, system prompt, schema profiles, parameters, thresholds, checks. A scene is never regenerated because its outcome was disappointing.
- **A checker bug found after freeze** is recorded in a dated changelog below, fixed in a new commit, and every tape is re-checked offline. Both the old and the new results are reported. No tape is regenerated, because the tapes are the evidence and the checks are recomputed from them.
- **A defect in a prompt found after freeze** is recorded, not edited. Its results stay in the totals, and a second table excludes it, labelled as such.
- **Abort** (stop and report, do not retry later with changes) if a request is rejected with a 4xx other than 429 (a rejected schema is HTTP 400, a rejected key 401 or 403), or if a model's transport failures pass 10% of its generations (section 6). A run that aborts keeps its tapes and is reported as incomplete.
- **Spend cap: $10, a hard stop.** The cap covers every study request of both models, generation and repair, **every attempt counted**: retries and failed attempts included. Prices are from https://ai.google.dev/gemini-api/docs/pricing (page "Last updated 2026-10-30 UTC", read 2026-11-01), per 1M tokens, output including thinking tokens:

  | Model | Input | Output |
  |---|---|---|
  | `gemini-3.5-flash-lite` | $0.30 | $2.50 |
  | `gemini-3.8-flash` | $0.75 through 2026-12-31, then $1.50 | $3.75 through 2026-12-31, then $7.50 |

  An attempt that reported usage counts what its usage costs (prompt tokens at the input price, candidate plus thinking tokens at the output price). An attempt that got no reply or reported no usage (a 503, a timeout, a network error) counts at the worst case, because the provider may still have done the work. The worst case of one attempt is 6,000 input tokens and 16,384 output tokens (the most a reply may be, thinking included) at the model's price on the day: $0.04276 for `gemini-3.5-flash-lite` and $0.06594 for `gemini-3.8-flash`. Before each attempt, retries included, the runner adds that worst case to the spend so far and does not send the attempt if the sum would reach $10. A stop is final: the run is reported as incomplete with the tapes it has (attempts already made stay on a tape), and no further money is spent to finish it.

  If every request were one attempt and every reply ran to the limit, the theoretical maximum for the whole study (120 requests per model: 60 generations and at most 60 repairs) would be $5.13 for `gemini-3.5-flash-lite` and $7.91 for `gemini-3.8-flash`, **$13.04 together, which is over the cap**. Real replies are far shorter than the limit, so the cap is expected not to bind, but it is the cap and not the arithmetic that bounds the study: because every attempt is checked against the worst case, the runner stops once the spend so far is within one worst-case attempt of $10. Each failed attempt is counted at the worst case, so many retries use the cap faster still. After 2027-01-01 the `gemini-3.8-flash` price doubles and the theoretical maximum rises to $20.96; the study should run before then. The smoke checks are outside the study and outside the cap; their cost is a few requests. The accounting is in `src/spend.ts` and `src/transport.ts` and is tested offline; no provider client exists yet.

## 9. Limits stated in advance

- **No human labelling.** No human-labelled sample is made. The checks are mine, so agreement between them and my own idea of "playable" proves nothing, and only a human-labelled sample could test whether a `pass` or a `fail` means anything. Every result is therefore a statement about these static checks on boxes, not about whether a scene can be played.
- The format is my own toy format, not a real game DSL; scenes are boxes, with no physics and no navmesh.
- Sampling and thinking are the providers' defaults, which neither I nor this study controls.
- Three runs per prompt cannot support a claim about a single prompt.
- A `transport_failure` says nothing about a model's scenes. It is kept in the denominators so that a model that fails often does not look better for it, and it is reported apart so that it is not mistaken for a schema failure.

## 10. Changelog

| Date | Change |
|---|---|
| 2026-11-01 | Draft written. Models read from the Gemini models page. No generation has run. |
| 2026-11-01 | Owner decisions: slot 2 is `gemini-3.8-flash`; temperature and thinking are the provider default; spend cap $10, hard stop; no human labelling. Repair redesigned: the model returns a full corrected scene and the patch is computed with `compare`; `prompts/repair.md` added; M6 added; usage logged per tape. Smoke checks run against the live endpoint (results in section 2). |
| 2026-11-01 | Owner decisions: timeout 180 s; up to 3 retries with exponential backoff on 503, 429, timeout and network errors only; never retry a 4xx or a reply that arrived; every attempt logged on the tape and counted toward the $10 cap; `transport_failure` reported apart from `SCHEMA_INVALID`, kept in the denominator and never regenerated; a model whose transport failures pass 10% of its 60 generations stops and is reported incomplete. `repair.md` gained the rule about changing an objective's target. SHA-256 of `prompts.json`, `system.md` and `repair.md` recorded. |
