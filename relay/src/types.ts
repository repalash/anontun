// Wire frames between connector ↔ relay.
//
// Two connector transports carry the same frames:
//   ws   — one WebSocket on /_connect, frames in both directions (v0)
//   sse  — relay → connector over a Server-Sent Events stream on
//          /_connect/sse (one `data:` line per frame); connector → relay
//          as POST /_respond/<token> with a frame (or array of frames) as
//          the JSON body, authenticated by the `x-anontun-secret` header.
//          For clients behind an HTTPS-only proxy that cannot upgrade to
//          WebSocket (CI runners, agent sandboxes).

export interface Env {
  TUNNEL: DurableObjectNamespace
  // Optional. When set (e.g. "tunnel.ijewel.info"), every tunnel is also
  // reachable as https://<token>.<TUNNEL_HOST>/ with the path passed through
  // unchanged, and that is the URL handed to the connector. Needs a wildcard
  // DNS record + Worker route for *.<TUNNEL_HOST>. Path form /t/<token>/ on
  // the bare host keeps working either way.
  TUNNEL_HOST?: string
}

// Connector → relay
export interface RegisterFrame { type: "register" }

// Relay → connector (after register). `secret` is only present on the sse
// transport: the connector sends it back on every /_respond call and on
// reconnect, so a public client that knows the token cannot forge responses.
export interface RegisteredFrame { type: "registered"; token: string; url: string; secret?: string }

// Relay → connector: a public client made an HTTP request
export interface ReqOpenFrame {
  type: "req_open"
  id: string
  method: string
  // Path inside the tunnel (after stripping /t/<token>). e.g. "/api/users?x=1"
  path: string
  headers: Record<string, string>
  // Body inlined as base64 (v0; up to 10 MB). Empty string for empty body.
  body_b64: string
  // True if this is a WebSocket upgrade request — connector should open a WS to local target
  upgrade: boolean
}

// Connector → relay: response to req_open (or upgrade ack)
export interface ResOpenFrame {
  type: "res_open"
  id: string
  status: number
  headers: Record<string, string>
  body_b64?: string  // for non-upgrade responses; full body
}

// Either side: WS data frame after upgrade
export interface WsFrameFrame {
  type: "ws_frame"
  id: string
  data_b64: string
  binary: boolean
}

// Either side: WS close
export interface WsCloseFrame {
  type: "ws_close"
  id: string
  code?: number
  reason?: string
}

// Heartbeat
export interface PingFrame { type: "ping"; id: string }
export interface PongFrame { type: "pong"; id: string }

export type Frame =
  | RegisterFrame | RegisteredFrame
  | ReqOpenFrame | ResOpenFrame
  | WsFrameFrame | WsCloseFrame
  | PingFrame | PongFrame
