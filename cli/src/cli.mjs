#!/usr/bin/env node
// anontun CLI.
//
//   npx anontun <port>
//   npx anontun http://localhost:3000
//
// Env:
//   ANONTUN_RELAY      base URL of the relay (default: https://anontun.example.com)
//   ANONTUN_TRANSPORT  ws | sse | auto (default: auto — WebSocket first, then
//                      Server-Sent Events + POST when the upgrade is refused,
//                      e.g. behind an HTTPS-only proxy)

import { startConnector } from "./connector.mjs"

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  console.log(`anontun — anonymous tunnel CLI

Usage:
  anontun <port>                         # exposes http://localhost:<port>
  anontun http://host:port               # exposes any local URL
  anontun --relay <base-url> <port>      # override relay base URL
  anontun --transport <ws|sse|auto> <port>

Env:
  ANONTUN_RELAY      base URL of the relay (default https://anontun.example.com)
  ANONTUN_TRANSPORT  ws | sse | auto (default auto)
`)
  process.exit(args.length === 0 ? 1 : 0)
}

let relayBase = process.env.ANONTUN_RELAY ?? "https://anontun.example.com"
let transport = process.env.ANONTUN_TRANSPORT ?? "auto"
const positional = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--relay") { relayBase = args[++i]; continue }
  if (args[i] === "--transport") { transport = args[++i]; continue }
  positional.push(args[i])
}

if (!["ws", "sse", "auto"].includes(transport)) {
  console.error(`anontun: invalid transport: ${transport} (use ws, sse or auto)`)
  process.exit(1)
}

const target = positional[0]
let originUrl
if (/^https?:\/\//.test(target)) originUrl = target.replace(/\/+$/, "")
else if (/^\d+$/.test(target)) originUrl = `http://localhost:${target}`
else { console.error(`anontun: invalid target: ${target}`); process.exit(1) }

startConnector({ relayBase, originUrl, transport }).catch((e) => {
  console.error("anontun:", e?.message ?? e)
  process.exit(1)
})
