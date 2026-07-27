import { afterEach, describe, expect, test } from "bun:test"
import { drainServer } from "../../src/services/shutdown/drain"

/**
 * The drain over a **real listener**, because its contract is a claim about what
 * `Bun.serve().stop()` actually does: unforced, it resolves only when the last in-flight response
 * has ended, and a streamed completion can hold that open for minutes. A bun upgrade that changed
 * either half would leave the unit tests green and the deployment wrong, so this file asks the real
 * server.
 *
 * Port `0` — the kernel picks one, nothing here reaches past loopback, and no provider is touched.
 */

const servers: { stop(closeActiveConnections?: boolean): Promise<void> }[] = []

afterEach(async () => {
  // A leaked listener outlives its test and is inherited by the next one.
  for (const server of servers.splice(0)) await server.stop(true)
})

interface Streaming {
  readonly server: Bun.Server
  readonly url: string
  /** Resolves once a request is actually being served, so a drain cannot start before one exists. */
  readonly serving: Promise<void>
}

/** A server that answers with `chunks` bytes, `gapMs` apart — a completion, slowly. */
function streamingServer(chunks: number, gapMs: number): Streaming {
  let entered: () => void = () => undefined
  const serving = new Promise<void>((resolve) => {
    entered = resolve
  })

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      entered()
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let index = 0; index < chunks; index++) {
              controller.enqueue(new TextEncoder().encode("."))
              await Bun.sleep(gapMs)
            }
            controller.close()
          },
        }),
        { headers: { "content-type": "text/plain" } },
      )
    },
  })
  servers.push(server)

  return { server, url: `http://127.0.0.1:${server.port}/`, serving }
}

describe("draining a real listener", () => {
  test("lets a response in flight finish, and reports it drained", async () => {
    const { server, url, serving } = streamingServer(4, 20)

    const response = await fetch(url)
    await serving
    // Consumed concurrently: the drain below only returns once these bytes have all landed.
    const body = response.text()

    const outcome = await drainServer({ server, timeoutMs: 10_000 })

    expect(outcome.timedOut).toBe(false)
    expect(outcome.pending).toBeGreaterThanOrEqual(1)
    expect(outcome.abandoned).toBe(0)
    // The whole answer, not a truncation: this is the case a rolling deploy used to cut.
    expect(await body).toBe("....")
  })

  test("returns at the deadline while a response is still open, and counts it", async () => {
    const { server, url, serving } = streamingServer(20, 25)

    const response = await fetch(url)
    await serving
    let finished = false
    const body = response.text().finally(() => {
      finished = true
    })

    const outcome = await drainServer({ server, timeoutMs: 25 })

    expect(outcome.timedOut).toBe(true)
    expect(outcome.abandoned).toBeGreaterThanOrEqual(1)
    // The bound, stated the only way that matters: the drain came back while the response it gave
    // up on was still streaming. What ends that response is the caller's exit.
    expect(finished).toBe(false)

    await body
  })

  test("a second stop cannot close what the first one is already waiting on", async () => {
    // Not a test of this router — a test of the bun behaviour `drain.ts` is written around, and the
    // reason it issues exactly one stop. If a future bun honours the flag on the second call, this
    // fails and the escalation can move back inside the drain.
    const { server, url, serving } = streamingServer(8, 25)

    const response = await fetch(url)
    await serving
    const body = response.text()

    void server.stop()
    await server.stop(true)

    expect(await body).toBe("........")
  })

  test("stops accepting new connections before it starts waiting", async () => {
    const { server, url, serving } = streamingServer(6, 20)

    const response = await fetch(url)
    await serving
    const body = response.text()

    const drained = drainServer({ server, timeoutMs: 10_000 })
    // While the first response is still streaming: the listener is already closed, so this is
    // refused rather than queued behind a shutdown.
    await expect(fetch(url)).rejects.toThrow()

    expect(await body).toBe("......")
    expect(await drained).toMatchObject({ timedOut: false })
  })

  test("an idle server drains at once", async () => {
    const { server } = streamingServer(1, 0)

    const outcome = await drainServer({ server, timeoutMs: 10_000 })

    expect(outcome).toMatchObject({ pending: 0, abandoned: 0, timedOut: false })
    expect(outcome.waitedMs).toBeLessThan(1_000)
  })
})
