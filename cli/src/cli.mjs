#!/usr/bin/env node
// anontun CLI.
//
//   npx anontun <port>
//   npx anontun http://localhost:3000
//
// Env:
//   ANONTUN_RELAY  base URL of the relay (default: https://anontun.example.com)

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
  ANONTUN_RELAY  base URL of the relay (default https://anontun.example.com)
`)
  process.exit(args.length === 0 ? 1 : 0)
}

let relayBase = process.env.ANONTUN_RELAY ?? "https://anontun.example.com"
let keepPath = process.env.ANONTUN_KEEP_PATH === "1"
const positional = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--relay") { relayBase = args[++i]; continue }
  if (args[i] === "--keep-path") { keepPath = true; continue }
  positional.push(args[i])
}

const target = positional[0]
let originUrl
if (/^https?:\/\//.test(target)) originUrl = target.replace(/\/+$/, "")
else if (/^\d+$/.test(target)) originUrl = `http://localhost:${target}`
else { console.error(`anontun: invalid target: ${target}`); process.exit(1) }

startConnector({ relayBase, originUrl, keepPath }).catch((e) => {
  console.error("anontun:", e?.message ?? e)
  process.exit(1)
})
