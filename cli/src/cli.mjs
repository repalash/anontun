#!/usr/bin/env node
// anontun CLI.
//
//   npx anontun <port>
//   npx anontun http://localhost:3000
//
// Env:
//   ANONTUN_RELAY      base URL of the relay (default: https://anontun.example.com)
//   ANONTUN_KEEP_PATH  1 = same as --keep-path
//   ANONTUN_TRANSPORT  testing only: force "ws" or "sse". Default "auto" —
//                      WebSocket, falling back to SSE + POST when a proxy
//                      refuses the upgrade.

import { startConnector } from "./connector.mjs"

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  console.log(`anontun — anonymous tunnel CLI

Usage:
  anontun <port>                         # exposes http://localhost:<port>
  anontun http://host:port               # exposes any local URL
  anontun --relay <base-url> <port>      # override relay base URL
  anontun --keep-path <port>             # forward /t/<token>/... unstripped (apps served under that base)

Env:
  ANONTUN_RELAY      base URL of the relay (default https://anontun.example.com)
  ANONTUN_KEEP_PATH  1 = same as --keep-path

The relay connection is a WebSocket; behind a proxy that refuses the upgrade
the CLI falls back to plain HTTPS (SSE + POST) on its own. HTTPS_PROXY and
NO_PROXY are honoured.
`)
  process.exit(args.length === 0 ? 1 : 0)
}

let relayBase = process.env.ANONTUN_RELAY ?? "https://anontun.example.com"
let keepPath = process.env.ANONTUN_KEEP_PATH === "1"
let transport = process.env.ANONTUN_TRANSPORT ?? "auto"
const positional = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--relay") { relayBase = args[++i]; continue }
  if (args[i] === "--keep-path") { keepPath = true; continue }
  positional.push(args[i])
}

if (!["ws", "sse", "auto"].includes(transport)) {
  console.error(`anontun: invalid ANONTUN_TRANSPORT: ${transport} (use ws, sse or auto)`)
  process.exit(1)
}

const target = positional[0]
let originUrl
if (/^https?:\/\//.test(target)) originUrl = target.replace(/\/+$/, "")
else if (/^\d+$/.test(target)) originUrl = `http://localhost:${target}`
else { console.error(`anontun: invalid target: ${target}`); process.exit(1) }

startConnector({ relayBase, originUrl, transport, keepPath }).catch((e) => {
  console.error("anontun:", e?.message ?? e)
  process.exit(1)
})
