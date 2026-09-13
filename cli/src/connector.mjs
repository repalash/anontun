// anontun connector. Attaches to the relay over one of two transports and
// handles incoming framed HTTP/WS requests by forwarding to the local origin.
//
//   ws   — one WebSocket to /_connect (frames both ways)
//   sse  — GET /_connect/sse streams relay → connector frames as Server-Sent
//          Events; connector → relay frames go as POST /_respond/<token>.
//          Plain HTTPS only, so it works behind proxies that refuse WebSocket
//          upgrades (CI runners, agent sandboxes). Reconnects with the token
//          and secret if the stream drops.
//
// `transport: "auto"` tries ws first and falls back to sse if the upgrade is
// refused before the relay registers the tunnel.

import { WebSocket } from "ws"
import http from "node:http"
import https from "node:https"
import { URL } from "node:url"
import { ConnectProxyAgent, proxyUrlFor } from "./proxy-agent.mjs"

const SSE_RECONNECT_ATTEMPTS = 10
const SSE_RECONNECT_DELAY_MS = 1000

// keepPath: forward the public path with its /t/<token> prefix intact instead
// of stripped. Needed for apps that must be served under that prefix — e.g. a
// Vite dev server started with base=/t/<token>/ — otherwise the origin sees
// "/" and redirects to its base, which loops back through the relay.
export async function startConnector({ relayBase, originUrl, transport = "auto", keepPath = false }) {
  relayBase = relayBase.replace(/\/+$/, "")

  if (transport === "ws" || transport === "auto") {
    try {
      await runWsTransport({ relayBase, originUrl, keepPath })
      return
    } catch (e) {
      if (transport === "ws") throw e
      console.error(`anontun: websocket transport failed (${e?.message ?? e}); falling back to sse`)
    }
  }
  await runSseTransport({ relayBase, originUrl, keepPath })
}

// ── ws transport ───────────────────────────────────────────────

function runWsTransport({ relayBase, originUrl, keepPath }) {
  const wsBase = relayBase.replace(/^http/, "ws")
  const wsUrl = `${wsBase}/_connect`

  return new Promise((resolve, reject) => {
    // The `ws` package ignores HTTPS_PROXY; tunnel the relay socket through
    // the proxy with a CONNECT agent when one is configured.
    const wsOpts = {}
    const proxyUrl = wsUrl.startsWith("wss:") ? proxyUrlFor(relayBase) : null
    if (proxyUrl) {
      wsOpts.agent = new ConnectProxyAgent(proxyUrl)
      if (process.env.ANONTUN_DEBUG) console.error(`[anontun] relay via proxy ${new URL(proxyUrl).host}`)
    }
    const ws = new WebSocket(wsUrl, wsOpts)
    let registered = false

    const origin = createOriginBridge(originUrl, keepPath, (frame) => {
      if (ws.readyState !== WebSocket.OPEN) return
      try { ws.send(JSON.stringify(frame)) } catch {}
    })

    ws.on("message", (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.type === "registered") {
        origin.setToken(msg.token)
        if (!registered) {
          registered = true
          printRegistered(msg.url, originUrl, "ws")
          resolve()
        }
        return
      }
      origin.handleFrame(msg)
    })

    ws.on("close", (code, reason) => {
      if (!registered) {
        reject(new Error(`ws closed before register code=${code} reason=${reason?.toString() ?? ""}`))
        return
      }
      console.error(`anontun: ws closed code=${code} reason=${reason?.toString() ?? ""}`)
      process.exit(1)
    })
    ws.on("error", (err) => {
      if (!registered) {
        reject(new Error(`ws error: ${err.message}`))
        return
      }
      console.error(`anontun: ws error: ${err.message}`)
      process.exit(1)
    })
  })
}

// ── sse transport ──────────────────────────────────────────────

async function runSseTransport({ relayBase, originUrl, keepPath }) {
  let token = null
  let secret = null
  let announced = false

  // Frames that belong to one WS stream must arrive in order, so POSTs are
  // chained per id. HTTP responses (one per id) go out in parallel.
  const chains = new Map()
  const post = async (frame) => {
    const res = await fetch(`${relayBase}/_respond/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-anontun-secret": secret },
      body: JSON.stringify(frame),
    })
    if (res.status === 403 || res.status === 404) {
      throw new Error(`relay rejected frame (${res.status}); tunnel is gone`)
    }
    if (!res.ok) console.error(`anontun: /_respond returned ${res.status}`)
  }
  const send = (frame) => {
    if (!token || !secret) return
    const prev = chains.get(frame.id) ?? Promise.resolve()
    const next = prev.then(() => post(frame)).catch((e) => {
      console.error(`anontun: ${e.message}`)
      if (/tunnel is gone/.test(e.message)) process.exit(1)
    })
    chains.set(frame.id, next)
    next.then(() => { if (chains.get(frame.id) === next) chains.delete(frame.id) })
  }

  const origin = createOriginBridge(originUrl, keepPath, send)

  for (let attempt = 0; ; attempt++) {
    const url = token
      ? `${relayBase}/_connect/sse?token=${encodeURIComponent(token)}&secret=${encodeURIComponent(secret)}`
      : `${relayBase}/_connect/sse`
    let res
    try {
      res = await fetch(url, { headers: { accept: "text/event-stream" } })
    } catch (e) {
      if (attempt >= SSE_RECONNECT_ATTEMPTS) throw new Error(`sse connect failed: ${e.message}`)
      await sleep(SSE_RECONNECT_DELAY_MS)
      continue
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      // 403/409 mean the tunnel is gone or taken; a fresh token will not help either.
      throw new Error(`relay answered ${res.status} on /_connect/sse: ${text.slice(0, 200)}`)
    }
    if (!/text\/event-stream/.test(res.headers.get("content-type") ?? "")) {
      throw new Error(`relay did not open an event stream (content-type ${res.headers.get("content-type")})`)
    }

    attempt = 0
    let dropReason = "stream ended"
    try {
      await readSse(res.body, (msg) => {
        if (msg.type === "registered") {
          token = msg.token
          secret = msg.secret
          origin.setToken(token)
          if (!announced) { announced = true; printRegistered(msg.url, originUrl, "sse") }
          return
        }
        origin.handleFrame(msg)
      })
    } catch (e) {
      // An abrupt socket close surfaces as a read error ("terminated",
      // ECONNRESET), not as a clean end of stream. Treat both as a drop.
      dropReason = e?.message ?? String(e)
      if (!token) throw new Error(`sse stream failed before the relay registered the tunnel: ${dropReason}`)
    }

    if (!token) throw new Error("sse stream ended before the relay registered the tunnel")
    console.error(`anontun: sse stream dropped (${dropReason}); reconnecting`)
    await sleep(SSE_RECONNECT_DELAY_MS)
  }
}

// Parse a text/event-stream body; calls onEvent with each JSON `data:` payload.
async function readSse(body, onEvent) {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n")
      if (!data) continue  // comment / keepalive
      let msg
      try { msg = JSON.parse(data) } catch { continue }
      if (process.env.ANONTUN_DEBUG) console.error(`[anontun] recv: ${msg.type} id=${msg.id ?? ""} ${msg.upgrade ? "(upgrade)" : ""}`)
      onEvent(msg)
    }
  }
}

// ── origin bridge (shared by both transports) ──────────────────
//
// Turns relay frames into requests against the local origin and hands the
// answers to `sendFrame`.

function createOriginBridge(originUrl, keepPath, sendFrame) {
  const upstreamWss = new Map()  // id → upstream WS connections to local origin
  let pathPrefix = ""            // "/t/<token>" when keepPath, set on register

  function setToken(token) {
    if (keepPath) pathPrefix = `/t/${token}`
  }

  function handleFrame(msg) {
    if (process.env.ANONTUN_DEBUG) console.error(`[anontun] frame: ${msg.type} id=${msg.id ?? ""} ${msg.upgrade ? "(upgrade)" : ""}`)
    switch (msg.type) {
      case "req_open":
        if (msg.upgrade) handleUpgrade(msg)
        else handleHttp(msg)
        return
      case "ws_frame":
        forwardWsFrame(msg)
        return
      case "ws_close":
        closeUpstreamWs(msg.id, msg.code, msg.reason)
        return
      case "ping":
        sendFrame({ type: "pong", id: msg.id })
        return
    }
  }

  // ── HTTP request handler ─────────────────────────────────────

  function handleHttp(msg) {
    const target = new URL(pathPrefix + msg.path, originUrl)
    const lib = target.protocol === "https:" ? https : http
    const headers = { ...msg.headers }
    // Don't forward our own host header — set the local origin's host.
    delete headers.host
    delete headers["content-length"]  // node will recompute
    // Force the local origin to return UNcompressed bytes. CF Workers'
    // Response constructor strips content-encoding from raw byte responses,
    // so if upstream sends gzip, the relay would forward compressed bytes
    // without the encoding header — clients then can't decode. Asking for
    // identity makes the body plain; CF re-encodes on the way out and sets
    // Content-Encoding correctly.
    headers["accept-encoding"] = "identity"

    const body = msg.body_b64 ? Buffer.from(msg.body_b64, "base64") : Buffer.alloc(0)

    const reqOpts = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: msg.method,
      path: target.pathname + target.search,
      headers,
    }
    const req = lib.request(reqOpts, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => {
        const respBody = Buffer.concat(chunks)
        const respHeaders = {}
        for (const [k, v] of Object.entries(res.headers)) {
          respHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "")
        }
        sendFrame({
          type: "res_open",
          id: msg.id,
          status: res.statusCode ?? 502,
          headers: respHeaders,
          body_b64: respBody.toString("base64"),
        })
      })
    })
    req.on("error", (err) => {
      sendFrame({
        type: "res_open",
        id: msg.id,
        status: 502,
        headers: { "content-type": "application/json" },
        body_b64: Buffer.from(JSON.stringify({ error: { code: "origin_unreachable", message: err.message } })).toString("base64"),
      })
    })
    if (body.length > 0) req.write(body)
    req.end()
  }

  // ── WebSocket upgrade handler ─────────────────────────────────

  function handleUpgrade(msg) {
    const wsScheme = originUrl.startsWith("https:") ? "wss:" : "ws:"
    const target = new URL(pathPrefix + msg.path, originUrl)
    const targetUrl = `${wsScheme}//${target.host}${target.pathname}${target.search}`

    // Forward the requested subprotocols (e.g. Vite's HMR client sends
    // `vite-hmr`; the dev server ignores upgrades without it). The `ws`
    // client emits the header itself, so it is stripped from the passthrough
    // set and re-supplied here as the protocols argument.
    const protocols = (msg.headers?.["sec-websocket-protocol"] ?? "")
      .split(",").map((p) => p.trim()).filter(Boolean)
    const upstream = new WebSocket(targetUrl, protocols, {
      headers: stripHopByHop(msg.headers),
    })
    upstream.binaryType = "arraybuffer"

    // Capture the 101's response headers when they arrive...
    let respHeaders = {}
    upstream.on("upgrade", (res) => {
      for (const [k, v] of Object.entries(res.headers)) {
        respHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "")
      }
    })
    // ...but DEFER sending res_open (and thus the public client's 101)
    // until the upstream is fully OPEN. Otherwise the public client sees
    // 101 and starts sending frames immediately, and forwardWsFrame()
    // drops them because upstream.readyState is still CONNECTING.
    upstream.on("open", () => {
      sendFrame({
        type: "res_open",
        id: msg.id,
        status: 101,
        headers: respHeaders,
      })
      upstreamWss.set(msg.id, upstream)
    })
    upstream.on("message", (data, isBinary) => {
      let bytes
      if (typeof data === "string") bytes = Buffer.from(data)
      else if (data instanceof ArrayBuffer) bytes = Buffer.from(data)
      else bytes = data
      sendFrame({
        type: "ws_frame",
        id: msg.id,
        data_b64: bytes.toString("base64"),
        binary: !!isBinary,
      })
    })
    upstream.on("close", (code, reason) => {
      upstreamWss.delete(msg.id)
      sendFrame({ type: "ws_close", id: msg.id, code, reason: reason?.toString() })
    })
    upstream.on("error", (err) => {
      // Best-effort: report failure as a non-101 res_open if no upgrade ever fired
      if (upstream.readyState !== WebSocket.OPEN) {
        sendFrame({
          type: "res_open",
          id: msg.id,
          status: 502,
          headers: { "content-type": "application/json" },
          body_b64: Buffer.from(JSON.stringify({ error: { code: "ws_origin_error", message: err.message } })).toString("base64"),
        })
      }
    })
  }

  function forwardWsFrame(msg) {
    const upstream = upstreamWss.get(msg.id)
    if (process.env.ANONTUN_DEBUG) console.error(`[anontun] forwardWsFrame id=${msg.id} upstream=${upstream ? "yes" : "no"} readyState=${upstream?.readyState}`)
    if (!upstream || upstream.readyState !== WebSocket.OPEN) return
    const data = Buffer.from(msg.data_b64, "base64")
    if (msg.binary) upstream.send(data, { binary: true })
    else upstream.send(data.toString("utf8"), { binary: false })
  }

  function closeUpstreamWs(id, code, reason) {
    const upstream = upstreamWss.get(id)
    if (!upstream) return
    try { upstream.close(code ?? 1000, reason ?? "") } catch {}
    upstreamWss.delete(id)
  }

  return { handleFrame, setToken }
}

function printRegistered(url, originUrl, transport) {
  console.log(`\n  ${url}\n`)
  console.log(`  → ${originUrl}  (${transport})\n`)
  console.log(`  (Ctrl-C to stop)\n`)
}

function stripHopByHop(headers) {
  const out = {}
  const skip = new Set(["host", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"])
  for (const [k, v] of Object.entries(headers || {})) {
    if (skip.has(k.toLowerCase())) continue
    out[k] = v
  }
  return out
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
