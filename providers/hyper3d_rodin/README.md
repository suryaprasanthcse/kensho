# @kensho/hyper3d_rodin

REST client for the Hyper3D Rodin API, written in plain TypeScript on `fetch`. It rate limits with a token bucket, caps concurrent jobs with a semaphore, backs off with jitter on throttling, writes every accepted job to an append-only ledger the moment it is accepted, and halts spending when anything it cannot explain happens: a tier other than the one requested, a charge other than the documented price, or a refused key.

Safety properties:

- **No key, no network.** Without `HYPER3D_API_KEY` the factory returns a stub whose methods throw `NOT_CONFIGURED`.
- **No accidental live calls.** A host other than loopback is refused unless `allowLive` is set, and a credit ceiling (`maxCredits`) has no default.
- **The key goes only to the API origin**, never to a download host named in a response, and never into the ledger or an error message.
- **A submit that times out is never retried**: it may have been charged. Status and download requests are idempotent and are retried.
- **`tier` is required** and legacy tiers are refused, because omitting it silently selects an older generation.

The key is read from `process.env` (so Node's `--env-file=.env` works) or, when given an explicit path, parsed from an env file without loading it into the environment. Copy `.env.example` to `.env` at the repository root; `.env` is ignored by git.

The unit tests run against a local mock server in `src/mock.ts` that injects timeouts, 429s, errors inside HTTP 201 bodies, tier and price changes, parallelism limits, sub-jobs that finish one after another, and damaged downloads.

The wire format was checked against the live service on 31 Oct 2026 with ten real jobs (`pnpm live-calibration`, then `pnpm live-report`, which write to `bench/out/live/`):

- Status and download answer HTTP 201, not 200.
- One submission fans out into three jobs; it is done only when every one is `Done`, and a download requested earlier returns an empty list instead of an error.
- `consumed` is a top-level number on the submit response. The response does not echo the tier.
- `bbox_condition` as three repeated form fields maps to `[x, y, z]` of the delivered GLB. `addons` as a repeated field is honoured.
- The submit and download endpoints advertised 200 requests per minute and status 30 per second.

Not established: whether `seed` makes output reproducible, how long download URLs live, and any rate or parallelism behaviour beyond one burst of seven.
