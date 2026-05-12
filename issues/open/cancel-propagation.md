# Public client disconnect doesn't cancel upstream

## What we have today

When a public HTTP client disconnects mid-request — `Ctrl-C` on curl, browser tab closed, fetch aborted — the DO doesn't know. The pending request stays in `this.pending` until the 30s `REQUEST_TIMEOUT_MS` fires. Meanwhile:

- The connector is still chugging through the local request
- The local origin is still processing
- The eventual `res_open` arrives and is dropped (public client is gone)

Wasted work on every aborted request. Worse for slow endpoints — a user firing a 10s query then bailing leaves the local origin spinning for the full 10s.

For WebSockets there's `ws_close` propagation (see `tunnel-do.ts:117-124`), so that path is OK. HTTP is the gap.

## What to do

DO needs to detect public-side disconnect:

- CF Workers' `Request` has a signal you can attach to but propagation across `await` isn't trivial. The cleanest signal is the `Request`'s `signal` (it's an `AbortSignal`). Listen on `abort` event.
- On abort: send a new `req_cancel { id }` frame to the connector, delete `pending[id]`, resolve the pending promise with a synthetic 499 (Nginx's "client closed request") response so the awaiting `fetch` handler returns cleanly.
- Connector receives `req_cancel`: call `req.destroy()` on the in-flight `http.ClientRequest` to terminate the connection to local origin.

New frame:

```ts
type ReqCancelFrame = { type: "req_cancel"; id: string }
```

## Tricky bits

- **DO Request signal lifetime**: confirm CF Workers fires `signal.abort` on actual TCP close vs just on response timeout. May need to test with a deliberate `curl --max-time 1` against a slow endpoint.
- **Race with completion**: cancel arrives just as `res_open` is being sent. Both sides need to ignore late frames for ids that have already been resolved. Use a "completed ids" set with a short TTL (e.g. LRU of last 100 ids).
- **Local origin idempotency**: if it has side effects already (DB write, email sent), `req.destroy()` doesn't undo them. That's a feature of HTTP semantics, not our bug — document it.

## Acceptance

- `curl --max-time 1 https://.../t/X/slow-endpoint` where slow-endpoint sleeps 10s: connector logs show the upstream `http.ClientRequest` got destroyed within ~1.5s of the curl exit, not at 10s.
- DO `pending` map drains to empty within seconds of public client disconnects (test: open 100 connections, Ctrl-C, watch DO memory).
- No spurious "frame for unknown id" errors logged.
