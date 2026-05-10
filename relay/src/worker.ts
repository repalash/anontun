// anontun Worker — entry point.
//
// Routes:
//   GET  /                           → tiny landing page with usage instructions
//   GET  /_health                    → "ok"
//   WS   /_connect                   → connector opens this; relay assigns a token
//   *    /t/<token>/<rest>           → proxied to the DO holding that token
//
// Connector flow:
//   1. CLI dials wss://anontun.example.com/_connect
//   2. Worker generates a fresh token, idFromName(token), forwards the upgrade
//      to a brand-new TunnelDO with that name.
//   3. DO's onConnect stores the WS, sends a "registered" frame back with the
//      public URL.
//
// Public flow:
//   1. Anyone hits /t/<token>/<anything>
//   2. Worker parses token, idFromName(token), forwards to that DO.
//   3. DO's onRequest proxies through the connector WS.

import { TunnelDO } from "./tunnel-do"
import { generateToken, TOKEN_RE } from "./tokens"
import type { Env } from "./types"

export { TunnelDO }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const pathname = url.pathname

    if (pathname === "/" || pathname === "") {
      return new Response(LANDING, { headers: { "content-type": "text/html; charset=utf-8" } })
    }

    if (pathname === "/_health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } })
    }

    if (pathname === "/_connect") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket upgrade", { status: 400 })
      }
      const token = generateToken()
      const id = env.TUNNEL.idFromName(token)
      const fwd = new Request(req.url, req)
      fwd.headers.set("x-anontun-token", token)
      fwd.headers.set("x-anontun-base", `${url.protocol}//${url.host}`)
      return env.TUNNEL.get(id).fetch(fwd)
    }

    const m = pathname.match(/^\/t\/([^/]+)(?:\/|$)/)
    if (m) {
      const token = m[1]!
      if (!TOKEN_RE.test(token)) return jsonError("not_found", "bad token format", 404)
      const id = env.TUNNEL.idFromName(token)
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
<p>Source: <a href="https://github.com/yourname/anontun">github</a></p>
</body></html>`
