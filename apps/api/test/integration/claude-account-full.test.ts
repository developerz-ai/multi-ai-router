import { describe, expect, test } from "bun:test"
import { opaqueAccountRef } from "../../src/errors/account-ref"
import type { Logger } from "../../src/logging/logger"
import { createSdkConcurrency, createSdkInvoker, type SdkInvocation } from "../../src/providers"
import { sdkQueryStream, sdkTurn } from "../unit/claude-sdk/fixtures"
import { manualGateClock } from "../unit/claude-sdk/manual-gate-clock"
import { account, jsonResponse, subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, MESSAGE, post } from "./harness"

/**
 * A request that cannot get a Claude subprocess slot within `CLAUDE_SDK_QUEUE_WAIT_MS` is told so
 * and moves on, instead of waiting silently at the gate until its attempt deadline. Driven through
 * the real invoker over the real concurrency gate, `query()` stubbed and the gate's clock a hand
 * the test moves: no real waiting, no fake timers.
 *
 * Global sits above perAccount in most cases below. On prod's 8/8 an account holding all 8 slots
 * also fills the global gate, so the account-full case cannot occur there on its own; the router-full
 * cases cover that ceiling.
 */

const KNOB = 60_000

const ONE_TURN = sdkTurn({
  blocks: [
    [
      { type: "text", text: "" },
      { type: "text_delta", text: "hi" },
    ],
  ],
})

const API_MESSAGE = {
  id: "msg_api",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [{ type: "text", text: "from the api account" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
}

function router(options: {
  readonly accounts: Parameters<typeof harness>[0]["accounts"]
  readonly global: number
  readonly perAccount: number
  readonly logger?: Logger
}) {
  const time = manualGateClock()
  const concurrency = createSdkConcurrency(
    { global: options.global, perAccount: options.perAccount },
    { now: time.now, timer: time.timer },
  )
  const asked: string[] = []
  const real = createSdkInvoker({
    concurrency,
    resolveCli: () => ({ ok: true, source: "env_override", path: "/offline/claude", bytes: 1 }),
    runQuery: ({ prompt }) => {
      void (async () => {
        for await (const _ of prompt) {
        }
      })()
      return sdkQueryStream({ turns: [ONE_TURN] })
    },
  })
  const h = harness({
    accounts: options.accounts,
    responses: [() => jsonResponse(200, API_MESSAGE)],
    selection: { unpooledPolicy: "priority-failover" },
    invokeSdk: (invocation: SdkInvocation) => {
      asked.push(invocation.accountId)
      return real(invocation)
    },
    claudeQueueWaitMs: KNOB,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
  return { ...h, time, concurrency, asked }
}

const live = () => new AbortController().signal

/** Lets the request travel until something is queued at the gate; real turns, no timers. */
async function untilQueued(concurrency: { readonly queued: number }, count = 1): Promise<void> {
  for (let turn = 0; turn < 500 && concurrency.queued < count; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
  expect(concurrency.queued).toBe(count)
}

const subs = (...ids: string[]) =>
  ids.map((id, priority) => subscriptionAccount(id, { snapshot: { priority } }))

const ACCOUNT_FULL =
  "the Claude subscription account is at its in-flight limit (account-at-capacity)"

describe("a full Claude account, with the gate wait bounded", () => {
  test("A full, B free: B serves, and A is neither cooled nor struck", async () => {
    const r = router({ accounts: subs("sub-a", "sub-b"), global: 4, perAccount: 1 })
    const holder = await r.concurrency.acquire("sub-a", live())

    const pending = r.app.request("/v1/messages", post(MESSAGE, bearer()))
    await untilQueued(r.concurrency)
    r.time.advance(KNOB)
    const res = await pending
    await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get("x-router-account")).toBe(opaqueAccountRef("sub-b"))
    expect(r.asked).toEqual(["sub-a", "sub-b"])

    const breaker = r.health.stateOf("sub-a").breaker
    expect(breaker.status).toBe("active")
    expect(breaker.consecutiveFailures).toBe(0)
    expect(breaker.cooldownUntil).toBeUndefined()

    const rows = r.usage.rows.filter((row) => row.accountId === "sub-a")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      errorClass: "account-at-capacity",
      outcome: "no_healthy_account",
      httpStatus: null,
    })
    holder.release()
  })

  test("both full: the client hears account_at_capacity with the exact envelope", async () => {
    const r = router({ accounts: subs("sub-a", "sub-b"), global: 4, perAccount: 1 })
    const holders = [
      await r.concurrency.acquire("sub-a", live()),
      await r.concurrency.acquire("sub-b", live()),
    ]

    const pending = r.app.request("/v1/messages", post(MESSAGE, bearer()))
    await untilQueued(r.concurrency)
    r.time.advance(KNOB)
    const res = await pending
    const body = (await res.json()) as {
      error: { type: string; message: string; code?: string; router: unknown }
    }

    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("30")
    expect(body.error.message).toBe(ACCOUNT_FULL)
    expect(body.error.router).toEqual({
      wall: "clock",
      scope: "pool",
      retryable: true,
      reset_at: null,
      reset_source: null,
      retry_after_s: 30,
      accounts: [
        { account: opaqueAccountRef("sub-a"), state: "no_healthy_account", reset_at: null },
        { account: opaqueAccountRef("sub-b"), state: "no_healthy_account", reset_at: null },
      ],
      pools: [],
      signal: "account-at-capacity",
      attempts: 2,
      request_id: res.headers.get("x-request-id"),
      reconnect: [],
    })
    for (const id of ["sub-a", "sub-b"]) {
      const breaker = r.health.stateOf(id).breaker
      expect(breaker.status).toBe("active")
      expect(breaker.consecutiveFailures).toBe(0)
    }
    for (const holder of holders) holder.release()
  })

  test("three full accounts answer after one knob of time, not three", async () => {
    const r = router({ accounts: subs("sub-a", "sub-b", "sub-c"), global: 8, perAccount: 1 })
    const holders = [
      await r.concurrency.acquire("sub-a", live()),
      await r.concurrency.acquire("sub-b", live()),
      await r.concurrency.acquire("sub-c", live()),
    ]

    const pending = r.app.request("/v1/messages", post(MESSAGE, bearer()))
    await untilQueued(r.concurrency)
    r.time.advance(KNOB)
    const res = await pending
    await res.text()

    expect(res.status).toBe(429)
    expect(r.asked).toEqual(["sub-a", "sub-b", "sub-c"])
    // The one advance above is all the time the walk ever waited.
    expect(r.time.now()).toBe(KNOB)
    expect(r.usage.rows.filter((row) => row.errorClass === "account-at-capacity")).toHaveLength(3)
    for (const holder of holders) holder.release()
  })
})

describe("a full global gate, with the gate wait bounded", () => {
  test("an account of another kind is still tried, and no further Claude account is asked", async () => {
    const r = router({
      accounts: [
        ...subs("sub-a", "sub-b"),
        account("api-1", { apiKey: "sk-api", cipher: CRYPTOR, snapshot: { priority: 2 } }),
      ],
      global: 1,
      perAccount: 4,
    })
    const holder = await r.concurrency.acquire("holder", live())

    const pending = r.app.request("/v1/messages", post(MESSAGE, bearer()))
    await untilQueued(r.concurrency)
    r.time.advance(KNOB)
    const res = await pending
    await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get("x-router-account")).toBe(opaqueAccountRef("api-1"))
    expect(r.asked).toEqual(["sub-a"])
    expect(r.upstream.calls).toHaveLength(1)
    holder.release()
  })

  test("with only Claude accounts, the answer is 503 router-at-capacity after one ask", async () => {
    const r = router({ accounts: subs("sub-a", "sub-b"), global: 1, perAccount: 4 })
    const holder = await r.concurrency.acquire("holder", live())

    const pending = r.app.request("/v1/messages", post(MESSAGE, bearer()))
    await untilQueued(r.concurrency)
    r.time.advance(KNOB)
    const res = await pending
    const body = (await res.json()) as { error: { code?: string; router: Record<string, unknown> } }

    expect(res.status).toBe(503)
    expect(res.headers.get("retry-after")).toBe("30")
    expect(body.error.router).toMatchObject({
      wall: "capacity",
      scope: "router",
      signal: "router-at-capacity",
      retry_after_s: 30,
      retryable: true,
    })
    expect(r.asked).toEqual(["sub-a"])
    expect(r.health.stateOf("sub-a").breaker.status).toBe("active")
    holder.release()
  })

  test("at prod's shape the account-full answer outranks the router-full one", async () => {
    // global 1: A's own held slot is also the whole replica's, so B is refused on the global half.
    const r = router({ accounts: subs("sub-a", "sub-b"), global: 1, perAccount: 1 })
    const holder = await r.concurrency.acquire("sub-a", live())

    const pending = r.app.request("/v1/messages", post(MESSAGE, bearer()))
    await untilQueued(r.concurrency)
    r.time.advance(KNOB)
    const res = await pending
    const body = (await res.json()) as { error: { message: string; router: { signal: string } } }

    expect(res.status).toBe(429)
    expect(body.error.router.signal).toBe("account-at-capacity")
    expect(body.error.message).toBe(ACCOUNT_FULL)
    expect(r.asked).toEqual(["sub-a", "sub-b"])
    // B was not dropped while the request was prepared: it reached the gate and was refused on the
    // replica's half, with no upstream status. `asked` alone cannot say so, it is logged before
    // admission, and A's verdict wins the answer either way.
    const rows = (id: string) => r.usage.rows.filter((row) => row.accountId === id)
    expect(rows("sub-a")).toHaveLength(1)
    expect(rows("sub-a")[0]).toMatchObject({ errorClass: "account-at-capacity", httpStatus: null })
    expect(rows("sub-b")).toHaveLength(1)
    expect(rows("sub-b")[0]).toMatchObject({ errorClass: "router-at-capacity", httpStatus: null })
    holder.release()
  })

  test("the OpenAI dialect hears no_healthy_account, and the attempt log names the signal", async () => {
    const lines: Record<string, unknown>[] = []
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (msg, fields) => void lines.push({ msg, ...fields }),
      error: () => {},
      child: () => logger,
    }
    const r = router({ accounts: subs("sub-a"), global: 1, perAccount: 4, logger })
    const holder = await r.concurrency.acquire("holder", live())

    const pending = r.app.request(
      "/v1/chat/completions",
      post(
        JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] }),
        bearer(),
      ),
    )
    await untilQueued(r.concurrency)
    r.time.advance(KNOB)
    const res = await pending
    const body = (await res.json()) as {
      error: { code?: string; router: Record<string, unknown> }
    }

    expect(res.status).toBe(503)
    expect(body.error.code).toBe("no_healthy_account")
    // The OpenAI dialect carries the same machine-readable verdict and Retry-After as /v1/messages.
    expect(res.headers.get("retry-after")).toBe("30")
    expect(body.error.router).toMatchObject({
      wall: "capacity",
      scope: "router",
      signal: "router-at-capacity",
      retry_after_s: 30,
      retryable: true,
    })
    expect(lines.find((entry) => entry.msg === "upstream attempt failed")).toMatchObject({
      failureKind: "router-full",
      signal: "router-at-capacity",
    })
    holder.release()
  })
})
