import { afterEach, describe, expect, test } from "bun:test"
import { jsonResponse } from "../unit/dataplane/fixtures"
import { bearer, harness, KEY, MESSAGE, post } from "./harness"

/**
 * The listener's idle clock against a real `Bun.serve`, because `app.request` has no socket and
 * no clock to close it.
 *
 * The prod fingerprint this pins (2026-10-23): a `stream:false` request to a reasoning model writes
 * zero bytes until the upstream finishes, and on a large prompt that is longer than
 * `SERVER_IDLE_TIMEOUT_SECONDS` (60). Bun closed the socket as idle at ~60 s, the router recorded
 * `client_cancelled` with no tokens, and gpt-6.1-sol had zero non-streamed successes all-time while
 * its streams (which carry heartbeats) succeeded. Here the idle timeout is 1 s and the upstream
 * holds the answer for {@link HOLD_MS}, comfortably past Bun's 4 s sweep.
 */
const IDLE_SECONDS = 1
const HOLD_MS = 6_000
const TEST_TIMEOUT_MS = 20_000

const servers: ReturnType<typeof Bun.serve>[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

function serve(responses: Parameters<typeof harness>[0]["responses"]): string {
  const { app } = harness({ responses, serverIdleTimeoutSeconds: IDLE_SECONDS })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: IDLE_SECONDS,
    fetch: app.fetch,
  })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

const ANSWER = { id: "msg_1", type: "message", content: [{ type: "text", text: "late" }] }

describe("a non-streamed data-plane request outlives the server's idle clock", () => {
  test(
    "an upstream that answers only after the idle timeout still reaches the client",
    async () => {
      const base = serve([
        () =>
          new Promise((resolve) => setTimeout(() => resolve(jsonResponse(200, ANSWER)), HOLD_MS)),
      ])
      const response = await fetch(`${base}/v1/messages`, post(MESSAGE, bearer()))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(ANSWER)
    },
    TEST_TIMEOUT_MS,
  )

  // The Codex shape: headers at once, the one JSON body folded from an upstream stream that takes
  // minutes. The handler has returned, so the clock must stay off until the body is written.
  test(
    "a body that arrives after the idle timeout, behind early headers, still reaches the client",
    async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(ANSWER))
      const base = serve([
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                await Bun.sleep(HOLD_MS)
                controller.enqueue(bytes)
                controller.close()
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ])
      const response = await fetch(`${base}/v1/messages`, post(MESSAGE, bearer()))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(ANSWER)
    },
    TEST_TIMEOUT_MS,
  )
})

describe("the server's idle clock still governs everything else", () => {
  test(
    "a keep-alive socket left idle after a held response is reaped again",
    async () => {
      const base = serve([() => jsonResponse(200, ANSWER)])
      const { port } = new URL(base)
      const started = Date.now()
      let received = ""
      let closedAt: number | null = null
      const closed = new Promise<void>((resolve) => {
        void Bun.connect({
          hostname: "127.0.0.1",
          port: Number(port),
          socket: {
            open(socket) {
              socket.write(
                `POST /v1/messages HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${KEY}\r\n` +
                  `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(MESSAGE)}\r\n\r\n${MESSAGE}`,
              )
            },
            data(_socket, data) {
              received += new TextDecoder().decode(data)
            },
            close() {
              closedAt = Date.now()
              resolve()
            },
          },
        })
      })
      await Promise.race([closed, Bun.sleep(HOLD_MS * 2)])
      expect(received).toStartWith("HTTP/1.1 200")
      // Held open forever, a socket whose peer vanished would never be closed.
      expect(closedAt).not.toBeNull()
      expect((closedAt ?? 0) - started).toBeLessThan(HOLD_MS * 2)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "a stream that goes silent past the idle timeout is still cut by the server's clock",
    async () => {
      const first = new TextEncoder().encode("event: ping\ndata: {}\n\n")
      const base = serve([
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(first)
              },
              async pull() {
                await Bun.sleep(HOLD_MS * 3)
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      ])
      const response = await fetch(`${base}/v1/messages`, post(MESSAGE, bearer()))
      expect(response.status).toBe(200)
      const started = Date.now()
      const outcome = await response.text().then(
        () => "ended",
        () => "closed",
      )
      expect(outcome).toBe("closed")
      expect(Date.now() - started).toBeLessThan(HOLD_MS * 2)
    },
    TEST_TIMEOUT_MS,
  )
})
