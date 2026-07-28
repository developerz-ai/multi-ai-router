import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import { createIdleAccountProbeTask } from "../../../src/scheduler"
import type { ClaudeAuthReport } from "../../../src/services/health/claudeAuthProbe"

/**
 * The keepalive sweep, and the two properties that make it worth its cost.
 *
 * **The free check gates the paid one.** A Claude subscription's tokens are refreshed by the SDK
 * only when it runs, so an account traffic forgets expires on its own — that is what this task
 * spends a request to prevent. But an account whose credential is *already* dead fails that request
 * for a reason only a human can fix, so asking the CLI first (free, contacts nobody) and skipping
 * the turn is the difference between a keepalive and a slow leak.
 *
 * **It bounds and reports.** One batch per tick, abort honoured between accounts so a shutdown
 * never lands mid-turn, and every skip counted rather than inferred from a gap.
 */

const NOW = new Date("2026-07-28T03:00:00.000Z")
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "acc-1",
    label: "claude-a",
    provider: "anthropic-oauth",
    status: "active",
    lastUsedAt: null,
    ...overrides,
  } as AccountRow
}

function report(loggedIn: boolean): ClaudeAuthReport {
  return {
    loggedIn,
    email: null,
    subscriptionType: null,
    statusChangedTo: loggedIn ? null : "needs_reauth",
    checkedAt: NOW.toISOString(),
  }
}

function harness(options: {
  readonly idle: readonly AccountRow[]
  readonly loggedIn?: boolean
  readonly outcome?: "ok" | "failed"
  readonly tested?: boolean
  readonly aborted?: boolean
}) {
  const tested: { accountId: string; model: string }[] = []
  const checked: string[] = []
  const controller = new AbortController()
  if (options.aborted === true) controller.abort()

  const task = createIdleAccountProbeTask({
    accounts: {
      findIdle: async ({ limit }) => options.idle.slice(0, limit),
      updateStatusWhen: async () => undefined,
    },
    test: async (accountId, model) => {
      tested.push({ accountId, model })
      return {
        tested: options.tested ?? true,
        ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
      }
    },
    ...(options.loggedIn === undefined
      ? {}
      : {
          auth: {
            check: async (subject) => {
              checked.push(subject.id)
              return report(options.loggedIn === true)
            },
          },
        }),
    models: { "anthropic-oauth": "claude-sonnet-4-5", minimax: "MiniMax-M2" },
    intervalMs: 86_400_000,
    idleAfterMs: SEVEN_DAYS_MS,
    batchSize: 10,
  })

  const logs: { msg: string; fields?: Record<string, unknown> }[] = []
  const run = () =>
    task.run({
      now: NOW,
      signal: controller.signal,
      logger: createLogger({
        level: "debug",
        write: (line) => {
          const parsed = JSON.parse(line) as { msg: string } & Record<string, unknown>
          logs.push({ msg: parsed.msg, fields: parsed })
        },
      }),
    })

  return { run, tested, checked, logs }
}

describe("the idle-account keepalive sweep", () => {
  test("spends one real request on an account traffic has forgotten", async () => {
    const { run, tested } = harness({ idle: [account()], loggedIn: true, outcome: "ok" })

    const result = await run()

    // The request IS the refresh — nothing else in the system produces one for an idle account.
    expect(tested).toEqual([{ accountId: "acc-1", model: "claude-sonnet-4-5" }])
    expect(result).toMatchObject({ outcome: "success", itemsProcessed: 1 })
  })

  /** The rule that keeps this a keepalive rather than a way to bill dead credentials daily. */
  test("a logged-out account is left to the human and never tested", async () => {
    const { run, tested, checked, logs } = harness({ idle: [account()], loggedIn: false })

    const result = await run()

    expect(checked).toEqual(["acc-1"])
    expect(tested).toEqual([])
    // `partial`, not `success`: the sweep ran, but an account needs a person.
    expect(result.outcome).toBe("partial")
    expect(logs.some((line) => line.msg.includes("needs re-authentication"))).toBe(true)
  })

  test("the free check runs before the paid one, not after it", async () => {
    const order: string[] = []
    const task = createIdleAccountProbeTask({
      accounts: { findIdle: async () => [account()], updateStatusWhen: async () => undefined },
      test: async () => {
        order.push("test")
        return { tested: true, outcome: "ok" as const }
      },
      auth: {
        check: async () => {
          order.push("auth")
          return report(true)
        },
      },
      models: { "anthropic-oauth": "claude-sonnet-4-5" },
      intervalMs: 1,
      idleAfterMs: SEVEN_DAYS_MS,
      batchSize: 1,
    })

    await task.run({
      now: NOW,
      signal: new AbortController().signal,
      logger: createLogger({ level: "error", write: () => {} }),
    })

    expect(order).toEqual(["auth", "test"])
  })

  /**
   * A probe that cannot answer is not a probe that answered "logged out". Marking healthy accounts
   * `needs_reauth` because a binary was missing is the bad trade `login/contract.ts` warns about.
   */
  test("an indefinite auth answer falls through to the paid test rather than to needs_reauth", async () => {
    const task = createIdleAccountProbeTask({
      accounts: { findIdle: async () => [account()], updateStatusWhen: async () => undefined },
      test: async () => ({ tested: true, outcome: "ok" as const }),
      auth: { check: async () => null },
      models: { "anthropic-oauth": "claude-sonnet-4-5" },
      intervalMs: 1,
      idleAfterMs: SEVEN_DAYS_MS,
      batchSize: 1,
    })

    const result = await task.run({
      now: NOW,
      signal: new AbortController().signal,
      logger: createLogger({ level: "error", write: () => {} }),
    })

    expect(result).toMatchObject({ outcome: "success", itemsProcessed: 1 })
  })

  test("a provider with no probe model is skipped, never sent a guessed one", async () => {
    const { run, tested } = harness({
      idle: [account({ id: "acc-2", provider: "ollama" })],
      loggedIn: true,
    })

    const result = await run()

    expect(tested).toEqual([])
    expect(result).toMatchObject({ outcome: "success", itemsProcessed: 0 })
  })

  test("its own cooldown declining a press costs nothing and is not a failure", async () => {
    const { run } = harness({ idle: [account()], loggedIn: true, tested: false })

    const result = await run()

    expect(result).toMatchObject({ outcome: "success", itemsProcessed: 0 })
  })

  test("a failed keepalive is reported without a second opinion about status", async () => {
    const { run, logs } = harness({ idle: [account()], loggedIn: true, outcome: "failed" })

    const result = await run()

    // The test already fed the breaker; this task never writes a status of its own.
    expect(result.outcome).toBe("partial")
    expect(logs.some((line) => line.msg.includes("failed its keepalive"))).toBe(true)
  })

  test("an aborted run stops before spending anything and reports partial", async () => {
    const { run, tested } = harness({ idle: [account()], loggedIn: true, aborted: true })

    const result = await run()

    expect(tested).toEqual([])
    expect(result.outcome).toBe("partial")
  })

  test("nothing idle is a quiet success, not a no-op that looks like a failure", async () => {
    const { run } = harness({ idle: [] })

    expect(await run()).toMatchObject({ outcome: "success", itemsProcessed: 0 })
  })

  test("the idle cutoff is the configured threshold behind now", async () => {
    let seen: Date | undefined
    const task = createIdleAccountProbeTask({
      accounts: {
        findIdle: async ({ before }) => {
          seen = before
          return []
        },
        updateStatusWhen: async () => undefined,
      },
      test: async () => ({ tested: false }),
      models: {},
      intervalMs: 1,
      idleAfterMs: SEVEN_DAYS_MS,
      batchSize: 1,
    })

    await task.run({
      now: NOW,
      signal: new AbortController().signal,
      logger: createLogger({ level: "error", write: () => {} }),
    })

    expect(seen).toEqual(new Date(NOW.getTime() - SEVEN_DAYS_MS))
  })
})
