// Wire frames between connector ↔ relay.

export interface Env {
  TUNNEL: DurableObjectNamespace
}

// Connector → relay
export interface RegisterFrame { type: "register" }

// Relay → connector (after register)
export interface RegisteredFrame { type: "registered"; token: string; url: string }

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
