# Stream request/response bodies instead of 10 MB buffer

## What we have today

Both request and response bodies are fully buffered:

- **DO → connector**: `req.arrayBuffer()` (`tunnel-do.ts:237`) reads the full request, hard cap `MAX_BODY_BYTES = 10 MB` else 413.
- **Connector → DO**: connector collects `res.on("data")` chunks into `chunks[]`, concats at end, base64-encodes, sends as one `res_open` frame (`connector.mjs:75-89`).
- **Connector → upstream**: same — full request body base64-decoded before `req.write(body)`.

This is fine for JSON/HTML/small files. It breaks for:

- File uploads > 10 MB (413)
- Large downloads (e.g. video, big JSON exports) — buffered in DO memory; CF DO has 128 MB limit, so technically OK up to ~100 MB, but latency to first byte is "wait for the whole thing"
- Long-poll / SSE responses — held until upstream closes, no chunks delivered

## What to do

Switch to chunked framing. Add wire frame types:

```ts
type ReqChunkFrame = { type: "req_chunk"; id: string; data_b64: string }
type ReqEndFrame   = { type: "req_end"; id: string }
type ResChunkFrame = { type: "res_chunk"; id: string; data_b64: string }
type ResEndFrame   = { type: "res_end"; id: string; trailers?: Record<string, string> }
```

Flow:

- DO: instead of `req.arrayBuffer()`, use `ReadableStream`. Send `req_open` with no body, then stream `req_chunk` frames as bytes arrive, then `req_end`.
- Connector: receives `req_open`, opens `http.request` with `{ Transfer-Encoding: chunked }`, pipes incoming `req_chunk` frames into `req.write(chunk)`, calls `req.end()` on `req_end`.
- Connector response side: on `res.on("data", chunk)` emit `res_chunk` frame immediately, `res_end` on `res.on("end")`.
- DO: build response with `new Response(stream, ...)` where `stream` is a `ReadableStream` fed by incoming `res_chunk` frames; close on `res_end`.

## Tricky bits

- **Backpressure**: WebSocket has no native backpressure semantics. If connector reads upstream faster than DO can deliver to public client (or vice versa), frames pile up in memory. Need a sliding window / credit scheme, OR rely on `bufferedAmount > N → pause`.
- **Aborts**: public client disconnect mid-stream — need to propagate to upstream (see `cancel-propagation.md`).
- **Order**: WS guarantees per-connection order, so frames are already in order. Fine.
- **Memory cap during streaming**: even with chunks, keep a per-request high-water mark; if pending data > 5 MB, send `pause` / `resume` frames.

## Acceptance

- A 100 MB download streams through without DO hitting memory limit
- A `curl --upload-file <100MB>` succeeds (with a per-tunnel max of e.g. 1 GB, configurable)
- Long-poll / SSE / streaming JSON arrives chunk-by-chunk, not all-at-once
- Existing buffered path removed (no `MAX_BODY_BYTES` constant)
