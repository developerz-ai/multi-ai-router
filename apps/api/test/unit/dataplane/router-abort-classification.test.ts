import { describe, expect, test } from "bun:test"
import { UpstreamTimeoutError } from "@multi-ai-router/core"
import { createDispatcher, createHealthStore, relayResponse } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import {
  ClientCancelledError,
  cancellationError,
  relayCancellationError,
} from "../../../src/services/dataplane/relay-cancellation"
import { relayTranslatedResponse } from "../../../src/services/dataplane/relay-translate"
import { translationPair } from "../../../src/services/translate/registry"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher, slowStream } from "./fixtures"

/**
 * The abort that cancels a relay is **not** evidence of a client disconnect. The same signal is
 * aborted by the router's own clocks, by shutdown, and by the client; a reason the router names
 * records its own class, and every other one stays a `client_cancelled` row rather than blaming an
 * account that never answered. Production fingerprint: 282 of 285 `client_cancelled` terminals in
 * 7d were unclaimed. HYPOTHESIS: this path filed router-caused aborts as client cancels.
 */

/** A router-caused abort reason: a real error that is not the platform's `AbortError`. */
const timeout = () => new DOMException("upstream stream outlived its deadline", "TimeoutError")
const clientGone = () => new DOMException("The operation was aborted.", "AbortError")

describe("the shared cancellation classification", () => {
  test("a router reason is kept, never flattened to a client cancel", () => {
    const typed = new UpstreamTimeoutError("upstream idle deadline")
    expect(cancellationError(typed)).toBe(typed)
    const deadline = timeout()
    expect(cancellationError(deadline)).toBe(deadline)
  })

  test("an AbortError, no reason, or an unclassified reason becomes client_cancelled", () => {
    expect(cancellationError(clientGone())).toBeInstanceOf(ClientCancelledError)
    // No reason at all is a bare abort: the caller left, which is the client's act.
    expect(cancellationError(undefined)).toBeInstanceOf(ClientCancelledError)
    expect(cancellationError("upstream_timeout")).toBeInstanceOf(ClientCancelledError)
  })

  /**
   * The direction that blames nobody needs the same guard: an unclassified reason is the client's
   * act. A plain `Error` from the runtime's own loopback is what `request-lifetime.ts` pins as
   * `client_cancelled`/`499` (`caller-cancellation.test.ts`), and reading it as a router abort
   * strikes the account's breaker for a disconnect the account had nothing to do with.
   */
  test("an unclassified reason stays a client cancel, never a router abort", () => {
    expect(cancellationError(new Error("offline caller disconnected"))).toBeInstanceOf(
      ClientCancelledError,
    )
  })

  test("relayCancellationError reads the reason off the signal, aborted or not", () => {
    const controller = new AbortController()
    expect(relayCancellationError(controller.signal)).toBeInstanceOf(ClientCancelledError)
    const deadline = timeout()
    controller.abort(deadline)
    expect(relayCancellationError(controller.signal)).toBe(deadline)
    expect(relayCancellationError(undefined)).toBeInstanceOf(ClientCancelledError)
  })
})

describe("router abort classification at the relay", () => {
  test("a router abort keeps its real error instead of a client cancellation", async () => {
    const upstream = slowStream(["first", "second"])
    const deadline = timeout()
    const controller = new AbortController()
    const errors: unknown[] = []

    const relayed = relayResponse(
      upstream.response,
      {
        onError: (error) => {
          errors.push(error)
        },
      },
      controller.signal,
    )
    if (relayed.body === null) throw new Error("expected a body")
    const reader = relayed.body.getReader()

    // Release one chunk first: the abort lands with bytes already on the wire, the case where the
    // piped abort and downstream cancellation race and an unclassified relay files a client cancel.
    upstream.release(0)
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe("first")
    controller.abort(deadline)
    // Drain the reader so its cancellation observer fires and settles the relay.
    await reader.cancel().catch(() => {})

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe(deadline)
  })

  test("a genuine client abort still yields client_cancelled", async () => {
    const upstream = slowStream(["first", "second"])
    const controller = new AbortController()
    const errors: unknown[] = []

    const relayed = relayResponse(
      upstream.response,
      {
        onError: (error) => {
          errors.push(error)
        },
      },
      controller.signal,
    )
    if (relayed.body === null) throw new Error("expected a body")
    const reader = relayed.body.getReader()
    upstream.release(0)
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first")

    controller.abort(clientGone())
    await reader.cancel().catch(() => {})

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(ClientCancelledError)
  })

  test("bytes stay byte-passthrough while the abort is classified", async () => {
    const upstream = slowStream(["alpha", "beta", "gamma"])
    const chunks: string[] = []
    const controller = new AbortController()
    const decoder = new TextDecoder()

    const relayed = relayResponse(upstream.response, {}, controller.signal)
    if (relayed.body === null) throw new Error("expected a body")
    const reader = relayed.body.getReader()

    upstream.release(0)
    chunks.push(decoder.decode((await reader.read()).value))
    expect(chunks).toEqual(["alpha"])
    upstream.release(1)
    chunks.push(decoder.decode((await reader.read()).value))
    expect(chunks).toEqual(["alpha", "beta"])
    controller.abort(timeout())
    await reader.cancel().catch(() => {})
    expect(chunks).toEqual(["alpha", "beta"])
  })
})

/**
 * The settle that actually wins the abort race lives in `chain-relay.ts`, not in the relay: its
 * listener is registered before the relay exists. So the row is only classified correctly if that
 * settle classifies too — driving the dispatcher is the only way to observe it.
 */
describe("the win-the-race settle in the chain", () => {
  const encoder = new TextEncoder()
  const OPEN = ": open\n\n"

  async function fixture() {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined
    const rows: UsageRecord[] = []
    const requestAbort = new AbortController()
    const routing = catalog([account("a")])
    const health = createHealthStore({ jitter: () => 0 })
    const dispatcher = createDispatcher({
      catalog: routing,
      cipher: cipher(),
      health,
      activeRequests: createActiveRequestRegistry({ maximumEntries: 10 }),
      usage: {
        record: (row) => {
          rows.push(row)
        },
      },
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              source = controller
              controller.enqueue(encoder.encode(OPEN))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    const response = await dispatcher.dispatch({
      ingress: "anthropic",
      requestId: crypto.randomUUID(),
      key: {
        id: "key",
        name: "offline",
        prefix: "offline",
        scope: { kind: "accounts", accountIds: ["a"] },
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
        expiresAt: null,
      },
      request: new Request("http://router.test/v1/messages", {
        method: "POST",
        signal: requestAbort.signal,
        body: JSON.stringify({
          model: "claude",
          max_tokens: 1,
          messages: [{ role: "user", content: "offline" }],
        }),
      }),
    })
    if (source === undefined || response.body === null) throw new Error("missing stream")
    const reader = response.body.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(OPEN)
    return { reader, rows, requestAbort, health }
  }

  test("a non-shutdown router abort records its own class, not client_cancelled", async () => {
    const f = await fixture()
    f.requestAbort.abort(timeout())
    await f.reader.read().catch(() => {})

    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]?.errorClass).not.toBe("client_cancelled")
    expect(f.rows[0]).toMatchObject({
      outcome: "upstream_timeout",
      errorClass: "upstream_timeout",
    })
  })

  test("a bare client abort still records client_cancelled", async () => {
    const f = await fixture()
    f.requestAbort.abort(clientGone())
    await f.reader.read().catch(() => {})

    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]).toMatchObject({
      outcome: "client_error",
      errorClass: "client_cancelled",
    })
  })

  /** The regression the flipped default caused: the row was `upstream_error`, and it struck the
   * account's breaker — three of those park a healthy account in `cooling_down`. */
  test("an unclassified reason leaves the account's breaker alone", async () => {
    const f = await fixture()
    f.requestAbort.abort(new Error("offline caller disconnected"))
    await f.reader.read().catch(() => {})

    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]).toMatchObject({ outcome: "client_error", errorClass: "client_cancelled" })
    expect(f.health.stateOf("a").breaker.consecutiveFailures).toBe(0)
  })
})

/**
 * The translated relays settle their cancellation in their own callbacks
 * (`relay-translate.ts`, `relay-translate-body.ts`), so a regression there is invisible to every
 * test that drives the byte relay. Both are driven here, in both directions.
 */
describe("the translated relays classify their cancel callback", () => {
  const pair = translationPair("openai-chat", "anthropic")
  const context = { created: 0, model: "offline", fallbackId: "offline" }

  /**
   * An upstream that answers nothing and settles neither a read nor a cancel, so the only thing
   * that can report the abort is the relay's own cancel callback. With an upstream that *does*
   * reject, `readRelayBody`'s `throwIfAborted` (and `pipeTo`) would report the raw reason first and
   * this case would pass even with the callback constructing `ClientCancelledError`.
   */
  const openStream = () =>
    new ReadableStream<Uint8Array>({
      start() {},
      cancel: () => new Promise<void>(() => {}),
    })

  async function streamingErrors(reason: unknown): Promise<unknown[]> {
    if (pair === null) throw new Error("missing translator")
    const abort = new AbortController()
    const errors: unknown[] = []
    const response = relayTranslatedResponse({
      upstream: new Response(openStream(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      pair,
      context,
      signal: abort.signal,
      observer: {
        onError: (error) => {
          errors.push(error)
        },
      },
    })
    if (response.body === null) throw new Error("missing response")
    const reader = response.body.getReader()
    abort.abort(reason)
    await reader.cancel().catch(() => {})
    await Promise.resolve()
    return errors
  }

  async function bodyErrors(reason: unknown): Promise<unknown[]> {
    if (pair === null) throw new Error("missing translator")
    const abort = new AbortController()
    const errors: unknown[] = []
    const response = relayTranslatedResponse({
      upstream: new Response(openStream(), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      pair,
      context,
      signal: abort.signal,
      observer: {
        onError: (error) => {
          errors.push(error)
        },
      },
    })
    if (response.body === null) throw new Error("missing response")
    const reader = response.body.getReader()
    abort.abort(reason)
    await reader.cancel().catch(() => {})
    await Promise.resolve()
    return errors
  }

  for (const [path, errorsFor] of [
    ["a streamed translation", streamingErrors],
    ["a translated body", bodyErrors],
  ] as const) {
    test(`${path} reports a router abort reason, not client_cancelled`, async () => {
      const deadline = timeout()
      const errors = await errorsFor(deadline)

      expect(errors).toHaveLength(1)
      expect(errors[0]).toBe(deadline)
      expect(errors[0]).not.toBeInstanceOf(ClientCancelledError)
    })

    test(`${path} still reports a genuine client abort as client_cancelled`, async () => {
      const errors = await errorsFor(clientGone())

      expect(errors).toHaveLength(1)
      expect(errors[0]).toBeInstanceOf(ClientCancelledError)
    })
  }
})
