# anontun

A no-login, no-token tunnel service you self-host on Cloudflare. Once deployed, **any** client (you, your agents, anyone you give the URL to) can expose a local port without signing up for anything.

```
[your laptop / agent]              [your CF Worker]              [public]
                                                                  
  npx anontun 3000  ──WS──▶  https://my-anontun.workers.dev/_connect
                                                                  
                             registered: token=abc123def456       ←  any HTTP/WS
                             URL: …/t/abc123def456/                  to that URL
```

## Why

Cloudflare's free quick-tunnels (`*.trycloudflare.com`) are flaky for WebSocket and have aggressive limits. Named tunnels work but require `cloudflared login` + a CF account on every machine that wants to expose a service.

`anontun` flips this: **you** host the tunnel relay (one `wrangler deploy` against your own CF account). After that, anyone — including AI agents you spawn — can run `npx anontun <port>` against your relay URL and get a working public link, no auth.

## Deploy the relay

```bash
cd relay
npm install
npx wrangler login          # one time
npx wrangler deploy
```

Note the URL it prints (e.g. `https://anontun.YOURNAME.workers.dev`). Set it as the default for your CLI:

```bash
export ANONTUN_RELAY=https://anontun.YOURNAME.workers.dev
```

Optional, on a custom domain: set `TUNNEL_HOST = "tunnel.example.com"` in `[vars]`, add a
proxied wildcard DNS record `*.tunnel` → the relay, a Worker route `*.tunnel.example.com/*`, and
a certificate that covers the second-level wildcard (Cloudflare Universal SSL does not — use
Advanced Certificate Manager). Tunnels are then `https://<token>.tunnel.example.com/` with the
path passed through untouched, which is what single-page apps need.

## Test

```bash
npm install
npm test                                   # boots wrangler dev + an origin + the CLI, ~90 s
RELAY=https://your-relay npm test          # same suite against a deployed relay
```

## Use the CLI

```bash
npx anontun 3000
#   https://anontun.YOURNAME.workers.dev/t/Q7R5X2KMABCD/
#
#   → http://localhost:3000
#
#   (Ctrl-C to stop)
```

That URL is now reachable by anyone, anywhere. Send it to an AI chat, a webhook tester, a teammate, whatever. Disconnects when you Ctrl-C.

## What works

- All HTTP methods, request + response headers passed through
- Request/response bodies up to 10 MB (v0 cap)
- WebSocket upgrades end-to-end (the bit that breaks on `*.trycloudflare.com`), including the
  requested subprotocol (`Sec-WebSocket-Protocol`, e.g. Vite's `vite-hmr`)
- One tunnel = one CLI process = one localhost service. New CLI = new token.
- Works behind proxies that refuse WebSocket upgrades: the CLI falls back to
  plain HTTPS (SSE + POST) by itself (see below)
- Host-based URLs (`https://<token>.tunnel.example.com/`) when the relay is
  deployed with `TUNNEL_HOST` (see "Deploy the relay"); path-based
  `/t/<token>/` always works

## Behind a proxy (CI runners, Claude Code cloud, corporate laptops)

Sandboxes usually route every connection through an intercepting HTTPS proxy
on port 443. What passes differs per sandbox: plain requests, chunked
responses and Server-Sent Events always do; WebSocket upgrades pass in some
(Claude Code cloud, measured 2026-09-12) and are answered with a plain 200 in
others; raw TCP and non-443 ports never do. That last point is why
`cloudflared` and ngrok fail there: they need port 7844 / raw TCP to their
edge and cannot use an HTTP proxy. anontun only ever speaks HTTPS/WSS on 443.

Two things make the CLI work behind such proxies:

**1. Proxy-aware relay connection.** The CLI honours `HTTPS_PROXY` /
`https_proxy` (and `NO_PROXY`): it sends `CONNECT relay-host:443` and runs
TLS + the WebSocket inside. `ANONTUN_PROXY=<url>` forces a proxy,
`ANONTUN_NO_PROXY=1` disables it. A proxy that re-terminates TLS must publish
its CA via `NODE_EXTRA_CA_CERTS`, which Node picks up on its own. The SSE
transport uses Node's built-in `fetch`, which reads `HTTPS_PROXY` only with
`NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).

**2. A second transport that only uses plain HTTPS**, for proxies that refuse
the WebSocket upgrade:

```
npx anontun 3000                    # WebSocket; falls back to sse when the upgrade is refused
ANONTUN_TRANSPORT=sse npx anontun 3000   # testing only: force one transport (ws | sse)
```

- relay → connector: `GET /_connect/sse` is a `text/event-stream`; every frame
  is one `data:` event, with a comment line every 15 s as keepalive.
- connector → relay: `POST /_respond/<token>` with the frame as JSON body and
  the `x-anontun-secret` header (the secret comes with the `registered` event,
  so a public client that knows the token cannot forge responses).
- If the stream drops, the CLI reconnects with `?token=&secret=`; the relay
  keeps the tunnel and queues frames for 20 s.

Public-side WebSockets still work in sse mode: the public client talks WS to
the Worker, and only the connector leg is HTTP.

## What's deliberately omitted in v0

- Streaming bodies (uploads/downloads buffered up to 10 MB)
- Custom subdomain names (tokens are random). Note that without `TUNNEL_HOST` tunnels are path-based
  and apps that emit root-absolute URLs (`/src/main.tsx`, `/@vite/client`) break under `/t/<token>/`
  unless their base path is set to it (`npx anontun --keep-path` forwards the prefix unstripped)
- Authentication / private tunnels
- Per-IP rate limiting
- TCP/UDP forwarding (HTTP+WS only)

## Architecture

- `relay/` — Cloudflare Worker + Durable Object (one DO instance per active tunnel, keyed by token).
- `cli/` — Node CLI with the `ws` package. Opens a WS to `/_connect` (or an SSE stream to `/_connect/sse`), listens for framed requests, forwards to localhost.
- Wire format documented in `relay/src/types.ts`.
