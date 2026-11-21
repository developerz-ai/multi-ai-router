import { describe, expect, test } from "bun:test"
import { routerErrorObject } from "../../../src/errors/router-object"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"
import {
  createDispatcher,
  createHealthStore,
  type RoutableAccount,
} from "../../../src/services/dataplane"
import type { RecoveryAccess } from "../../../src/services/dataplane/recovery-access"
import type { RecoverySnapshot } from "../../../src/services/routing"
import { account, cipher, clock, jsonResponse, NOW, usageSink } from "./fixtures"

/**
 * The router's own recovery hold is not a reason to send a client away: a request that sees only
 * `probe-in-flight` waits, on the coordinator's cadence and within `RECOVERY_REQUEST_WAIT_MS`, and
 * lands on the account once its permit arrives (prod, 2026-10-06 23:15:28).
 */

const recovery = (state: RecoverySnapshot["state"], localAvailable: boolean): RecoverySnapshot => ({
  state,
  localAvailable,
  retryAt: new Date(NOW.getTime() + 1_000),
  revision: 1,
  generation: "g1",
  lifecycleVersion: 0,
  nextAllowedAt: NOW,
  quotaRevisions: {},
})

function harness(
  initial: readonly RoutableAccount[],
  options: {
    budgetMs: number
    refuseAdmissions?: number
    answer?: (request: Request) => Response
  },
) {
  let accounts = initial
  const testClock = clock()
  const usage = usageSink()
  const sleeps: number[] = []
  let onSleep: (count: number) => void = () => {}
  let refusals = options.refuseAdmissions ?? 0
  const catalog = { accounts: () => accounts, pools: () => [] }
  const access: RecoveryAccess = {
    catalog,
    quotaStaleAfterMs: 600_000,
    currentSnapshot: (id) => accounts.find((one) => one.id === id)?.snapshot,
    hint: () => {},
    forget: () => {},
    prepare: (_account, candidate) => {
      let started = false
      const designated = candidate.account.recovery !== undefined
      return {
        designated,
        started: () => started,
        beforeUpstreamStart: () => {
          if (designated && refusals > 0) {
            refusals--
            throw new UpstreamAdmissionRefused()
          }
          started = true
        },
        finish: () => {},
      }
    },
  }
  const calls: string[] = []
  const dispatcher = createDispatcher({
    catalog,
    health: createHealthStore(),
    cipher: cipher(),
    usage,
    clock: testClock,
    recovery: access,
    fetch: async (request) => {
      calls.push(request.headers.get("x-api-key") ?? "")
      return options.answer?.(request) ?? jsonResponse(200, { type: "message", content: [] })
    },
    sleep: async (ms, signal) => {
      sleeps.push(ms)
      testClock.advance(ms)
      onSleep(sleeps.length)
      signal.throwIfAborted()
    },
    options: { recoveryWait: { budgetMs: options.budgetMs, intervalMs: 250 } },
  })
  const dispatch = (signal?: AbortSignal) =>
    dispatcher.dispatch({
      ingress: "anthropic",
      requestId: crypto.randomUUID(),
      key: {
        id: "key",
        name: "sebastian",
        prefix: "mar_live_test",
        scope: { kind: "all" },
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
        expiresAt: null,
      },
      request: new Request("http://router.test/v1/messages", {
        method: "POST",
        ...(signal === undefined ? {} : { signal }),
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    })
  return {
    dispatch,
    usage,
    sleeps,
    calls,
    replace(next: readonly RoutableAccount[]) {
      accounts = next
    },
    whenSlept(callback: (count: number) => void) {
      onSleep = callback
    },
  }
}

const gated = (id: string) => account(id, { snapshot: { recovery: recovery("pending", false) } })
const permitted = (id: string) => account(id, { snapshot: { recovery: recovery("issued", true) } })

describe("recovery wait", () => {
  test("disabled (budget 0): the router's own hold still answers 429 at once", async () => {
    const h = harness([gated("a")], { budgetMs: 0 })
    await expect(h.dispatch()).rejects.toMatchObject({ status: 429 })
    expect(h.sleeps).toEqual([])
    expect(h.usage.rows).toHaveLength(1)
  })

  test("only probe-in-flight at first: waits, then lands on the account once a permit is issued", async () => {
    const h = harness([gated("a"), gated("b")], { budgetMs: 5_000 })
    h.whenSlept((count) => {
      if (count === 2) h.replace([permitted("a"), gated("b")])
    })
    const response = await h.dispatch()
    await response.text()
    expect(response.status).toBe(200)
    expect(h.sleeps).toEqual([250, 250])
    expect(h.calls).toHaveLength(1)
    expect(h.usage.rows).toHaveLength(1)
    expect(h.usage.rows[0]).toMatchObject({ accountId: "a", outcome: "success" })
  })

  test("gives up after the budget with the existing 429 + Retry-After and one UsageRecord", async () => {
    const h = harness([gated("a")], { budgetMs: 1_000 })
    const failure = await h.dispatch().then(
      () => {
        throw new Error("expected a 429")
      },
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ status: 429, code: "quota_exhausted" })
    expect(failure).toHaveProperty("retryAfterSeconds")
    expect(h.sleeps).toEqual([250, 250, 250, 250])
    expect(h.calls).toHaveLength(0)
    expect(h.usage.rows).toHaveLength(1)
    expect(h.usage.rows[0]).toMatchObject({ accountId: null, outcome: "quota_exhausted" })
  })

  test("a provider-reported spent window is answered at once — nothing to wait for", async () => {
    const spent = account("a", {
      snapshot: {
        quotaWindows: [
          {
            window: "seven_day",
            utilization: 1,
            utilizationSource: "continuous",
            resetsAt: new Date(NOW.getTime() + 2 * 86_400_000),
            resetSource: "provider-reported",
            lastCheckedAt: NOW,
          },
        ],
      },
    })
    const h = harness([spent], { budgetMs: 5_000 })
    await expect(h.dispatch()).rejects.toMatchObject({ status: 429 })
    expect(h.sleeps).toEqual([])
    expect(h.usage.rows).toHaveLength(1)
  })

  test("chain refused for want of a permit: waits and retries instead of 429", async () => {
    const h = harness([permitted("a")], { budgetMs: 5_000, refuseAdmissions: 1 })
    const response = await h.dispatch()
    await response.text()
    expect(response.status).toBe(200)
    expect(h.sleeps).toEqual([250])
    expect(h.calls).toHaveLength(1)
    expect(h.usage.rows).toHaveLength(1)
    expect(h.usage.rows[0]).toMatchObject({ accountId: "a", outcome: "success" })
  })

  test("chain refusals past the budget: one 429 refusal row, no attempt", async () => {
    const h = harness([permitted("a")], { budgetMs: 500, refuseAdmissions: 100 })
    await expect(h.dispatch()).rejects.toMatchObject({
      status: 429,
      message: "recovering accounts are awaiting a recovery permit",
    })
    expect(h.sleeps).toEqual([250, 250])
    expect(h.calls).toHaveLength(0)
    expect(h.usage.rows).toHaveLength(1)
    expect(h.usage.rows[0]).toMatchObject({ accountId: null })
  })

  // developerz.ai, 2026-11-20: 57 of 212 run errors on one key were this refusal, rendered with
  // `signal: null` and a reset ~0.1 s out. The client parked the model until that instant, the park
  // lapsed at once, and the next request walled again. It must name itself and the honest hold.
  test("the refusal envelope names its own signal and the probe hold, not a moment from now", async () => {
    const h = harness([permitted("a")], { budgetMs: 500, refuseAdmissions: 100 })
    const failure = await h.dispatch().then(
      () => {
        throw new Error("expected a 429")
      },
      (error: unknown) => error,
    )
    // Given up at NOW + 500 (two 250 ms pauses); the default half-open hold is 30 s.
    const resetsAt = new Date(NOW.getTime() + 500 + 30_000)
    expect(failure).toMatchObject({ status: 429, retryAfterSeconds: 30, resetsAt })
    expect(routerErrorObject(failure, 30, "req-1")).toMatchObject({
      wall: "clock",
      retryable: true,
      signal: "awaiting-recovery-permit",
      reset_at: resetsAt.toISOString(),
      reset_source: "estimated",
      retry_after_s: 30,
    })
  })

  test("a client that goes away mid-wait ends the wait, with no attempt", async () => {
    const h = harness([gated("a")], { budgetMs: 5_000 })
    const controller = new AbortController()
    h.whenSlept(() => controller.abort())
    await expect(h.dispatch(controller.signal)).rejects.toMatchObject({
      name: "ClientCancelledError",
    })
    expect(h.sleeps).toEqual([250])
    expect(h.calls).toHaveLength(0)
    expect(h.usage.rows).toHaveLength(1)
    expect(h.usage.rows[0]).toMatchObject({ accountId: null })
  })

  // Prod 23:16:02: venom's spent-window 429 was answered while engmanager, refused only for want of
  // its permit, would have served a moment later.
  const spentElsewhere = (request: Request) =>
    request.headers.get("x-api-key") === "sk-b"
      ? jsonResponse(
          429,
          { type: "error", error: { type: "rate_limit_error", message: "spent" } },
          { "retry-after": "172800" },
        )
      : jsonResponse(200, { type: "message", content: [] })

  test("a held 429 beside a permit refusal waits for the recovering account", async () => {
    const h = harness([permitted("a"), account("b")], {
      budgetMs: 5_000,
      refuseAdmissions: 1,
      answer: spentElsewhere,
    })
    const response = await h.dispatch()
    await response.text()
    expect(response.status).toBe(200)
    expect(h.calls).toEqual(["sk-b", "sk-a"])
    expect(h.usage.rows.map((row) => row.accountId).sort()).toEqual(["a", "b"])
  })

  test("past the budget it answers the refusal's probe hold, not the held window", async () => {
    const h = harness([permitted("a"), account("b")], {
      budgetMs: 500,
      refuseAdmissions: 100,
      answer: spentElsewhere,
    })
    // The probe hold (30 s), not b's two-day window and not a one-second park that lapses at once.
    await expect(h.dispatch()).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 30,
      message: "recovering accounts are awaiting a recovery permit",
    })
    expect(h.calls).toEqual(["sk-b"])
    // b's attempt is the request's row; the refusal adds none of its own.
    expect(h.usage.rows.map((row) => row.accountId)).toEqual(["b"])
  })
})
