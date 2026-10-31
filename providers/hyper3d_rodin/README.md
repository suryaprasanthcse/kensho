# @kensho/hyper3d_rodin

REST client for the Hyper3D Rodin API, written in plain TypeScript on `fetch`. It rate limits with a token bucket, caps concurrent jobs with a semaphore, backs off with jitter on throttling, writes every accepted job to an append-only ledger the moment it is accepted, and halts spending when anything it cannot explain happens: a tier other than the one requested, a charge other than the documented price, or a refused key.

Safety properties:

- **No key, no network.** Without `HYPER3D_API_KEY` the factory returns a stub whose methods throw `NOT_CONFIGURED`.
- **No accidental live calls.** A host other than loopback is refused unless `allowLive` is set, and a credit ceiling (`maxCredits`) has no default.
- **The key goes only to the API origin**, never to a download host named in a response, and never into the ledger or an error message.
- **A submit that times out is never retried**: it may have been charged. Status and download requests are idempotent and are retried.
- **`tier` is required** and legacy tiers are refused, because omitting it silently selects an older generation.

The key is read from `process.env` (so Node's `--env-file=.env` works) or, when given an explicit path, parsed from an env file without loading it into the environment. Copy `.env.example` to `.env` at the repository root; `.env` is ignored by git.

Everything here is tested against a local mock server in `src/mock.ts` that injects timeouts, 429s, errors inside HTTP 201 bodies, tier and price changes, parallelism limits and damaged downloads. The wire format for the status and download endpoints, the response field that reports the credits consumed, and the encoding of `bbox_condition` and `addons` are assumptions to confirm against the API specification before the first real job.
