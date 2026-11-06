import { describe, expect, test } from "bun:test"
import type { AccountStatus } from "@multi-ai-router/core"
import type { AccountRow } from "@multi-ai-router/db"
import { recoveryProbeSender } from "../../../src/composition/recovery"
import { createLogger } from "../../../src/logging/logger"
import { createCooldownRecheckTask } from "../../../src/scheduler/tasks/cooldown-recheck"
import { createTestNowService } from "../../../src/services/accounts"
import { createHealthStore } from "../../../src/services/dataplane"
import { overlayHealth } from "../../../src/services/dataplane/snapshot"
import type { RoutableAccount } from "../../../src/services/dataplane/types"
import { accountRow } from "../../support/account-row"
import { account, at, NOW } from "../routing/fixtures"

/**
 * Codex answers only as a stream, so a refusal arrives inside a `200`. These run the real "Test now"
 * transport, sender, task and health store, and stub nothing but the upstream's bytes.
 */

const HOUR = 3_600_000
const RESET = at(3 * 24 * HOUR)
const ACCESS = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-c" } })).toString("base64url")}.s`

function sse(...frames: readonly unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}
const failed = (code: string) => ({
  type: "response.failed",
  response: { status: "failed", error: { code, message: "refused" } },
})

function harness(
  respond: () => Response,
  provider: AccountRow["provider"] = "openai-oauth",
  authMaterial = JSON.stringify({
    accessToken: ACCESS,
    refreshToken: "rt",
    providerAccountId: "acct-c",
  }),
) {
  const row = accountRow({ id: "a", provider, authMaterial })
  const held = {
    id: "a",
    lifecycleVersion: 0,
    healthRecoveryVersion: 0,
    authRecoveryVersion: 0,
    authMaterial,
    driver: { provider },
    snapshot: account("a", { provider, supportedModels: ["declared-model"] }),
  } as unknown as RoutableAccount
  const blocked: AccountStatus[] = []
  const store = createHealthStore({
    jitter: () => 0,
    onBlocked: (_id, status, observation) => {
      if (observation !== undefined) blocked.push(status)
    },
  })
  let sends = 0
  const testNow = createTestNowService({
    accounts: { findById: async () => row },
    cipher: { decrypt: (value) => value },
    audit: { record: async () => undefined },
    cooldownSeconds: 60,
    timeoutMs: 5_000,
    now: () => NOW,
    fetch: async () => {
      sends++
      return respond()
    },
    reasonMaxChars: 200,
  })
  const send = recoveryProbeSender(testNow)
  const task = createCooldownRecheckTask({
    accounts: () => [held],
    snapshot: () => overlayHealth(held.snapshot, store.stateOf("a")),
    rows: { findById: async () => row },
    health: store,
    send,
    startGuard: () => async () => undefined,
    models: {},
    quotaSpentThreshold: 1,
    intervalMs: HOUR,
    batchSize: 5,
  })
  const lines: Record<string, unknown>[] = []
  const logger = createLogger({
    level: "info",
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  })
  const run = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++)
      await task.run({ now: NOW, logger, signal: new AbortController().signal })
  }
  store.recordFailure("a", { kind: "rate-limited", resetsAt: RESET, message: "limit" }, NOW)
  return { store, blocked, run, lines, send, sends: () => sends }
}

describe("a refusal inside a 200 Codex stream", () => {
  test.each(["account_deactivated", "insufficient_quota"])(
    "%s ends exhausted after one send, and is not asked again",
    async (code) => {
      const h = harness(() => sse(failed(code)))

      await h.run(4)

      expect(h.sends()).toBe(1)
      expect(h.store.stateOf("a").breaker.status).toBe("exhausted")
      expect(h.blocked).toEqual(["exhausted"])
    },
  )

  test("usage_limit_reached behaves like a 429: nothing moves and the tick is no failure", async () => {
    const h = harness(() => sse(failed("usage_limit_reached")))
    const before = h.store.stateOf("a").breaker

    await h.run(1)

    expect(h.store.stateOf("a").breaker).toEqual(before)
    expect(h.store.stateOf("a").breaker.cooldownUntil).toEqual(RESET)
    expect(h.lines.find((line) => line.msg === "cooldown recheck")).toMatchObject({
      "still-cooling": 1,
      failed: 0,
    })
  })

  test("a bare error frame with no terminal event is read too", async () => {
    const h = harness(() => sse({ type: "error", code: "usage_limit_reached" }))
    const before = h.store.stateOf("a").breaker

    await h.run(1)

    expect(h.store.stateOf("a").breaker).toEqual(before)
  })

  test("a failed stream nothing classifies stays a server error", async () => {
    const h = harness(() => sse(failed("some_new_failure")))

    await h.run(1)

    const breaker = h.store.stateOf("a").breaker
    expect(breaker.status).toBe("cooling_down")
    expect(breaker.consecutiveFailures).toBe(2)
    expect(breaker.cooldownUntil).toEqual(RESET)
    expect(h.blocked).toEqual([])
  })

  test("a completed stream still ends the cooldown", async () => {
    const h = harness(() =>
      sse({ type: "response.completed", response: { status: "completed", output: [] } }),
    )

    await h.run(1)

    expect(h.store.stateOf("a").breaker.status).toBe("active")
  })

  test("the recovery probe's sender hears the same class", async () => {
    const h = harness(() => sse(failed("account_deactivated")))

    const result = await h.send({
      accountId: "a",
      model: "declared-model",
      startGuard: async () => undefined,
      rateLimitSink: () => undefined,
    })

    expect(result).toMatchObject({
      kind: "answered",
      ok: false,
      failureKind: "credits-exhausted",
      message: "codex:stream-error:account_deactivated",
    })
  })
})

describe("a refusal inside a 200 JSON body", () => {
  test("a MiniMax spent balance is not read as the account serving", async () => {
    const h = harness(
      () =>
        new Response(
          JSON.stringify({ base_resp: { status_code: 1008, status_msg: "insufficient balance" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "minimax",
      "key",
    )

    await h.run(2)

    expect(h.sends()).toBe(1)
    expect(h.store.stateOf("a").breaker.status).toBe("exhausted")
  })
})
