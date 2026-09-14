#!/usr/bin/env node
// End-to-end test for the anontun relay + CLI. Real processes, real sockets.
//
//   node test/e2e.mjs                       # starts `wrangler dev` on a free port
//   RELAY=https://tunnel.example.com node test/e2e.mjs   # against a deployed relay
//
// Env:
//   RELAY         relay base URL; when unset, wrangler dev is started locally
//   TUNNEL_HOST   host suffix for host-based URLs (default tunnel.test locally;
//                 set it to the deployed value, e.g. tunnel.ijewel.info)
//   SKIP_HOST=1   skip the host-based routing cases (no wildcard DNS yet)
//   VERBOSE=1     show child process output
//
// What it covers, for BOTH connector transports (ws, and sse behind a proxy
// that refuses WebSocket upgrades):
//   HTTP GET/POST bodies and headers, status passthrough, 3 MB body, query
//   strings, --keep-path, public-side WebSocket echo (text + binary,
//   subprotocol echoed), 503 after the connector exits.
// Plus, sse only: reconnect after the stream is cut, same URL keeps working.
// Plus, host-based routing: <token>.<TUNNEL_HOST> serves the same tunnel with
// the path untouched.

import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocketServer, WebSocket } from "ws"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CLI = path.join(ROOT, "cli/src/cli.mjs")
// wrangler.toml lives in relay/ upstream and at the service root in ijewel-mono.
const WRANGLER_DIR = fs.existsSync(path.join(ROOT, "relay/wrangler.toml")) ? path.join(ROOT, "relay") : ROOT
const VERBOSE = !!process.env.VERBOSE
const TUNNEL_HOST = process.env.TUNNEL_HOST ?? (process.env.RELAY ? "" : "tunnel.test")

const results = []
let failed = 0
function check(name, ok, detail = "") {
  results.push({ name, ok, detail })
  if (!ok) failed++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)) }) })
}
function pipeOut(child, tag) {
  for (const stream of [child.stdout, child.stderr]) {
    let buf = ""
    stream.on("data", (d) => { buf += d.toString(); if (VERBOSE) process.stderr.write(`[${tag}] ${d}`) })
    child._buf = () => buf
    child._lines = (re) => buf.split("\n").filter((l) => re.test(l))
  }
  child._out = ""
  child.stdout.on("data", (d) => { child._out += d.toString() })
  child.stderr.on("data", (d) => { child._out += d.toString() })
}
async function waitFor(fn, ms, what) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(200) }
  throw new Error(`timeout waiting for ${what}`)
}

// ── origin: HTTP + WS echo on localhost ────────────────────────
const BIG = Buffer.alloc(3 * 1024 * 1024, "x")
const originPort = await freePort()
const origin = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x")
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const body = Buffer.concat(chunks)
    if (u.pathname === "/hello") { res.setHeader("x-origin", "yes"); res.end(`hi ${u.search}`); return }
    if (u.pathname.endsWith("/echo")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ method: req.method, path: req.url, headers: req.headers, body: body.toString("base64") })); return }  // any prefix, so --keep-path can be checked
    if (u.pathname === "/big") { res.setHeader("content-type", "application/octet-stream"); res.end(BIG); return }
    if (u.pathname.startsWith("/status/")) { res.statusCode = Number(u.pathname.slice(8)); res.end("status"); return }
    if (u.pathname === "/slow") { setTimeout(() => res.end("slow"), 1500); return }
    res.statusCode = 404; res.end(`no route ${req.url}`)
  })
})
const wss = new WebSocketServer({ noServer: true, handleProtocols: (protos) => protos.values().next().value ?? false })
origin.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/ws")) { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(`welcome ${req.url}`)
    ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }))
  })
})
await new Promise((r) => origin.listen(originPort, "127.0.0.1", r))

// ── relay: wrangler dev unless RELAY is given ──────────────────
let relay = process.env.RELAY?.replace(/\/+$/, "")
let wrangler = null
if (!relay) {
  const port = await freePort()
  // WRANGLER_DEV_ARGS: extra flags, e.g. "--env test" where the deploy config
  // carries routes (wrangler dev rewrites every request's host to the route's
  // hostname, which hides the Host header the host-based cases need).
  const extra = (process.env.WRANGLER_DEV_ARGS ?? "").split(" ").filter(Boolean)
  wrangler = spawn("npx", ["wrangler", "dev", "--port", String(port), "--local", "--log-level", "info", "--var", `TUNNEL_HOST:${TUNNEL_HOST}`, ...extra],
    { cwd: WRANGLER_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] })
  pipeOut(wrangler, "wrangler")
  relay = `http://127.0.0.1:${port}`
  await waitFor(async () => { try { const r = await fetch(`${relay}/_health`); return r.ok } catch { return false } }, 90_000, "wrangler dev")
  console.log(`relay: ${relay} (wrangler dev, TUNNEL_HOST=${TUNNEL_HOST})`)
} else {
  console.log(`relay: ${relay} (external, TUNNEL_HOST=${TUNNEL_HOST || "unset"})`)
}
const relayUrl = new URL(relay)

// ── fake proxy that refuses WebSocket upgrades (Dasha's sandbox) ──
const fakePort = await freePort()
let fakeProxy = null
function startFakeProxy() {
  const lib = relayUrl.protocol === "https:" ? https : http
  fakeProxy = http.createServer((req, res) => {
    const headers = { ...req.headers, host: relayUrl.host }
    const p = lib.request({ host: relayUrl.hostname, port: relayUrl.port || (relayUrl.protocol === "https:" ? 443 : 80), method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res)
    })
    p.on("error", (e) => { res.writeHead(502); res.end(e.message) })
    // A client disconnect cuts the upstream leg too, like a real proxy.
    res.on("close", () => p.destroy())
    req.pipe(p)
  })
  fakeProxy.on("upgrade", (req, socket) => socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"))
  return new Promise((r) => fakeProxy.listen(fakePort, "127.0.0.1", r))
}
await startFakeProxy()
const viaFake = `http://127.0.0.1:${fakePort}`

// ── helpers ───────────────────────────────────────────────────
function startConnector(relayBase, extra = [], env = {}) {
  const c = spawn(process.execPath, [CLI, "--relay", relayBase, ...extra, `http://127.0.0.1:${originPort}`],
    { env: { ...process.env, ANONTUN_DEBUG: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] })
  pipeOut(c, "cli")
  c.url = async () => waitFor(() => { const m = c._out.match(/\n\s+(https?:\/\/\S+\/)\n/); return m?.[1] }, 20_000, "registered URL")
  return c
}
// The tunnel's token, from either URL shape: https://relay/t/<token>/ or
// https://<token>.tunnel.example.com/. A regex alternation over the whole URL
// is not safe here — "//<label>." matches the relay's own host first when the
// relay has a dotted hostname, so parse the URL instead.
function tokenFromUrl(u) {
  const url = new URL(u)
  const m = url.pathname.match(/^\/t\/([^/]+)/)
  return m ? m[1] : url.hostname.split(".")[0]
}

function request(url, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === "https:" ? https : http
    const req = lib.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    req.setTimeout(40_000, () => req.destroy(new Error("request timeout")))
    if (body) req.write(body)
    req.end()
  })
}
function wsEcho(url, { headers = {}, protocol } = {}) {
  return new Promise((resolve) => {
    const out = { open: false, welcome: null, text: null, binary: null, protocol: null, closed: null, error: null }
    const ws = new WebSocket(url, protocol ? [protocol] : [], { headers })
    const t = setTimeout(() => { out.error ??= "timeout"; try { ws.terminate() } catch {}; resolve(out) }, 15_000)
    ws.on("open", () => { out.open = true; out.protocol = ws.protocol })
    ws.on("message", (d, isBinary) => {
      if (!out.welcome) { out.welcome = d.toString(); ws.send("text-echo"); return }
      if (!isBinary && out.text === null) { out.text = d.toString(); ws.send(Buffer.from([1, 2, 3, 250]), { binary: true }); return }
      if (isBinary && out.binary === null) { out.binary = Buffer.from(d).toString("hex"); ws.close(1000, "done") }
    })
    ws.on("close", (code) => { out.closed = code; clearTimeout(t); resolve(out) })
    ws.on("error", (e) => { out.error = e.message; clearTimeout(t); resolve(out) })
  })
}
async function httpSuite(label, base, opts = {}) {
  const r1 = await request(`${base}hello?x=1&y=two`)
  check(`${label} GET + query`, r1.status === 200 && r1.body.toString() === "hi ?x=1&y=two", `${r1.status} ${r1.body.toString().slice(0, 40)}`)
  check(`${label} response header passthrough`, r1.headers["x-origin"] === "yes")
  const payload = JSON.stringify({ hello: "world", n: 42 })
  const r2 = await request(`${base}echo?q=1`, { method: "POST", body: payload, headers: { "content-type": "application/json", "x-custom": "abc" } })
  let echoed = {}
  try { echoed = JSON.parse(r2.body.toString()) } catch {}
  check(`${label} POST body + headers`, r2.status === 200 && echoed.method === "POST" && Buffer.from(echoed.body ?? "", "base64").toString() === payload && echoed.headers?.["x-custom"] === "abc", `${r2.status}`)
  check(`${label} path seen by origin`, echoed.path === (opts.keepPath ? `${opts.prefix}echo?q=1` : "/echo?q=1"), `origin saw ${echoed.path}`)
  const r3 = await request(`${base}big`)
  check(`${label} 3 MB body intact`, r3.status === 200 && r3.body.length === BIG.length && r3.body.equals(BIG), `${r3.status} ${r3.body.length} bytes`)
  const r4 = await request(`${base}status/418`)
  check(`${label} status passthrough`, r4.status === 418, `${r4.status}`)
  const r5 = await request(`${base}slow`)
  check(`${label} slow origin (1.5 s)`, r5.status === 200 && r5.body.toString() === "slow", `${r5.status}`)
}

// ── cases ──────────────────────────────────────────────────────
async function transportCase(label, relayBase, env) {
  console.log(`\n== ${label} ==`)
  const c = startConnector(relayBase, [], env)
  const url = await c.url()
  const isHost = TUNNEL_HOST && url.includes(`.${TUNNEL_HOST}/`)
  console.log(`tunnel: ${url}${isHost ? " (host-based)" : ""}`)
  const transportLine = c._out.match(/→ .* \((\w+)\)/)?.[1]
  check(`${label} transport used`, transportLine === env.EXPECT_TRANSPORT, `${transportLine}`)
  // Public-side requests go straight to the relay (host header when host-based).
  // For local runs the host-based hostname does not resolve, so use the path form
  // on the relay and cover host-based routing separately below.
  const token = tokenFromUrl(url)
  const pathBase = `${relay}/t/${token}/`
  await httpSuite(label, pathBase)
  const wsRes = await wsEcho(pathBase.replace(/^http/, "ws") + "ws/chat?room=1", { protocol: "chat-v1" })
  check(`${label} public WS echo text`, wsRes.open && wsRes.welcome === "welcome /ws/chat?room=1" && wsRes.text === "text-echo", wsRes.error ?? "")
  check(`${label} public WS echo binary`, wsRes.binary === "010203fa", wsRes.binary ?? wsRes.error ?? "")
  check(`${label} public WS subprotocol echoed`, wsRes.protocol === "chat-v1", `${wsRes.protocol}`)
  check(`${label} public WS close handshake`, wsRes.closed === 1000, `${wsRes.closed}`)
  if (!process.env.SKIP_HOST && TUNNEL_HOST) {
    // Host-based: send the request to the relay with Host: <token>.<TUNNEL_HOST>.
    const hostHdr = `${token}.${TUNNEL_HOST}`
    const rh = await request(`${relay}/echo?h=1`, { headers: { host: hostHdr } })
    let e = {}; try { e = JSON.parse(rh.body.toString()) } catch {}
    check(`${label} host-based routing`, rh.status === 200 && e.path === "/echo?h=1", `${rh.status} origin saw ${e.path}`)
    const whs = await wsEcho(`${relay.replace(/^http/, "ws")}/ws/h`, { headers: { host: hostHdr } })
    check(`${label} host-based public WS`, whs.open && whs.text === "text-echo", whs.error ?? "")
    check(`${label} registered URL is host-based`, isHost, url)
  }
  return { c, token, pathBase }
}

// 1. ws transport (direct)
{
  const { c, pathBase } = await transportCase("ws", relay, { EXPECT_TRANSPORT: "ws" })
  c.kill("SIGTERM"); await sleep(1500)
  const r = await request(`${pathBase}hello`)
  check("ws 503 after connector exits", r.status === 503, `${r.status}`)
}

// 2. sse transport, forced through a proxy that refuses upgrades (auto fallback)
{
  const { c, pathBase } = await transportCase("sse", viaFake, { EXPECT_TRANSPORT: "sse" })
  check("sse fallback was automatic", /falling back to sse/.test(c._out))
  // Cut the stream: destroy every connection through the fake proxy and restart it.
  fakeProxy.closeAllConnections()
  await new Promise((r) => fakeProxy.close(r))
  await startFakeProxy()
  await waitFor(() => /reconnecting/.test(c._out), 10_000, "reconnect log line").catch(() => {})
  check("sse reconnects after stream drop", /sse stream dropped .*; reconnecting/.test(c._out))
  await sleep(1500)
  const r = await request(`${pathBase}hello`)
  check("sse same URL works after reconnect", r.status === 200 && r.body.toString() === "hi ", `${r.status}`)
  const w = await wsEcho(pathBase.replace(/^http/, "ws") + "ws/after")
  check("sse public WS after reconnect", w.open && w.text === "text-echo", w.error ?? "")
  // Clean exit (Ctrl-C / SIGTERM): the CLI sends `bye`, so the relay tears the
  // tunnel down at once instead of waiting for the reconnect grace.
  c.kill("SIGTERM"); await sleep(3000)
  const r2 = await request(`${pathBase}hello`)
  check("sse 503 within 3 s after clean exit", r2.status === 503, `${r2.status}`)
}

// 3. --keep-path
{
  console.log("\n== keep-path ==")
  const c = startConnector(relay, ["--keep-path"], { ANONTUN_TRANSPORT: "ws" })
  const url = await c.url()
  const token = tokenFromUrl(url)
  const pathBase = `${relay}/t/${token}/`
  const r = await request(`${pathBase}echo?k=1`)
  let e = {}; try { e = JSON.parse(r.body.toString()) } catch {}
  check("keep-path forwards /t/<token> prefix", e.path === `/t/${token}/echo?k=1`, `origin saw ${e.path}`)
  c.kill("SIGTERM")
}

// 4. bad token / no tunnel
{
  const r = await request(`${relay}/t/zzzzzzzzzzzz/hello`)
  check("unknown tunnel → 503", r.status === 503, `${r.status}`)
  const r2 = await request(`${relay}/t/not-a-token/`)
  check("bad token → 404", r2.status === 404, `${r2.status}`)
}

// ── summary ────────────────────────────────────────────────────
console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""}`)
origin.close(); wss.close(); fakeProxy?.close()
wrangler?.kill("SIGTERM")
process.exit(failed ? 1 : 0)
