import type { MiddlewareHandler } from "hono"

/**
 * Takes a data-plane inference request off the listener's idle clock until its answer is written.
 *
 * `SERVER_IDLE_TIMEOUT_SECONDS` closes a connection that carried no bytes for that long, which is
 * right for a stream (it heartbeats well inside it) and for an idle keep-alive socket. It is wrong
 * for a **non-streamed** answer: one JSON object goes out only once the upstream has finished, and a
 * reasoning model on a large prompt thinks for longer than 60 s. Measured on Bun 1.4.2, the clock
 * runs from the moment the handler returns headers whose body is still pending — exactly the shape
 * of a Codex `stream:false` call, whose upstream SSE is folded into one body after the headers are
 * out — and prod (2026-10-23) recorded every such gpt-6.1-sol request as `client_cancelled` at
 * ~60 s with no tokens. Raising the global is no fix: 255 s is Bun's ceiling and an answer can take
 * longer; `UPSTREAM_TIMEOUT_MS` is the bound that owns a slow upstream.
 *
 * So the clock is switched off per request (`server.timeout(request, 0)`), and back on to the
 * configured value at the point the global's purpose applies again:
 *
 * - **an event stream, once its first byte is written** — from there its gaps are bounded by the
 *   upstream idle clock (`UPSTREAM_IDLE_TIMEOUT_MS`, inside this one) or its own heartbeats, and a
 *   stream gone silent past the timeout is still cut by the server. Not at its headers: Bun writes
 *   no status line until the first body byte, and the upstream may legitimately stay silent up to
 *   `UPSTREAM_FIRST_BYTE_TIMEOUT_MS` (300 s) before it. Restoring at the headers cut every passthrough
 *   stream whose upstream thought longer than 60 s with nothing written at all — Envoy saw a reset
 *   before any header (`502 UPE`) and the router filed it `client_cancelled` (2026-11, zai, 512 in 14 d);
 * - **any other body, once its last byte is written** — Bun keeps a per-request timeout on the
 *   socket afterwards, so without the restore an idle keep-alive socket whose peer vanished would
 *   never be reaped.
 *
 * Mounted after the router-key guard, so only an authenticated caller can hold a socket open.
 * Outside `Bun.serve` (`app.request` in a test) there is no server and no clock: a no-op.
 */
export function holdIdleClock(idleTimeoutSeconds: number): MiddlewareHandler {
  return async (c, next) => {
    const clock = idleClockOf(c.env)
    if (clock === null) return next()
    const request = c.req.raw
    clock(request, 0)
    const restore = (): void => clock(request, idleTimeoutSeconds)

    await next()

    const response = c.res
    if (response.body === null) {
      restore()
      return
    }
    const atFirstByte = isEventStream(response)
    let restored = false
    const restoreOnce = (): void => {
      if (restored) return
      restored = true
      restore()
    }
    c.res = new Response(
      response.body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            controller.enqueue(chunk)
            if (atFirstByte) restoreOnce()
          },
          flush: restoreOnce,
        }),
      ),
      response,
    )
  }
}

type IdleClock = (request: Request, seconds: number) => void

/** Bun hands its `Server` to `fetch` as the second argument, which Hono exposes as `c.env`. */
function idleClockOf(env: unknown): IdleClock | null {
  if (typeof env !== "object" || env === null || !("timeout" in env)) return null
  const { timeout } = env
  if (typeof timeout !== "function") return null
  return (request, seconds) => {
    timeout.call(env, request, seconds)
  }
}

function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.includes("text/event-stream") === true
}
