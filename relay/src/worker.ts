// anontun Worker — entry point.
//
// Routes:
//   GET  /                           → tiny landing page with usage instructions
//   GET  /_health                    → "ok"
//   WS   /_connect                   → connector opens this; relay assigns a token
//   GET  /_connect/sse               → connector opens an SSE stream instead of a
//                                      WebSocket; relay assigns a token + secret.
//                                      ?token=&secret= re-attaches to a live tunnel
//   POST /_respond/<token>           → sse connector posts frames back
//                                      (x-anontun-secret header required)
//   *    /t/<token>/<rest>           → proxied to the DO holding that token
//   *    <token>.<TUNNEL_HOST>/<rest> → same, host-based (when TUNNEL_HOST is set)
//
// Connector flow (ws):
//   1. CLI dials wss://anontun.example.com/_connect
//   2. Worker generates a fresh token, idFromName(token), forwards the upgrade
//      to a brand-new TunnelDO with that name.
//   3. DO's onConnect stores the WS, sends a "registered" frame back with the
//      public URL.
//
// Connector flow (sse):
//   1. CLI GETs https://anontun.example.com/_connect/sse
//   2. Worker generates a fresh token, forwards to the DO, which answers with a
//      text/event-stream carrying "registered" (token, url, secret) and then
//      every relay → connector frame as one `data:` event.
//   3. CLI answers with POST /_respond/<token>, one frame per call.
//   4. If the stream drops, CLI reconnects with ?token=&secret= within the
//      DO's grace window; queued frames are flushed on re-attach.
//
// Public flow:
//   1. Anyone hits /t/<token>/<anything>
//   2. Worker parses token, idFromName(token), forwards to that DO.
//   3. DO's onRequest proxies through the connector.

import { TunnelDO } from "./tunnel-do"
import { generateToken, canonicalToken } from "./tokens"
import type { Env } from "./types"

export { TunnelDO }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const pathname = url.pathname
    const base = `${url.protocol}//${url.host}`
    const tunnelHost = (env.TUNNEL_HOST ?? "").toLowerCase().replace(/^\.+|\.+$/g, "")
    const publicUrl = (token: string) => tunnelHost ? `https://${token}.${tunnelHost}/` : `${base}/t/${token}/`

    // Host-based tunnels: <token>.<TUNNEL_HOST>/<path>. Rewritten to the path
    // form and handed to the same DO, so the DO never sees the difference.
    if (tunnelHost && url.hostname !== tunnelHost && url.hostname.endsWith(`.${tunnelHost}`)) {
      const label = url.hostname.slice(0, -(tunnelHost.length + 1))
      const token = canonicalToken(label)
      if (!token) return jsonError("not_found", "bad token format", 404)
      const id = env.TUNNEL.idFromName(token)
      const fwd = new Request(`${base}/t/${token}${pathname}${url.search}`, req)
      return env.TUNNEL.get(id).fetch(fwd)
    }

    if (pathname === "/" || pathname === "") {
      return new Response(LANDING, { headers: { "content-type": "text/html; charset=utf-8" } })
    }

    if (pathname === "/_health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } })
    }

    if (pathname === "/_connect") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return jsonError("bad_request", "expected websocket upgrade (use /_connect/sse for the sse transport)", 400)
      }
      const token = generateToken()
      const id = env.TUNNEL.idFromName(token)
      const fwd = new Request(req.url, req)
      fwd.headers.set("x-anontun-token", token)
      fwd.headers.set("x-anontun-base", base)
      fwd.headers.set("x-anontun-url", publicUrl(token))
      return env.TUNNEL.get(id).fetch(fwd)
    }

    if (pathname === "/_connect/sse") {
      if (req.method !== "GET") return jsonError("method_not_allowed", "GET only", 405)
      const qToken = url.searchParams.get("token")
      const qSecret = url.searchParams.get("secret")
      let token: string
      let reconnect = false
      if (qToken) {
        const t = canonicalToken(qToken)
        if (!t || !qSecret) return jsonError("bad_request", "reconnect needs a valid token and secret", 400)
        token = t
        reconnect = true
      } else {
        token = generateToken()
      }
      const id = env.TUNNEL.idFromName(token)
      const fwd = new Request(req.url, { method: "GET", headers: req.headers, signal: req.signal })
      fwd.headers.set("x-anontun-token", token)
      fwd.headers.set("x-anontun-base", base)
      fwd.headers.set("x-anontun-url", publicUrl(token))
      if (reconnect) fwd.headers.set("x-anontun-reconnect", "1")
      return env.TUNNEL.get(id).fetch(fwd)
    }

    const r = pathname.match(/^\/_respond\/([^/]+)\/?$/)
    if (r) {
      if (req.method !== "POST") return jsonError("method_not_allowed", "POST only", 405)
      const token = canonicalToken(r[1]!)
      if (!token) return jsonError("not_found", "bad token format", 404)
      const id = env.TUNNEL.idFromName(token)
      return env.TUNNEL.get(id).fetch(req)
    }

    const m = pathname.match(/^\/t\/([^/]+)(?:\/|$)/)
    if (m) {
      const token = canonicalToken(m[1]!)
      if (!token) return jsonError("not_found", "bad token format", 404)
      const id = env.TUNNEL.idFromName(token)
      if (token !== m[1]) {
        // Uppercase/mixed-case token in the path: canonicalise so the DO's
        // prefix stripping and the connector's --keep-path prefix agree.
        const fwd = new Request(`${base}/t/${token}${pathname.slice(m[0].length - (m[0].endsWith("/") ? 1 : 0))}${url.search}`, req)
        return env.TUNNEL.get(id).fetch(fwd)
      }
      return env.TUNNEL.get(id).fetch(req)
    }

    return jsonError("not_found", "no route", 404)
  },
} satisfies ExportedHandler<Env>

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

const LANDING = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>anontun</title>
<style>body{font:14px ui-monospace,monospace;max-width:60ch;margin:40px auto;padding:0 20px;background:#0f0f12;color:#e8e8ec}h1{font-size:18px}code{background:#1a1a1f;padding:2px 4px;border-radius:3px}pre{background:#1a1a1f;padding:12px;border-radius:6px;overflow:auto}a{color:#f06}</style>
</head><body>
<h1>anontun</h1>
<p>Anonymous HTTP/WS tunnel. No login. No tokens.</p>
<p>Expose a local port to a public URL:</p>
<pre>npx anontun 3000</pre>
<p>The CLI prints a URL like <code>https://anontun.example.com/t/&lt;token&gt;/</code>. Anything you hit on that URL is proxied to <code>http://localhost:3000</code> on the machine running the CLI. WebSockets supported. Tunnel dies when the CLI exits.</p>
<p>Behind an HTTPS-only proxy that blocks WebSocket upgrades (CI, agent sandboxes)? The CLI falls back to <code>--transport sse</code> automatically.</p>
<p>Source: <a href="https://github.com/repalash/anontun">github</a></p>
</body></html>`
