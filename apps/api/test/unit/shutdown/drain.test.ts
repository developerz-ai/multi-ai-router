import { describe, expect, test } from "bun:test"
import { type DrainableServer, drainServer } from "../../../src/services/shutdown/drain"

/**
 * The drain's whole job is the deadline, so every test here is about what happens on one side of it
 * or the other. No listener: the server is injected, which is what lets a "never finishes" case be
 * expressed as a promise nobody resolves rather than as a real hung stream.
 */

interface FakeServer extends DrainableServer {
  pendingRequests: number
  /**
   * Every `stop()` call in order, each recording whether it asked for live connections to be
   * closed. Normalised to a boolean rather than kept as the raw optional argument: `toEqual`
   * treats `[]` and `[undefined]` as equal, so an array of holes asserts nothing.
   */
  readonly calls: boolean[]
  /** Ends the unforced stop, the way the last in-flight response ending would. */
  finish(): void
  /** Fails it instead, the way a server already torn down might. */
  fail(): void
}

function fakeServer(pending = 0): FakeServer {
  const calls: boolean[] = []
  let settle: { resolve: () => void; reject: (error: unknown) => void } | undefined

  return {
    pendingRequests: pending,
    calls,
    stop(closeActiveConnections?: boolean): Promise<void> {
      calls.push(closeActiveConnections === true)
      if (closeActiveConnections === true) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        settle = { resolve, reject }
      })
    },
    finish: () => settle?.resolve(),
    fail: () => settle?.reject(new Error("already stopped")),
  }
}

/** A scripted monotonic clock: one reading when the drain starts, one when it ends. */
function clock(...readings: number[]): () => number {
  let at = 0
  return () => readings[Math.min(at++, readings.length - 1)] ?? 0
}

describe("drainServer", () => {
  test("stops listening before it waits for anything", () => {
    const server = fakeServer(2)

    // Not awaited: the point is that the socket is closed to new connections by the time the
    // deadline starts running, not after it expires.
    void drainServer({ server, timeoutMs: 10_000 })

    expect(server.calls).toEqual([false])
    server.finish()
  })

  test("returns as soon as the last in-flight request has ended", async () => {
    const server = fakeServer(3)
    const drained = drainServer({ server, timeoutMs: 10_000, now: clock(100, 140) })

    server.finish()
    const outcome = await drained

    expect(outcome).toEqual({ pending: 3, abandoned: 0, waitedMs: 40, timedOut: false })
    // Never forced: everything finished on its own, so there was nothing left to close.
    expect(server.calls).toEqual([false])
  })

  test("gives up at the deadline, and says how much it gave up on", async () => {
    const server = fakeServer(4)

    const outcome = await drainServer({ server, timeoutMs: 5, now: clock(0, 5) })

    expect(outcome).toEqual({ pending: 4, abandoned: 4, waitedMs: 5, timedOut: true })
    // Exactly one stop, ever. A second one asking to close live connections is ignored by bun once
    // the first is in flight, so issuing it would only look like an escalation that happened.
    expect(server.calls).toEqual([false])
  })

  test("counts what was in flight when it began, and what was left when it gave up", async () => {
    const server = fakeServer(4)
    const drained = drainServer({ server, timeoutMs: 20 })

    // Three of the four land inside the deadline; the fourth is the one that gets closed.
    server.pendingRequests = 1
    const outcome = await drained

    expect(outcome.pending).toBe(4)
    expect(outcome.abandoned).toBe(1)
    expect(outcome.timedOut).toBe(true)
  })

  test("an idle server drains at once", async () => {
    const server = fakeServer(0)
    const drained = drainServer({ server, timeoutMs: 10_000 })

    server.finish()

    expect(await drained).toMatchObject({ pending: 0, abandoned: 0, timedOut: false })
    expect(server.calls).toEqual([false])
  })

  test("a zero deadline waits for nothing", async () => {
    const server = fakeServer(2)

    // Nothing ever finishes, and nothing is meant to: `0` is the operator asking for no wait.
    const outcome = await drainServer({ server, timeoutMs: 0 })

    expect(outcome.timedOut).toBe(true)
    expect(outcome.abandoned).toBe(2)
    expect(server.calls).toEqual([false])
  })

  test("a stop that rejects ends the wait rather than escaping it", async () => {
    const server = fakeServer(1)
    const drained = drainServer({ server, timeoutMs: 10_000 })

    server.fail()
    const outcome = await drained

    // A failed stop is still a stop: there is nothing left to wait for, and an escaping rejection
    // would take the flush that runs after this with it.
    expect(outcome.timedOut).toBe(false)
    expect(outcome.abandoned).toBe(0)
  })

  test("a stop that never settles is bounded rather than awaited", async () => {
    const server = fakeServer(1)
    const started = performance.now()

    // The shape of the bug this exists to prevent: a response that runs forever used to mean a
    // shutdown that ran forever, ending only when the orchestrator killed it.
    const outcome = await drainServer({ server, timeoutMs: 20 })

    expect(outcome.timedOut).toBe(true)
    expect(performance.now() - started).toBeLessThan(5_000)
  })
})
