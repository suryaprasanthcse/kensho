# Amendment 1 (draft): finish the `gemini-3.8-flash` generations

**Status: DRAFT. Not frozen. Not run.** Nothing in this document applies, and nothing in it has been done, until the repository owner has reviewed it, filled the slots marked `OPEN`, changed this line to `FROZEN`, and pushed the commit that carries the tag `scene-gate-amendment-1`. A commit cannot contain its own hash, so the tag names it.

This amends `PREREGISTRATION.md` (frozen at the tag `scene-gate-prereg-v2`) in one respect only: **how a request that gets no reply is handled, for one model, for the generations and the repair round that do not yet exist.** It changes no prompt, no check, no model, no parameter and no metric.

> I wrote the specification and set the thresholds; Claude Code wrote the code and tests under my direction.

## 1. What happened, from the tapes

The study ran once from the frozen commit `f34a06c` and is recorded in `RESULTS.md`. `gemini-3.8-flash` was stopped by the pre-registered 10% rule:

| | |
|---|---|
| Generation tapes for `gemini-3.8-flash` | 23 of 60 |
| of which replies | 16 (all `pass`) |
| of which `transport_failure` | 7: `ord-06` samples 1, 2; `ord-07` samples 0, 1, 2; `ord-08` samples 0, 1 |
| Generations that do not exist | 37: `ord-08` sample 2, `ord-09`, `ord-10`, `str-01` to `str-10` (3 samples each) |
| Repair round for `gemini-3.8-flash` | not run |

**Every one of the 28 failed attempts was HTTP 429**, answered in under a second (0.3 to 0.9 s). They began with the 17th request, after 16 successes, each of which had taken 50 to 143 s (median about 81 s). The seven failed requests spent all four attempts each in about 112 seconds in total (waits of 2 s, 4 s, 8 s), then the rule stopped the model. There were no 503s and no timeouts for this model.

`gemini-3.5-flash-lite` was served at about 15 requests a minute and also met 429s (25 attempts in all, 15 of them in its four `transport_failure` tapes: three generations and one repair), and recovered from most of them by retrying.

**What this does and does not show.** A 429 is a refusal to serve a request because of a limit. The study never reads an error body, so the tapes do not say which limit: a per-minute rate, a per-minute token budget, or a daily request quota on this project (section 4 records that the provider applies limits per project, not per key). `gemini-3.8-flash` was asked for only about one request every 80 s during the run, which is slow, so a per-minute rate limit looks unlikely. A quota that counts requests per day is consistent with the timing: this model had also been called earlier the same day by the smoke and end-to-end checks, and the 429s began after 16 study requests. **That is a hypothesis, not a finding.** If it is a daily quota, no pacing and no backoff of minutes will help; the run would have to wait for the quota to reset, or for the project's tier to change. Section 4 settles this before anything is frozen.

## 2. What does not change

- The model id `gemini-3.8-flash`, and `maxOutputTokens` 16384, with temperature, top-p, top-k, seed and thinking omitted.
- `prompts/prompts.json`, `prompts/system.md`, `prompts/repair.md`: the three SHA-256 recorded in `PREREGISTRATION.md` section 3 (`d63407a7…`, `09ff30a1…`, `1e9b2f37…`), checked before the run as they were before.
- The scene schema (Gemini profile), the ten checks and their thresholds, the repair design and its acceptance rule, the metrics M1 to M6 and D1 to D3.
- 20 prompts x 3 samples per model; the same prompt text, in the same file order.
- **Existing tapes are untouched.** All 132 tapes, those of `gemini-3.5-flash-lite` and the 23 of `gemini-3.8-flash` (the 7 `transport_failure` tapes among them), stay exactly as they are and are never regenerated, edited or deleted. The 7 failed pairs are not retried: they remain failures in every denominator. The amended run writes only the 37 missing generations and the repairs for `gemini-3.8-flash`, and **it cannot write to any other model's directory**.
- The spend cap is the same $10 for the whole study. The $3.4802 already counted (recorded in the tapes) is part of it; the run starts from that figure.

## 3. What changes: transport only

Everything below applies to `gemini-3.8-flash` requests made under this amendment, and to nothing else.

| | Under `prereg-v2` | Under this amendment |
|---|---|---|
| Waits before retries 1, 2, 3 | 2 s, 4 s, 8 s | 30 s, 90 s, 270 s (`OPEN`) |
| Retries, and what is retried | up to 3, on 429, 500, 502, 503, 504, timeout, network error | unchanged |
| A `Retry-After` header on a reply | ignored | if present and longer than the scheduled wait, wait that long instead, up to 15 minutes (`OPEN`). Only the header is read, never the body |
| Pacing | none beyond the 1-at-a-time order | at least 10 s from the start of one request to the start of the next (`OPEN`). Normal replies already take 50 to 140 s, so this only changes how fast a run of refusals is retried |
| The 10% stop | more than 10% of the 60 planned generations of a model | more than 10% of the **37** generations requested under this amendment, that is 4 or more `transport_failure`, ends the amended run. The 7 earlier failures are not counted toward this stop (otherwise the amended run would stop on its first request) and **are** counted in every result |
| Repair round | none for a stopped model | one repair request for every failing `gemini-3.8-flash` scene (those from the 16 existing and those from the new ones), as in the preregistration; no stop rule, as before |

### If the amended run stops

If the run stops under the stop rule in the table (4 or more `transport_failure` among the 37 requested generations), it ends there. The pairs not yet requested are reported as **not run**, listed by prompt and sample. As in the preregistration, a model stopped by the rule gets no repair round, so no repair is run for it either, and any failing scene among the generations that did complete stays unrepaired and is reported so. **There is no second attempt under this amendment**: no rerun of the stopped pairs, no restart of the command to continue them, and no change of waits, pacing or stop rule. Anything further needs a new amendment document, written after the stop is reported. The same holds for a stop by the spend cap and for a rejected request (a 4xx other than 429), which end the run as they do in the preregistration. A run that is only interrupted (the process is killed, the machine is switched off) has not stopped under a rule, and is started again with the same command; a request that already has a tape is skipped.

### The spend cap and this run

The cap and its pricing are not changed: every attempt counts, and an attempt with no usage (a 429 included) is counted at the worst case of $0.06594 for `gemini-3.8-flash` (6,000 input and 16,384 output tokens). 429s are not counted cheaper.

The arithmetic, from the 132 tapes (the counted spend is $3.480246, which `check-tapes` reports as 3,480,246 micro-dollars):

| | |
|---|---|
| Remaining under the $10 cap | $10 − $3.480246 = **$6.519754** |
| 74 replies, each at the worst case, no failed attempt | 74 × $0.06594 = $4.8796; **$1.6402 to spare** |
| 74 replies at the observed mean of $0.009098 (16 replies of this model) | $0.6733; leaves $5.8465, room for **88 failed attempts** at $0.06594 (88.7) |
| 74 replies at the worst case, then failed attempts | $1.6402 / $0.06594 = 24.9, room for **24 failed attempts** |
| The most failed attempts the stop rule allows in the generation phase | 3 failed requests × 4 attempts + 34 requests × 3 failed attempts before a reply = **114 failed attempts = $7.5172, before any reply is priced** |

$7.5172 is more than the $6.5198 that remains. **So the cap does not guarantee a full run.** It covers the run when there are no retries, and when there are up to 88 failed attempts at the observed reply cost (24 if every reply cost the worst case). It does not cover the theoretical maximum under the stop rule. In the study the 28 failed attempts of this model cost $1.8463, which is 53% of the $3.4802 counted.

**If the cap is reached,** the runner stops with `spend_cap`, under the rule already in `DECISIONS.md`: the attempts already made on an unfinished request are written as a `transport_failure` tape so that their cost stays on the record (if the cap stops it before any attempt, nothing is written), and the run ends as incomplete. The remaining pairs are reported as **not run**, and the rule in "If the amended run stops" applies in full: no repair round, no second attempt under this amendment.

What each change is for: the old waits (14 s in total) were about the length of a rate-limit window and no longer than it; a retry that comes back inside the limit window is refused again and burns an attempt. The pacing and the `Retry-After` clause only matter if the limit is a per-minute rate.

## 4. Step 0: find out what the 429 is, before freezing

One request, outside the study, decides which of the clauses above makes sense. With the key in `.env`:

```
SMOKE_GEMINI_MODEL=gemini-3.8-flash pnpm --filter @kensho/scene-gate smoke-schema gemini --diagnose
```

It prints the status and, with `--diagnose`, the short error message with the key removed. Its result is written here before this document is frozen:

> **Step 0 result: run on 2026-11-01 at 16:31 IST. `gemini: HTTP 200, reply parses: yes`. Inconclusive about the cause.**
>
> One request to `gemini-3.8-flash` with `--diagnose` was served normally, so there was no 429 and no error message to read. The 429s of the study were at about 03:17 to 03:19 IST on 1 November, roughly 13 hours earlier. This request was also made after midnight Pacific time (12:30 IST), when daily quotas are generally expected to reset (the provider's documentation on this was not checked). So the result is consistent with a daily quota that has since reset, and equally consistent with a per-minute limit that had cleared long before. One successful request cannot tell the two apart, and no further request was made, because probing a limit means using up the quota the run needs.
>
> What it does show: the model can be served now, and the 429s are not a standing refusal of the key or the model.

- **If the message names a per-minute limit** (requests or tokens per minute): section 3 stands as drafted.
- **If it names a daily quota that is used up:** pacing and backoff cannot help. Section 3 is replaced by: the amended run waits until the quota is available again (a start date and time are written here), a 429 whose message names a daily quota ends the run **without** counting as a `transport_failure`, and the run is restarted by the same command in later sessions, skipping existing tapes. That needs the client to read the body of a 429 for the quota message, which is a further change to be tested and listed in section 5.
- **If it says something else** (for example billing or an unavailable model): this amendment is withdrawn and that is recorded.
- **If the request is served** (what happened): the cause is still unknown. The draft's section 3 can go ahead, but with its main risk stated: if the limit is a daily request quota of a size such as the 16 requests served before the first 429, the amended run needs 37 to 74 requests before retries (37 generations, plus one repair for each scene that fails, so 37 when every new scene passes and 74 when every one fails; the 16 existing scenes all pass and need none) and would meet the same wall again after the first few. The alternative was a daily-quota clause that makes a 429 a pause and not a failure and spreads the run over several days, which needs the client to read the body of a 429.
- **Decision 1 (owner, 2026-11-01): section 3 is kept as drafted.** The daily-quota clause is not added and the client does not read the body of a 429. So if the limit is a daily quota smaller than the run, the run stops under the stop rule and section 3 says what then happens.

### What the provider's documentation says (read 2026-11-01)

From https://ai.google.dev/gemini-api/docs/rate-limits, read through a summarising fetch and not as the raw page, so it is to be read again before freezing:

- **Limits apply per project, not per API key** ("Rate limits are applied per project, not per API key"). Every request from the project counts together: the smoke and end-to-end checks, `gemini-3.5-flash-lite` and `gemini-3.8-flash`, whichever key sent them. The text read does not say whether a daily quota is also counted per model.
- **Requests-per-day quotas reset at midnight Pacific time.**
- The page gives no number for any model. The limits of the project are shown in AI Studio (https://aistudio.google.com/rate-limit?timeRange=last-28-days). It names the tiers Free and Tier 1 to Tier 3, with automatic upgrades by billing and spend.
- **The reset in IST.** US daylight saving time ended on 2026-11-01. Midnight on 1 November was still 00:00 PDT = 07:00 UTC = 12:30 IST, so Step 0 (16:31 IST) came after that reset, and the study's 429s (about 03:17 to 03:19 IST on 1 November, that is about 14:47 PDT on 31 October) came before it. From 2 November midnight is 00:00 PST = 08:00 UTC = **13:30 IST**, so the next reset is 2026-11-02 13:30 IST.

| Slot | Value |
|---|---|
| AI Studio limit for the project | `OPEN`: gemini-3.8-flash RPD = __, tier = __, read on __ (to be supplied by the owner; not read) |

## 5. Implementation plan (not done)

All of it is offline-tested with a fake client first; no live study request is made.

1. A second transport policy (`TRANSPORT_POLICY_AMENDMENT_1`: waits, header handling, pacing) passed to `requestWithRetries`; the v2 policy is untouched and is what every existing test still pins.
2. `GeminiClient` returns the `Retry-After` header with a non-2xx reply (header only).
3. A run mode that accepts only `gemini-3.8-flash`, applies the amended stop rule to the 37 requested generations, then runs the repair round for that model.
4. A command: `pnpm --filter @kensho/scene-gate study:amendment-1 --tapes packages/scene-gate/tapes`. It refuses unless the three prompt hashes match, the working tree is clean (the tapes directory aside), HEAD is the commit tagged `scene-gate-amendment-1`, **and the 132 existing tapes still hash to the manifest below** (a single SHA-256 over the sorted lines `<path> <sha256>`), which is how "existing tapes untouched" is enforced and not only promised.
5. Every new tape records its commit, so the tapes made under this amendment are told apart from the others by the `commit` field.

| Slot | Value |
|---|---|
| Manifest hash of the 132 existing tapes | `OPEN` (computed at freeze) |
| SHA-256 of this document at freeze | `OPEN` |

## 6. Tag plan (not done)

1. Review and edit this draft.
2. Run Step 0, write the result in section 4, settle the `OPEN` slots.
3. Implement section 5 with tests; commit.
4. Set the status line to `FROZEN`, fill the two hash slots, commit, then
   `git tag -a scene-gate-amendment-1 -m "scene-gate amendment 1, frozen"`
   and push the branch and the tag: `git push origin scene-gate scene-gate-amendment-1`. The tag `scene-gate-prereg-v2` is not moved.
5. Run the command in section 5.
6. Commit the new tapes in a commit of their own, saying whether the amended run was complete, and push.
7. Extend `RESULTS.md` with an addendum. The results of the study as run under `prereg-v2` stay first and unchanged.

## 7. How the results will be reported

`gemini-3.8-flash` will be shown in three views, each labelled: as run under `prereg-v2` (23 generations); the amended run alone; and the two together (up to 60). The 7 failed pairs stay failures. A flip-rate triple that contains one of them is marked. Because the amended generations are made later, under possibly different provider conditions, a difference between the two parts cannot be told apart from a difference in time, and that is stated beside the combined figures. The comparison with `gemini-3.5-flash-lite` is made on the combined figures only if the amended run is complete; otherwise it is made on matching pairs only, and labelled exploratory.

## 8. Disclosure

This amendment is written after the results of `gemini-3.5-flash-lite` and the 16 `gemini-3.8-flash` scenes were seen (all 16 passed; 14 of the 15 scenes of `gemini-3.5-flash-lite` on the same pairs failed). It changes nothing that can alter the content of a scene or what a check says, and its only effect on `gemini-3.8-flash` is that the missing scenes can exist. But completing the model could change the headline comparison, and the decision to do it was made knowing how the first 16 came out. That is why section 7 puts the as-run results first, and why the combined results are labelled as the product of an amendment. If the amended run also stops, it is reported as incomplete and there is no second amendment without a new document.

## 9. Open decisions for the owner

1. Decided (owner, 2026-11-01): section 3 as drafted; no daily-quota clause; 429 bodies are not read.
2. The waits (30 s, 90 s, 270 s), the `Retry-After` clause and the 10 s pacing, or other values.
3. The stop rule base: 4 of the 37 requested, as drafted, or something else.
4. What to do once the AI Studio limit in section 4 is filled in, if its RPD is below the 37 to 74 requests the run needs (retries count as requests): wait for a tier change before freezing, freeze anyway and accept the stop, or withdraw. Section 3 cannot spread a run over days.
5. Decided (owner, 2026-11-01): the cap stop is accepted. The ledger and the worst-case pricing are not changed, and 429s are not counted cheaper. The cap does not guarantee a full run (see "The spend cap and this run" in section 3).
6. Whether "no repair round for a stopped model" (section 3, as in the preregistration) is what is wanted here.
7. Confirm that `gemini-3.5-flash-lite` is left alone.
