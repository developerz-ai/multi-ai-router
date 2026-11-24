/**
 * A fast-mode refusal, across every seam it crosses in production: the direct HTTP invoker, the
 * replica fence around it, the attempt, the chain and the breaker. Each half passed alone while the
 * composed path lost the classification, and one client's poisoned body cooled the account everyone
 * shares: 1058 `quota_exhausted` rows and 265 router-made `429`s in twelve hours (prod 2026-11-23).
 */
import { describe, expect, test } from "bun:test"
import { ownedInvoker } from "../../../src/composition/owned-invoker"
import { toErrorResponse } from "../../../src/errors/render"
import { createFastInvoker } from "../../../src/providers/claude-fast/invoker"
import { createSdkConcurrency } from "../../../src/providers/claude-sdk/concurrency"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { catalog, cipher, subscriptionAccount, usageSink } from "../dataplane/fixtures"

const GATED =
  "Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."

function router(
  answer: (request: Request) => Response | Promise<Response>,
  options: NonNullable<Parameters<typeof createDispatcher>[0]["options"]> = {},
) {
  const health = createHealthStore()
  const usage = usageSink()
  const lines: Record<string, unknown>[] = []
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: object) => void lines.push({ msg, ...fields }),
    error: () => {},
    child: () => logger,
  }
  let sent = 0
  const fast = createFastInvoker({
    concurrency: createSdkConcurrency({ global: 4, perAccount: 4 }),
    errorMaxBytes: 4096,
    credential: async () => ({
      accessToken: "selected-account-secret",
      expiresAt: Date.now() + 3_600_000,
      deviceId: "a".repeat(64),
      accountUuid: "11111111-1111-4111-8111-111111111111",
    }),
    resolveModel: (_id: string, model: string) => model,
    sdk: async () => {
      throw new Error("the SDK fallback is not part of this test")
    },
    fetch: async (request: Request) => {
      sent += 1
      return answer(request)
    },
  } as unknown as Parameters<typeof createFastInvoker>[0])
  const leases = { handle: () => ({ assert() {}, signal: new AbortController().signal }) }
  const dispatcher = createDispatcher({
    catalog: catalog([subscriptionAccount("sub")]),
    cipher: cipher(),
    health,
    usage,
    logger,
    invokeSdk: ownedInvoker(leases as never, fast),
    sdkIsHttp: true,
    options,
  })
  const send = async (model = "claude-opus-5") => {
    try {
      const response = await dispatcher.dispatch({
        ingress: "anthropic",
        requestId: "req",
        key: {
          id: "key",
          name: "k",
          prefix: "k",
          scope: { kind: "all" },
          rateLimitRequests: null,
          rateLimitWindowSeconds: null,
          expiresAt: null,
        },
        request: new Request("http://router.test/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model,
            max_tokens: 8,
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
      })
      await response.text()
      return response.status
    } catch (error) {
      return toErrorResponse(error, "anthropic").status
    }
  }
  return { health, usage, lines, send, sent: () => sent }
}

describe("a request-attributable fast refusal", () => {
  const gated = () =>
    Response.json(
      { type: "error", error: { type: "invalid_request_error", message: GATED } },
      { status: 400 },
    )

  test("is the request's own answer: the account is never struck, the next request is sent", async () => {
    const r = router(gated)

    expect(await r.send()).toBe(400)
    expect(r.health.stateOf("sub").breaker.status).toBe("active")
    expect(await r.send()).toBe(400)
    expect(r.sent()).toBe(2)
  })

  test("says so on the one line an operator reads, and on its usage row", async () => {
    const r = router(gated)
    await r.send()

    const line = r.lines.find((entry) => entry.msg === "upstream attempt failed")
    expect(line).toMatchObject({
      signal: "claude-sdk:extra-usage-gated",
      requestAttributable: true,
    })
    expect(r.usage.rows[0]).toMatchObject({ errorClass: "claude-sdk:extra-usage-gated" })
  })
})

test("a spent model-family window holds that model and leaves the account serving", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3_600
  const r = router(() =>
    Response.json(
      { type: "error", error: { type: "rate_limit_error", message: "Opus weekly limit reached" } },
      {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
          "anthropic-ratelimit-unified-reset": String(reset),
        },
      },
    ),
  )

  expect(await r.send()).toBe(429)
  expect(r.health.stateOf("sub").breaker.status).toBe("active")
  expect(r.health.stateOf("sub").refusedModels?.get("claude-opus-5")).toMatchObject({
    reason: "rate-limited",
    resetSource: "provider-reported",
  })
  // Opus is held without another upstream turn; Sonnet still goes out.
  expect(await r.send()).toBe(429)
  expect(r.sent()).toBe(1)
  await r.send("claude-sonnet-5")
  expect(r.sent()).toBe(2)
})

describe("a streamed fast turn runs on the streamed clocks", () => {
  const clocks = { firstByteMs: 30, idleMs: 30, totalMs: 60_000, wallHoldMs: 5 }

  // Prod 2026-11: a fast stream that went quiet held its client for the whole 600 s total.
  test("headers that never come are a timeout at the first-byte clock", async () => {
    const r = router(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason))
        }),
      { upstreamStream: clocks },
    )
    const started = performance.now()
    expect(await r.send()).toBeGreaterThanOrEqual(500)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(r.usage.rows[0]).toMatchObject({ outcome: "upstream_timeout" })
  })

  // Known limit, not the goal: unlike an HTTP attempt (`success-wall.ts`), this path commits its `200`
  // before the upstream's first byte. The idle clock ends the silence with the router's own error
  // event, but a body that never sends anything cannot fail over to another account here.
  test("a body that never sends a byte is committed, then ends in-stream at the idle clock (no failover)", async () => {
    const r = router(
      () =>
        new Response(new ReadableStream({}), { headers: { "content-type": "text/event-stream" } }),
      { upstreamStream: clocks },
    )
    const started = performance.now()
    expect(await r.send()).toBe(200)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(r.usage.rows[0]).toMatchObject({ outcome: "upstream_timeout" })
  })
})
