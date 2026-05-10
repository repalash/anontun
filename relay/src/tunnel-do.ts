// TunnelDO — one DO per active tunnel. Holds the connector's WebSocket and
// proxies public HTTP/WS to it via id-correlated frames.

import { Server, type Connection } from "partyserver"
import type { Env, Frame, ReqOpenFrame, ResOpenFrame, WsFrameFrame, WsCloseFrame } from "./types"

const MAX_BODY_BYTES = 10 * 1024 * 1024  // 10 MB
const REQUEST_TIMEOUT_MS = 30_000

type Pending =
  | { kind: "http"; resolve: (r: Response) => void; timer: ReturnType<typeof setTimeout> }
  | { kind: "upgrade"; resolve: (info: { ok: boolean; status?: number; headers?: Record<string, string>; error?: string }) => void; timer: ReturnType<typeof setTimeout> }

interface ActiveWs {
  publicWs: WebSocket
}

export class TunnelDO extends Server<Env> {
  static options = { hibernate: false }

  connectorWs: Connection | null = null
  token: string | null = null
  pending: Map<string, Pending> = new Map()
  activeWs: Map<string, ActiveWs> = new Map()

  // ── WS upgrade lifecycle (both connector and public side) ──────
  //
  // PartyServer's Server.fetch routes ALL WebSocket upgrades to onConnect,
  // so we have to distinguish here based on the URL path:
  //   /_connect            → the connector (origin-side, holds the tunnel)
  //   /t/<token>/<rest>    → a public client opening a WS through the tunnel

  onConnect(c: Connection, ctx: { request: Request }): void {
    const url = new URL(ctx.request.url)
    if (url.pathname === "/_connect") {
      this.handleConnectorOpen(c, ctx.request)
    } else if (url.pathname.startsWith("/t/")) {
      void this.handlePublicWsOpen(c, ctx.request)
    } else {
      c.close(4404, "unknown ws path")
    }
  }

  private handleConnectorOpen(c: Connection, req: Request): void {
    if (this.connectorWs) {
      c.close(4409, "tunnel already has a connector")
      return
    }
    const token = req.headers.get("x-anontun-token")
    if (!token) {
      c.close(4500, "missing token header")
      return
    }
    const base = req.headers.get("x-anontun-base") ?? ""
    this.token = token
    this.connectorWs = c
    c.send(JSON.stringify({ type: "registered", token, url: `${base}/t/${token}/` }))
  }

  private async handlePublicWsOpen(publicWs: Connection, req: Request): Promise<void> {
    if (!this.connectorWs) {
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
    if (c !== this.connectorWs) {
      // A public-side WS closed. The per-connection close listener in
      // handlePublicWsOpen sends the ws_close frame; nothing else to do.
      return
    }
    // The connector dropped. Tear everything down.
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
    this.connectorWs = null
  }

  // ── Connector → relay frames ────────────────────────────────────

  onMessage(c: Connection, raw: string | ArrayBuffer): void {
    // Only frames from the connector are control frames. Public-side WS
    // messages are forwarded to the connector via the addEventListener
    // wired up in handlePublicWsOpen — they don't go through this method's
    // handlers. Ignore them here so they don't accidentally get parsed as JSON.
    if (c !== this.connectorWs) return

    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
    let msg: Frame
    try { msg = JSON.parse(text) as Frame } catch { return }

    switch (msg.type) {
      case "res_open": this.handleResOpen(msg); return
      case "ws_frame": this.handleWsFrame(msg); return
      case "ws_close": this.handleWsClose(msg); return
      case "ping":     this.send({ type: "pong", id: msg.id }); return
      case "pong":     return
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
    if (!this.connectorWs) {
      return jsonError("connector_offline", "no live connector", 503)
    }

    const url = new URL(req.url)
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
      return jsonError("connector_offline", "ws send failed", 503)
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
      return jsonError("connector_offline", "ws send failed", 503)
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
    })
    server.addEventListener("error", () => {
      this.activeWs.delete(id)
      this.send({ type: "ws_close", id })
    })

    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket })
  }

  private send(frame: Frame): boolean {
    if (!this.connectorWs) return false
    try { this.connectorWs.send(JSON.stringify(frame)); return true }
    catch { return false }
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
