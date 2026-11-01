# Amendment 1: withdrawn

**Status: WITHDRAWN. Not frozen. Never run.** The tag `scene-gate-amendment-1` was never created, and nothing in this file applies to the study.

> I wrote the specification and set the thresholds; Claude Code wrote the code and tests under my direction.

## What it proposed

A draft amendment to `PREREGISTRATION.md` (frozen at the tag `scene-gate-prereg-v2`) that would have changed only how a request that gets no reply is handled, for `gemini-3.8-flash` alone: longer waits between retries, pacing between requests, and a stop rule of 4 or more `transport_failure` among the 37 missing generations. It would then have run those 37 generations and the repair round, leaving every existing tape untouched.

## Why it is withdrawn

- **The quota is smaller than the run.** On 2026-11-01 at 19:08 IST the owner read the limit for `gemini-3.8-flash` in AI Studio: **20 requests per day (RPD), tier Free**. The run needed 37 to 74 requests before retries. That is consistent with a daily request quota as the cause of the study's 429s (16 replies were served before the first one), though the study never read a 429 body, so the cause is not shown.
- **No dependency on billing or on a multi-day run.** Finishing the run would have needed a change of billing tier, or a run spread over several days, which the amendment as drafted could not do.

## What stands

The 132 tapes in `tapes/` are the record, exactly as written under `prereg-v2`. `gemini-3.5-flash-lite` is complete. `gemini-3.8-flash` is incomplete under the pre-registered 10% rule: 23 of 60 generations (16 replies, all passing; 7 `transport_failure`, every failed attempt HTTP 429), 37 generations not run, and no repair round. The results are in `RESULTS.md`, which is generated from the tapes.
