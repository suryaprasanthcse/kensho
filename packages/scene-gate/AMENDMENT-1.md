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

**What this does and does not show.** A 429 is a refusal to serve a request because of a limit. The study never reads an error body, so the tapes do not say which limit: a per-minute rate, a per-minute token budget, or a daily request quota on this key and this model. `gemini-3.8-flash` was asked for only about one request every 80 s during the run, which is slow, so a per-minute rate limit looks unlikely. A quota that counts requests per day is consistent with the timing: this model had also been called earlier the same day by the smoke and end-to-end checks, and the 429s began after 16 study requests. **That is a hypothesis, not a finding.** If it is a daily quota, no pacing and no backoff of minutes will help; the run would have to wait for the quota to reset, or for the key's tier to change. Section 4 settles this before anything is frozen.

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
- **If the request is served** (what happened): the cause is still unknown. The draft's section 3 can go ahead, but with its main risk stated: if the limit is a daily request quota of a size such as the 16 requests served before the first 429, the amended run needs about 74 requests (37 generations and up to 37 repairs, more with retries) and would meet the same wall again after the first few. The alternative is the daily-quota clause above, which makes a 429 a pause and not a failure and spreads the run over several days. That clause needs the client to read the body of a 429, so it is a larger change; whether to include it is decision 1 in section 9.

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

1. What to do about Step 0 being inconclusive: go ahead on section 3 as drafted and accept that a daily quota would stop the run again; or add the daily-quota clause (a 429 is a pause, the run is split over several days) before freezing.
2. The waits (30 s, 90 s, 270 s), the `Retry-After` clause and the 10 s pacing, or other values.
3. The stop rule base: 4 of the 37 requested, as drafted, or something else.
4. Whether to wait for a quota reset or a change of tier if Step 0 points to a daily quota.
5. Confirm that `gemini-3.5-flash-lite` is left alone.
