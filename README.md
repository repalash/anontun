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

## What's deliberately omitted in v0

- Streaming bodies (uploads/downloads buffered up to 10 MB)
- Custom subdomains (paths only)
- Authentication / private tunnels
- Per-IP rate limiting
- TCP/UDP forwarding (HTTP+WS only)

## Architecture

- `relay/` — Cloudflare Worker + Durable Object (one DO instance per active tunnel, keyed by token).
- `cli/` — Node CLI with the `ws` package. Opens a WS to `/_connect`, listens for framed requests, forwards to localhost.
- Wire format documented in `relay/src/types.ts`.
