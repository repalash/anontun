// anontun connector. Opens a WS to the relay, handles incoming framed
// HTTP/WS requests by forwarding to the local origin URL.

import { WebSocket } from "ws"
import http from "node:http"
import https from "node:https"
import { URL } from "node:url"

export async function startConnector({ relayBase, originUrl }) {
  const wsBase = relayBase.replace(/^http/, "ws").replace(/\/+$/, "")
  const wsUrl = `${wsBase}/_connect`

  const ws = new WebSocket(wsUrl)
  const upstreamWss = new Map()  // id → upstream WS connections to local origin

  ws.on("open", () => {
    // Server sends 'registered' with our token + URL right after opening.
  })

  ws.on("message", (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (process.env.ANONTUN_DEBUG) console.error(`[anontun] recv: ${msg.type} id=${msg.id ?? ""} ${msg.upgrade ? "(upgrade)" : ""}`)
    switch (msg.type) {
      case "registered":
        console.log(`\n  ${msg.url}\n`)
        console.log(`  → ${originUrl}\n`)
        console.log(`  (Ctrl-C to stop)\n`)
        return
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
        ws.send(JSON.stringify({ type: "pong", id: msg.id }))
        return
    }
  })

  ws.on("close", (code, reason) => {
    console.error(`anontun: ws closed code=${code} reason=${reason?.toString() ?? ""}`)
    process.exit(1)
  })
  ws.on("error", (err) => {
    console.error(`anontun: ws error: ${err.message}`)
    process.exit(1)
  })

  // ── HTTP request handler ─────────────────────────────────────

  function handleHttp(msg) {
    const target = new URL(msg.path, originUrl)
    const lib = target.protocol === "https:" ? https : http
    const headers = { ...msg.headers }
    // Don't forward our own host header — set the local origin's host.
    delete headers.host
    delete headers["content-length"]  // node will recompute

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
    const target = new URL(msg.path, originUrl)
    const targetUrl = `${wsScheme}//${target.host}${target.pathname}${target.search}`

    const upstream = new WebSocket(targetUrl, {
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

  function sendFrame(frame) {
    if (ws.readyState !== WebSocket.OPEN) return
    try { ws.send(JSON.stringify(frame)) } catch {}
  }
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
