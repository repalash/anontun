# Per-IP rate limit on /_connect

## Why this matters

The relay deliberately has no auth — that's the point. But it means anyone who knows the URL can hit `/_connect` and spin up an unbounded number of tunnels on your CF account. A single user (or bot) could:

- Spawn 10k tunnels by holding 10k WebSockets open
- Burn through CF Workers free-tier budget overnight
- Exhaust DO instance limits

Currently the only backpressure is CF's own subrequest quotas, which only kick in late.

## What to do

Add a per-IP token bucket on `/_connect`:

- **Bucket scope**: keyed by `cf-connecting-ip` (the actual client IP, not the edge IP)
- **Limit**: e.g. 10 concurrent active tunnels per IP, refill 1 tunnel per minute
- **Storage**: a singleton DO (e.g. `RateLimitDO`) keyed by IP, OR Workers KV with TTL, OR CF Rate Limiting Rules (simplest, no code)
- **Response on limit**: 429 with `Retry-After`, NOT a silent close

## Open design questions

- Should the limit be "active tunnels held open" or "new tunnels per minute"? Held-open is the real risk (DO instances pile up); new/minute alone doesn't help.
- Should we expose `ANONTUN_MAX_TUNNELS_PER_IP` as a wrangler `[vars]` config so self-hosters can tune?

## Acceptance

- A single IP holding N tunnels open can't open N+1 — gets 429
- A new tunnel after one drops works
- The limit is configurable, not hardcoded
- Documented in README under "Self-hosting tradeoffs"
