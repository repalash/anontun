# Add a test harness

## What we have today

Zero automated tests. The three bugs fixed in commit `8a901e1` (void→await onConnect, premature res_open, gzip content-encoding) were all caught by manual `curl` + ad-hoc Node WS scripts during the agent-socket integration. None would have been caught by unit tests on the modules in isolation — they were all about timing/protocol issues that only manifest end-to-end.

agent-socket has a scenario harness (`packages/agent-socket/harness/`) that's the right shape — black-box scenarios that boot the worker via `wrangler dev`, drive it via HTTP/WS, assert observable behavior. Steal that approach.

## What to build

`packages/anontun/harness/` with:

- `lib/relay.mjs` — boots `wrangler dev` for the relay on a random port, returns base URL + a cleanup handle
- `lib/origin.mjs` — a Node `http.createServer` that responds to test fixtures (`/echo`, `/slow`, `/big`, `/ws-echo`, etc.)
- `lib/connector.mjs` — programmatic wrapper around `startConnector()` so scenarios don't need to spawn the CLI
- `scenarios/` — one file per scenario, each export default async function

## Scenarios that would have caught the bugs we already fixed

| # | Name | What it tests |
|---|---|---|
| 01 | `connect-and-mint` | Open `/_connect` WS, expect `registered` frame with token + URL |
| 02 | `http-roundtrip` | Origin returns JSON; public GET through tunnel returns same JSON, same headers (`content-type`), same status |
| 03 | `http-with-body` | Public POST `{x: 1}` → origin echoes — verifies request body forwarded |
| 04 | `gzip-content-not-corrupted` | Public client sends `Accept-Encoding: gzip`; tunnel returns decodable response. **Would have caught bug #3.** |
| 05 | `ws-handshake-and-echo` | Public WS → /ws-echo. Send "ping", receive "pong". **Would have caught bugs #1 + #2.** |
| 06 | `ws-first-frame-immediate` | Public WS sends a frame within 1ms of `open`. Origin must receive it. **Specifically targets the race fixed in bug #2.** |
| 07 | `concurrent-tunnels` | 10 connectors, each with own token; 10 public clients to each URL; no cross-contamination |
| 08 | `connector-drop-fails-pending` | Public request in-flight, connector dies; public client sees 503 within timeout, not 30s hang |
| 09 | `body-too-large-413` | POST 11 MB → 413 (until streaming lands, then this scenario gets replaced) |
| 10 | `bad-token-404` | `/t/INVALIDTOKEN/anything` → 404 |

## Acceptance

- `npm test` from `packages/anontun/` runs the harness, all scenarios pass in < 30s total
- CI-friendly (no interactive prompts, no hardcoded ports — bind 0, read assigned port)
- A regression of any of the 3 known bugs makes the corresponding scenario fail loudly

## Done (2026-09-13)

`test/e2e.mjs` (`npm test`): one file, real processes — `wrangler dev`, an HTTP + WS echo
origin, a proxy that refuses WebSocket upgrades, and the CLI. Covers both connector transports,
public WS (text/binary/subprotocol/close), host-based routing, `--keep-path`, reconnect after a
cut stream, teardown after the CLI exits. `RELAY=<url>` runs it against a deployed relay.
