# TCP/UDP forwarding (not just HTTP+WS)

## Why someone might want this

Today anontun only forwards HTTP and WebSocket — the things CF Workers natively understands. If you want to expose:

- A Postgres server (TCP, port 5432)
- An MQTT broker (TCP, port 1883)
- A game server (UDP)
- A custom binary protocol

…anontun is useless. cloudflared can do TCP via `cloudflared access tcp --hostname host --url tcp://localhost:5432`, but that requires named tunnels (the whole reason we built anontun in the first place).

## How CF could do it

CF Workers has [`connect()`](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) for outbound TCP, and a relatively new TCP-socket-binding-to-DO feature (in beta last I checked). For UDP, CF added [UDP support to Workers](https://blog.cloudflare.com/workers-udp-support/) in 2024, but it's a separate primitive.

The viable path:

- For **inbound TCP at the edge**, CF doesn't expose this on `*.workers.dev` — you'd need Spectrum (paid) or a TCP listener on a CF DNS record. So **passive TCP forwarding ("anyone can connect to this port") is not feasible on free CF**.
- For **client-initiated streams that LOOK like TCP**, you could ship a userspace TCP-over-WebSocket protocol: client uses a small CLI that takes a token + remote `host:port`, opens a WS to the anontun relay carrying TCP frames, relay forwards to connector, connector dials the local TCP target. This is what wstunnel / chisel do.

## What to do (if pursued)

Add a third tool to the CLI:

```bash
anontun --tcp 5432       # exposes localhost:5432 over the tunnel
anontun --tcp 0.0.0.0:5432  # bind explicitly
```

And a client-side tool to connect:

```bash
npx anontun connect <url> --local-port 5432
# opens local :5432, forwards all connections through the tunnel
```

Wire frames: `tcp_open { id, addr }`, `tcp_data { id, data_b64 }`, `tcp_close { id }`.

## Open questions

- Worth the scope creep? Original anontun pitch was "expose your local web app to AI agents." TCP forwarding is a different audience.
- If yes, probably its own subcommand and code path — don't entangle with the HTTP/WS path.
- UDP is harder (no connection lifecycle); probably skip unless someone asks.

## Acceptance (if built)

- `anontun --tcp 5432` exposes local Postgres
- Remote client runs `npx anontun connect <url> --local-port 5432` and can `psql -h 127.0.0.1 -p 5432` through the tunnel
- Multiple concurrent TCP connections multiplexed over the single WS
- TLS-over-TCP works (we're just shoveling bytes)
