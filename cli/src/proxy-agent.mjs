// Minimal HTTP CONNECT proxy agent for the connector's relay WebSocket.
//
// Sandboxed environments (CI runners, Claude Code cloud sessions, corporate
// laptops) often have no direct egress: every outbound HTTPS connection has
// to go through an HTTP proxy named by HTTPS_PROXY / https_proxy. The `ws`
// package does not read those variables, so without this the connector
// dials the relay directly and times out.
//
// Zero dependencies on purpose: extends https.Agent and swaps its
// createConnection for "CONNECT host:443 via proxy, then TLS on top".
// Node's default CA store already honours NODE_EXTRA_CA_CERTS, which is how
// re-terminating proxies publish their CA, so no explicit `ca` is needed.

import http from "node:http"
import https from "node:https"
import tls from "node:tls"
import net from "node:net"

export function proxyUrlFor(targetUrl, env = process.env) {
  const target = new URL(targetUrl)
  if (env.ANONTUN_NO_PROXY === "1") return null
  const explicit = env.ANONTUN_PROXY
  const fromEnv = explicit ?? env.HTTPS_PROXY ?? env.https_proxy ?? null
  if (!fromEnv) return null
  if (!explicit && isNoProxy(target.hostname, env.NO_PROXY ?? env.no_proxy ?? "")) return null
  return fromEnv
}

function isNoProxy(hostname, list) {
  const h = hostname.toLowerCase()
  for (let entry of list.split(",")) {
    entry = entry.trim().toLowerCase()
    if (!entry) continue
    if (entry === "*") return true
    if (entry.startsWith("*")) entry = entry.slice(1)
    if (entry.startsWith(".")) { if (h.endsWith(entry) || h === entry.slice(1)) return true; continue }
    if (h === entry || h.endsWith("." + entry)) return true
  }
  return false
}

export class ConnectProxyAgent extends https.Agent {
  constructor(proxyUrl, opts = {}) {
    super({ keepAlive: false, ...opts })
    this.proxy = new URL(proxyUrl)
  }

  createConnection(options, cb) {
    const host = options.host ?? options.hostname
    const port = Number(options.port) || 443
    const headers = { host: `${host}:${port}` }
    if (this.proxy.username) {
      const cred = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`
      headers["proxy-authorization"] = `Basic ${Buffer.from(cred).toString("base64")}`
    }
    const req = http.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port) || (this.proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
      agent: false,
      createConnection: this.proxy.protocol === "https:"
        ? () => tls.connect({ host: this.proxy.hostname, port: Number(this.proxy.port) || 443, servername: this.proxy.hostname })
        : undefined,
    })
    req.once("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        cb(new Error(`proxy ${this.proxy.host} refused CONNECT ${host}:${port}: HTTP ${res.statusCode}`))
        return
      }
      if (head?.length) socket.unshift(head)
      const secure = tls.connect({
        socket,
        servername: net.isIP(host) ? undefined : host,
        ALPNProtocols: ["http/1.1"],
      })
      secure.once("secureConnect", () => cb(null, secure))
      secure.once("error", (err) => cb(err))
    })
    req.once("error", (err) => cb(new Error(`proxy ${this.proxy.host} unreachable: ${err.message}`)))
    req.end()
  }
}
