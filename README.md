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
- WebSocket upgrades end-to-end (the bit that breaks on `*.trycloudflare.com`)
- One tunnel = one CLI process = one localhost service. New CLI = new token.
- Two connector transports: WebSocket (default) and SSE + POST for hosts whose
  egress proxy refuses WebSocket upgrades (see below)

## Behind an HTTPS-only proxy (CI runners, agent sandboxes)

Some sandboxes (Claude Code on the web, locked-down CI) route every connection
through an intercepting HTTPS proxy: plain requests, chunked responses and
Server-Sent Events pass, WebSocket upgrades and raw TCP do not. `cloudflared`,
ngrok and the v0 anontun CLI all fail there.

The CLI handles it with a second transport that only uses plain HTTPS:

```
npx anontun 3000                    # auto: tries ws, falls back to sse
npx anontun --transport sse 3000    # force it
ANONTUN_TRANSPORT=sse npx anontun 3000
```

- relay → connector: `GET /_connect/sse` is a `text/event-stream`; every frame
  is one `data:` event, with a comment line every 15 s as keepalive.
- connector → relay: `POST /_respond/<token>` with the frame as JSON body and
  the `x-anontun-secret` header (the secret comes with the `registered` event,
  so a public client that knows the token cannot forge responses).
- If the stream drops, the CLI reconnects with `?token=&secret=`; the relay
  keeps the tunnel and queues frames for 20 s.

Public-side WebSockets still work in sse mode: the public client talks WS to
the Worker, and only the connector leg is HTTP. Node 18+ is required for the
built-in `fetch`; if the sandbox needs a proxy for outbound HTTPS and Node does
not pick it up, run with `NODE_USE_ENV_PROXY=1` (Node 24+) or set
`HTTPS_PROXY` for a proxy-aware fetch.

## What's deliberately omitted in v0

- Streaming bodies (uploads/downloads buffered up to 10 MB)
- Custom subdomains (paths only)
- Authentication / private tunnels
- Per-IP rate limiting
- TCP/UDP forwarding (HTTP+WS only)

## Architecture

- `relay/` — Cloudflare Worker + Durable Object (one DO instance per active tunnel, keyed by token).
- `cli/` — Node CLI with the `ws` package. Opens a WS to `/_connect` (or an SSE stream to `/_connect/sse`), listens for framed requests, forwards to localhost.
- Wire format documented in `relay/src/types.ts`.
