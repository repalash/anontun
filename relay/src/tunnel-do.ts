// TunnelDO — one DO per active tunnel. Holds the connector (a WebSocket, or
// an SSE stream plus POST-backs) and proxies public HTTP/WS to it via
// id-correlated frames.

import { Server, type Connection } from "partyserver"
import type { Env, Frame, ReqOpenFrame, ResOpenFrame, WsFrameFrame, WsCloseFrame } from "./types"

const MAX_BODY_BYTES = 10 * 1024 * 1024  // 10 MB
const REQUEST_TIMEOUT_MS = 30_000
// sse: comment line written this often so idle proxies keep the stream open
const SSE_KEEPALIVE_MS = 15_000
// sse: how long a dropped stream may stay detached before the tunnel is torn down
const SSE_RECONNECT_GRACE_MS = 20_000
// sse: frames buffered while detached; beyond this the tunnel is torn down
const SSE_MAX_QUEUED_FRAMES = 500

type Pending =
  | { kind: "http"; resolve: (r: Response) => void; timer: ReturnType<typeof setTimeout> }
  | { kind: "upgrade"; resolve: (info: { ok: boolean; status?: number; headers?: Record<string, string>; error?: string }) => void; timer: ReturnType<typeof setTimeout> }

interface ActiveWs {
  publicWs: WebSocket
}

type Connector =
  | { kind: "ws"; c: Connection }
  | {
      kind: "sse"
      secret: string
      writer: WritableStreamDefaultWriter<Uint8Array> | null
      queue: string[]
      keepalive: ReturnType<typeof setInterval> | null
      grace: ReturnType<typeof setTimeout> | null
    }

export class TunnelDO extends Server<Env> {
  static options = { hibernate: false }

  connector: Connector | null = null
  token: string | null = null
  pending: Map<string, Pending> = new Map()
  activeWs: Map<string, ActiveWs> = new Map()

  // ── WS upgrade lifecycle (both connector and public side) ──────
  //
  // PartyServer's Server.fetch routes ALL WebSocket upgrades to onConnect,
  // so we have to distinguish here based on the URL path:
  //   /_connect            → the connector (origin-side, holds the tunnel)
  //   /t/<token>/<rest>    → a public client opening a WS through the tunnel

  // Public-side WebSocket upgrades bypass PartyServer's onConnect and are
  // answered by handleWsUpgrade with our own WebSocketPair. PartyServer
  // sends the 101 itself, before onConnect runs, so there is no way to echo
  // the client's requested subprotocol (Sec-WebSocket-Protocol) on that
  // path — and browsers drop a WebSocket whose 101 does not echo it (Vite's
  // HMR client is the common case). Only the connector's /_connect upgrade
  // still goes through PartyServer.
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname.startsWith("/t/") && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.onRequest(req)
    }
    return super.fetch(req)
  }

  async onConnect(c: Connection, ctx: { request: Request }): Promise<void> {
    const url = new URL(ctx.request.url)
    if (url.pathname === "/_connect") {
      this.handleConnectorOpen(c, ctx.request)
    } else if (url.pathname.startsWith("/t/")) {
      // MUST await: PartyServer holds the 101 response until onConnect resolves.
      // If we fire-and-forget here, the public client gets 101 immediately and
      // its first frame (e.g. a `register` from a wrapped agent-socket WS)
      // arrives before our addEventListener("message", ...) is attached, and
      // is silently consumed by PartyServer's onMessage filter.
      await this.handlePublicWsOpen(c, ctx.request)
    } else {
      c.close(4404, "unknown ws path")
    }
  }

  private handleConnectorOpen(c: Connection, req: Request): void {
    if (this.connector) {
      c.close(4409, "tunnel already has a connector")
      return
    }
    const token = req.headers.get("x-anontun-token")
    if (!token) {
      c.close(4500, "missing token header")
      return
    }
    const base = req.headers.get("x-anontun-base") ?? ""
    const url = req.headers.get("x-anontun-url") ?? `${base}/t/${token}/`
    this.token = token
    this.connector = { kind: "ws", c }
    c.send(JSON.stringify({ type: "registered", token, url }))
  }

  private async handlePublicWsOpen(publicWs: Connection, req: Request): Promise<void> {
    if (!this.connector) {
      publicWs.close(4503, "connector_offline")
      return
    }
    const url = new URL(req.url)
    const m = url.pathname.match(/^\/t\/[^/]+(\/.*)?$/)
    const innerPath = (m?.[1] ?? "/") + url.search

    const headers: Record<string, string> = {}
    for (const [k, v] of req.headers.entries()) headers[k] = v

    const id = crypto.randomUUID()
    const handshake = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: "upstream_timeout" })
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        kind: "upgrade",
        timer,
        resolve: (r) => resolve({ ok: r.ok, error: r.error }),
      })
    })

    const sent = this.send({
      type: "req_open", id,
      method: "GET", path: innerPath, headers,
      body_b64: "",
      upgrade: true,
    })
    if (!sent) {
      this.pending.delete(id)
      publicWs.close(4503, "connector_offline")
      return
    }

    const result = await handshake
    if (!result.ok) {
      publicWs.close(4502, result.error ?? "upstream_error")
      return
    }

    // Connector accepted the upgrade. Pipe public WS ↔ connector frames.
    this.activeWs.set(id, { publicWs: publicWs as unknown as WebSocket })

    publicWs.addEventListener("message", (ev: MessageEvent) => {
      const data = ev.data
      let bytes: Uint8Array
      let binary: boolean
      if (typeof data === "string") {
        bytes = new TextEncoder().encode(data); binary = false
      } else {
        bytes = new Uint8Array(data as ArrayBuffer); binary = true
      }
      this.send({ type: "ws_frame", id, data_b64: base64Encode(bytes), binary })
    })
    publicWs.addEventListener("close", (ev: CloseEvent) => {
      this.activeWs.delete(id)
      this.send({ type: "ws_close", id, code: ev.code, reason: ev.reason })
    })
    publicWs.addEventListener("error", () => {
      this.activeWs.delete(id)
      this.send({ type: "ws_close", id })
    })
  }

  onClose(c: Connection): void {
    if (this.connector?.kind !== "ws" || c !== this.connector.c) {
      // A public-side WS closed. The per-connection close listener in
      // handlePublicWsOpen sends the ws_close frame; nothing else to do.
      return
    }
    // The connector dropped. Tear everything down.
    this.teardownConnector()
  }

  private teardownConnector(): void {
    if (this.connector?.kind === "sse") {
      if (this.connector.keepalive) clearInterval(this.connector.keepalive)
      if (this.connector.grace) clearTimeout(this.connector.grace)
      const w = this.connector.writer
      this.connector.writer = null
      if (w) w.close().catch(() => {})
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      if (p.kind === "http") p.resolve(jsonError("connector_offline", "connector dropped", 503))
      else p.resolve({ ok: false, error: "connector_offline" })
    }
    this.pending.clear()
    for (const a of this.activeWs.values()) {
      try { a.publicWs.close(1011, "connector dropped") } catch {}
    }
    this.activeWs.clear()
    this.connector = null
  }

  // ── SSE connector transport ─────────────────────────────────────
  //
  // Relay → connector: text/event-stream, one `data: <frame json>` event per
  // frame, a comment line every SSE_KEEPALIVE_MS.
  // Connector → relay: POST /_respond/<token> with x-anontun-secret.
  // A dropped stream leaves the tunnel in a detached state for
  // SSE_RECONNECT_GRACE_MS; frames queue up and flush when the connector
  // re-attaches with ?token=&secret=.

  private handleConnectorSseOpen(req: Request): Response {
    const token = req.headers.get("x-anontun-token")
    if (!token) return jsonError("bad_request", "missing token header", 400)
    const base = req.headers.get("x-anontun-base") ?? ""
    const publicUrl = req.headers.get("x-anontun-url") ?? `${base}/t/${token}/`
    const reconnect = req.headers.get("x-anontun-reconnect") === "1"
    const url = new URL(req.url)

    if (this.connector?.kind === "ws") {
      return jsonError("conflict", "tunnel already has a websocket connector", 409)
    }

    let conn: Extract<Connector, { kind: "sse" }>
    if (reconnect) {
      const secret = url.searchParams.get("secret") ?? ""
      if (!this.connector || this.token !== token || !timingSafeEqual(secret, this.connector.secret)) {
        return jsonError("forbidden", "unknown tunnel or bad secret", 403)
      }
      conn = this.connector
      // Replace a stream that is still attached (e.g. the old one is half-dead).
      if (conn.writer) { const w = conn.writer; conn.writer = null; w.close().catch(() => {}) }
      if (conn.keepalive) { clearInterval(conn.keepalive); conn.keepalive = null }
      if (conn.grace) { clearTimeout(conn.grace); conn.grace = null }
    } else {
      if (this.connector) return jsonError("conflict", "tunnel already has a connector", 409)
      conn = { kind: "sse", secret: generateSecret(), writer: null, queue: [], keepalive: null, grace: null }
      this.token = token
      this.connector = conn
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    conn.writer = writer

    const detach = () => this.onSseDetached(conn, writer)
    writer.closed.then(detach, detach)
    req.signal?.addEventListener("abort", detach)

    const enc = new TextEncoder()
    const write = (s: string) => writer.write(enc.encode(s)).catch(detach)

    write(`: anontun sse\n\n`)
    write(`data: ${JSON.stringify({ type: "registered", token, url: publicUrl, secret: conn.secret })}\n\n`)
    for (const f of conn.queue.splice(0)) write(`data: ${f}\n\n`)
    conn.keepalive = setInterval(() => { write(`: keepalive\n\n`) }, SSE_KEEPALIVE_MS)

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    })
  }

  private onSseDetached(conn: Extract<Connector, { kind: "sse" }>, writer: WritableStreamDefaultWriter<Uint8Array>): void {
    // Ignore callbacks from a stream that has already been replaced.
    if (this.connector !== conn || conn.writer !== writer) return
    conn.writer = null
    writer.close().catch(() => {})
    if (conn.keepalive) { clearInterval(conn.keepalive); conn.keepalive = null }
    if (conn.grace) clearTimeout(conn.grace)
    conn.grace = setTimeout(() => {
      if (this.connector === conn && !conn.writer) this.teardownConnector()
    }, SSE_RECONNECT_GRACE_MS)
  }

  private async handleRespond(req: Request): Promise<Response> {
    const conn = this.connector
    if (!conn || conn.kind !== "sse") return jsonError("not_found", "no sse tunnel", 404)
    const secret = req.headers.get("x-anontun-secret") ?? ""
    if (!timingSafeEqual(secret, conn.secret)) return jsonError("forbidden", "bad secret", 403)

    let parsed: unknown
    try { parsed = await req.json() } catch { return jsonError("bad_request", "body must be a JSON frame or array of frames", 400) }
    const frames = Array.isArray(parsed) ? parsed : [parsed]
    for (const f of frames) {
      if (f && typeof f === "object" && typeof (f as Frame).type === "string") this.handleConnectorFrame(f as Frame)
    }
    return new Response(null, { status: 204 })
  }

  // ── Connector → relay frames ────────────────────────────────────

  onMessage(c: Connection, raw: string | ArrayBuffer): void {
    // Only frames from the connector are control frames. Public-side WS
    // messages are forwarded to the connector via the addEventListener
    // wired up in handlePublicWsOpen — they don't go through this method's
    // handlers. Ignore them here so they don't accidentally get parsed as JSON.
    if (this.connector?.kind !== "ws" || c !== this.connector.c) return

    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
    let msg: Frame
    try { msg = JSON.parse(text) as Frame } catch { return }
    this.handleConnectorFrame(msg)
  }

  private handleConnectorFrame(msg: Frame): void {
    switch (msg.type) {
      case "res_open": this.handleResOpen(msg); return
      case "ws_frame": this.handleWsFrame(msg); return
      case "ws_close": this.handleWsClose(msg); return
      case "ping":     this.send({ type: "pong", id: msg.id }); return
      case "pong":     return
      case "bye":      this.teardownConnector(); return
      default:         return
    }
  }

  private handleResOpen(msg: ResOpenFrame): void {
    const p = this.pending.get(msg.id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(msg.id)

    if (p.kind === "upgrade") {
      if (msg.status === 101) {
        p.resolve({ ok: true, status: msg.status, headers: msg.headers })
      } else {
        p.resolve({ ok: false, status: msg.status, headers: msg.headers, error: `upstream_status_${msg.status}` })
      }
      return
    }
    // kind === "http"
    const body = msg.body_b64 ? base64Decode(msg.body_b64) : new Uint8Array(0)
    const respHeaders = new Headers()
    for (const [k, v] of Object.entries(msg.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue
      respHeaders.set(k, v)
    }
    p.resolve(new Response(body, { status: msg.status, headers: respHeaders }))
  }

  private handleWsFrame(msg: WsFrameFrame): void {
    const a = this.activeWs.get(msg.id)
    if (!a) return
    const data = base64Decode(msg.data_b64)
    try {
      if (msg.binary) a.publicWs.send(data)
      else a.publicWs.send(new TextDecoder().decode(data))
    } catch {}
  }

  private handleWsClose(msg: WsCloseFrame): void {
    const a = this.activeWs.get(msg.id)
    if (!a) return
    try { a.publicWs.close(msg.code ?? 1000, msg.reason) } catch {}
    this.activeWs.delete(msg.id)
  }

  // ── Public-side entry ──────────────────────────────────────────

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // Connector-side, non-WebSocket endpoints (sse transport).
    if (url.pathname === "/_connect/sse") return this.handleConnectorSseOpen(req)
    if (url.pathname.startsWith("/_respond/")) return this.handleRespond(req)

    if (!this.connector) {
      return jsonError("connector_offline", "no live connector", 503)
    }

    const m = url.pathname.match(/^\/t\/[^/]+(\/.*)?$/)
    const innerPath = (m?.[1] ?? "/") + url.search

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleWsUpgrade(req, innerPath)
    }

    return this.handleHttp(req, innerPath)
  }

  private async handleHttp(req: Request, innerPath: string): Promise<Response> {
    let bodyBytes = new Uint8Array(0)
    try {
      const buf = await req.arrayBuffer()
      bodyBytes = new Uint8Array(buf)
      if (bodyBytes.byteLength > MAX_BODY_BYTES) {
        return jsonError("body_too_large", `max ${MAX_BODY_BYTES} bytes`, 413)
      }
    } catch {}

    const headers: Record<string, string> = {}
    for (const [k, v] of req.headers.entries()) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue
      headers[k] = v
    }

    const id = crypto.randomUUID()
    const promise = new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(jsonError("upstream_timeout", `connector silent for ${REQUEST_TIMEOUT_MS}ms`, 504))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { kind: "http", resolve, timer })
    })

    const ok = this.send({
      type: "req_open", id,
      method: req.method, path: innerPath, headers,
      body_b64: base64Encode(bodyBytes),
      upgrade: false,
    })
    if (!ok) {
      const p = this.pending.get(id)
      if (p) { clearTimeout(p.timer); this.pending.delete(id) }
      return jsonError("connector_offline", "connector send failed", 503)
    }
    return promise
  }

  private async handleWsUpgrade(req: Request, innerPath: string): Promise<Response> {
    const headers: Record<string, string> = {}
    for (const [k, v] of req.headers.entries()) headers[k] = v

    const id = crypto.randomUUID()
    const handshake = new Promise<{ ok: boolean; status?: number; headers?: Record<string, string>; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: "upstream_timeout" })
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { kind: "upgrade", resolve, timer })
    })

    const ok = this.send({
      type: "req_open", id,
      method: "GET", path: innerPath, headers,
      body_b64: "",
      upgrade: true,
    })
    if (!ok) {
      this.pending.delete(id)
      return jsonError("connector_offline", "connector send failed", 503)
    }

    const result = await handshake
    if (!result.ok) {
      return jsonError(result.error ?? "upstream_error", "upstream rejected upgrade", 502)
    }

    // Accept the public-side WebSocket
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    server.accept()
    this.activeWs.set(id, { publicWs: server })

    server.addEventListener("message", (ev) => {
      const data = ev.data
      let bytes: Uint8Array
      let binary: boolean
      if (typeof data === "string") {
        bytes = new TextEncoder().encode(data); binary = false
      } else {
        bytes = new Uint8Array(data as ArrayBuffer); binary = true
      }
      this.send({ type: "ws_frame", id, data_b64: base64Encode(bytes), binary })
    })
    server.addEventListener("close", (ev) => {
      this.activeWs.delete(id)
      this.send({ type: "ws_close", id, code: ev.code, reason: ev.reason })
      // Complete the closing handshake towards the public client; the runtime
      // does not echo the close frame by itself, and `ws` clients otherwise
      // wait ~30 s before giving up.
      try { server.close(ev.code, ev.reason) } catch {}
    })
    server.addEventListener("error", () => {
      this.activeWs.delete(id)
      this.send({ type: "ws_close", id })
    })

    // Echo the subprotocol the local origin negotiated, if any.
    const respHeaders = new Headers()
    const proto = result.headers?.["sec-websocket-protocol"]
    if (proto) respHeaders.set("sec-websocket-protocol", proto)
    return new Response(null, { status: 101, headers: respHeaders, webSocket: client } as ResponseInit & { webSocket: WebSocket })
  }

  private send(frame: Frame): boolean {
    const conn = this.connector
    if (!conn) return false
    const json = JSON.stringify(frame)
    if (conn.kind === "ws") {
      try { conn.c.send(json); return true }
      catch { return false }
    }
    if (conn.writer) {
      const w = conn.writer
      w.write(new TextEncoder().encode(`data: ${json}\n\n`)).catch(() => this.onSseDetached(conn, w))
      return true
    }
    // Detached (stream dropped, connector may re-attach within the grace window).
    if (conn.queue.length >= SSE_MAX_QUEUED_FRAMES) {
      this.teardownConnector()
      return false
    }
    conn.queue.push(json)
    return true
  }
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
])

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function base64Encode(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s)
}

function base64Decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
