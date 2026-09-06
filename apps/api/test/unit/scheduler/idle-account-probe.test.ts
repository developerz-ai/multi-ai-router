import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import { createIdleAccountProbeTask } from "../../../src/scheduler"
import type { ClaudeAuthReport } from "../../../src/services/health/claudeAuthProbe"

/**
 * The daily credential sweep, in its two halves: the free logged-in check over every account, and
 * the billed keepalive over the idle ones.
 *
 * Every assertion is about money or about truth. Money: a turn is billed only for an account
 * traffic forgot, never for one already known to be dead. Truth: an expired subscription that still
 * serves traffic is found by the free check *because* it is not idle — the production gap that
 * left three dead accounts reading `active` for a week — and the run's outcome describes the
 * sweep, not the accounts it found wanting.
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

interface HarnessOptions {
  /** What `findIdle` answers. */
  readonly idle: readonly AccountRow[]
  /** What `list` answers — every account, idle or not. Defaults to the idle ones. */
  readonly all?: readonly AccountRow[]
  /** One answer for every account, or a per-id map. Absent means no CLI: no free check at all. */
  readonly loggedIn?: boolean | Readonly<Record<string, boolean | null>>
  readonly outcome?: "ok" | "failed"
  readonly tested?: boolean
  readonly aborted?: boolean
  readonly batchSize?: number
  /** Defaults to on, so the keepalive cases below still exercise the billed half. */
  readonly paidTurn?: boolean
  /** The turn-free usage read. Absent means none is wired. */
  readonly usage?: (account: AccountRow) => Promise<boolean>
  /** Access-token expiry per account id. Absent means the seam is not wired at all. */
  readonly expiry?: Readonly<Record<string, Date | null>>
  /** Defaults to on. */
  readonly warmCredentials?: boolean
}

function harness(options: HarnessOptions) {
  const tested: { accountId: string; model: string }[] = []
  const checked: string[] = []
  const controller = new AbortController()
  if (options.aborted === true) controller.abort()

  const answerFor = (id: string): boolean | null => {
    const { loggedIn } = options
    if (typeof loggedIn === "boolean") return loggedIn
    return loggedIn?.[id] ?? null
  }

  const task = createIdleAccountProbeTask({
    accounts: {
      list: async () => [...(options.all ?? options.idle)],
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
              const answer = answerFor(subject.id)
              return answer === null ? null : report(answer)
            },
          },
        }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
    models: { "anthropic-oauth": "claude-sonnet-4-5", minimax: "MiniMax-M2" },
    intervalMs: 86_400_000,
    idleAfterMs: SEVEN_DAYS_MS,
    batchSize: options.batchSize ?? 10,
    paidTurn: options.paidTurn ?? true,
    warmCredentials: options.warmCredentials ?? true,
    warmBeforeMs: 60 * 60_000,
    ...(options.expiry === undefined
      ? {}
      : { accessTokenExpiry: async (account: AccountRow) => options.expiry?.[account.id] ?? null }),
  })

  const logs: { msg: string; level: string; fields: Record<string, unknown> }[] = []
  const run = () =>
    task.run({
      now: NOW,
      signal: controller.signal,
      logger: createLogger({
        level: "debug",
        write: (line) => {
          const parsed = JSON.parse(line) as { msg: string; level: string } & Record<
            string,
            unknown
          >
          logs.push({ msg: parsed.msg, level: parsed.level, fields: parsed })
        },
      }),
    })

  return { run, tested, checked, logs }
}

describe("the free check over every credential", () => {
  /** The production gap: a dead subscription that still serves traffic is never idle. */
  test("an expired account that is not idle is still found, parked, and named — a success", async () => {
    const busy = account({ id: "acc-busy", lastUsedAt: NOW })
    const { run, checked, tested, logs } = harness({
      idle: [],
      all: [busy],
      loggedIn: { "acc-busy": false },
    })

    const result = await run()

    expect(checked).toEqual(["acc-busy"])
    expect(tested).toEqual([])
    // The sweep did its job: the account is parked (the probe wrote `needs_reauth`) and an
    // operator can find it by id in the log. That is `success`, not a daily `partial` with an
    // empty error, which is what 29 consecutive runs recorded before this distinction.
    expect(result).toMatchObject({ outcome: "success", itemsProcessed: 1 })
    const line = logs.find((entry) => entry.msg.includes("needs re-authentication"))
    expect(line?.level).toBe("warn")
    expect(line?.fields.accountId).toBe("acc-busy")
    expect(line?.fields.statusChangedTo).toBe("needs_reauth")
    expect(line?.fields).not.toHaveProperty("label")
  })

  test("every account gets a structured line, and a disabled one is never asked", async () => {
    const { run, checked, logs } = harness({
      idle: [],
      all: [account({ id: "a" }), account({ id: "b", status: "disabled" }), account({ id: "c" })],
      loggedIn: true,
    })

    await run()

    expect(checked).toEqual(["a", "c"])
    const lines = logs.filter((entry) => entry.msg === "account credential checked")
    expect(lines.map((entry) => entry.fields.accountId)).toEqual(["a", "c"])
    expect(lines.every((entry) => entry.fields.loggedIn === true)).toBe(true)
  })

  test("an account the CLI cannot speak for is neither counted nor parked", async () => {
    const { run } = harness({
      idle: [],
      all: [account({ id: "http", provider: "zai" })],
      loggedIn: { http: null },
    })

    expect(await run()).toMatchObject({ outcome: "success", itemsProcessed: 0 })
  })

  test("no CLI means no free check — idle accounts go straight to the paid test", async () => {
    const { run, tested, checked } = harness({ idle: [account()], outcome: "ok" })

    const result = await run()

    expect(checked).toEqual([])
    expect(tested).toEqual([{ accountId: "acc-1", model: "claude-sonnet-4-5" }])
    expect(result).toMatchObject({ outcome: "success", itemsProcessed: 1 })
  })
})

describe("the paid turn is opt-in — checking on a subscription must never spend usage", () => {
  test("with the flag off, nothing is ever tested, however idle", async () => {
    const { run, tested, checked, logs } = harness({
      idle: [account()],
      loggedIn: true,
      paidTurn: false,
    })

    const result = await run()

    expect(checked).toEqual(["acc-1"])
    expect(tested).toEqual([])
    expect(result).toMatchObject({ outcome: "success", itemsProcessed: 1 })
    expect(logs.some((line) => line.fields.paidTurn === false)).toBe(true)
  })

  test("the free half still reads the usage gauge for every logged-in subscription, turn-free", async () => {
    const gauged: string[] = []
    const { run, tested, logs } = harness({
      idle: [],
      all: [account(), account({ id: "acc-2", status: "needs_reauth" })],
      loggedIn: { "acc-1": true, "acc-2": false },
      paidTurn: false,
      usage: async (row) => {
        gauged.push(row.id)
        return true
      },
    })

    await run()

    expect(gauged).toEqual(["acc-1"])
    expect(tested).toEqual([])
    expect(logs.some((line) => line.fields.gauged === 1)).toBe(true)
  })

  test("a gauge read that throws is a reading not taken, never a failed sweep", async () => {
    const { run, logs } = harness({
      idle: [],
      all: [account()],
      loggedIn: true,
      paidTurn: false,
      usage: async () => {
        throw new Error("subprocess refused")
      },
    })

    const result = await run()

    expect(result.outcome).toBe("success")
    expect(logs.some((line) => line.msg === "idle account usage gauge not read")).toBe(true)
  })
})

describe("the billed keepalive over idle accounts", () => {
  test("spends one real request on an account traffic has forgotten", async () => {
    const { run, tested } = harness({ idle: [account()], loggedIn: true, outcome: "ok" })

    const result = await run()

    // The request IS the access-token refresh — nothing else produces one for an idle account.
    expect(tested).toEqual([{ accountId: "acc-1", model: "claude-sonnet-4-5" }])
    expect(result).toMatchObject({ outcome: "success", itemsProcessed: 2 })
  })

  /** The rule that keeps this a keepalive rather than a way to bill dead credentials daily. */
  test("a logged-out idle account is left to the human and never tested", async () => {
    const { run, tested, checked, logs } = harness({ idle: [account()], loggedIn: false })

    const result = await run()

    expect(checked).toEqual(["acc-1"])
    expect(tested).toEqual([])
    expect(result.outcome).toBe("success")
    expect(logs.some((line) => line.msg.includes("not testing it"))).toBe(true)
  })

  test("the free check runs before the paid one, not after it", async () => {
    const order: string[] = []
    const task = createIdleAccountProbeTask({
      accounts: {
        list: async () => [account()],
        findIdle: async () => [account()],
        updateStatusWhen: async () => undefined,
      },
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
      paidTurn: true,
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
    const { run, tested } = harness({
      idle: [account()],
      loggedIn: { "acc-1": null },
      outcome: "ok",
    })

    const result = await run()

    expect(tested).toHaveLength(1)
    expect(result).toMatchObject({ outcome: "success", itemsProcessed: 1 })
  })

  test("a provider with no probe model is skipped, never sent a guessed one", async () => {
    const { run, tested } = harness({
      idle: [account({ id: "acc-2", provider: "ollama" })],
      loggedIn: { "acc-2": null },
    })

    const result = await run()

    expect(tested).toEqual([])
    expect(result).toMatchObject({ outcome: "success", itemsProcessed: 0 })
  })

  test("its own cooldown declining a press costs nothing and is not a failure", async () => {
    const { run } = harness({ idle: [account()], loggedIn: true, tested: false })

    expect(await run()).toMatchObject({ outcome: "success", itemsProcessed: 1 })
  })

  test("a failed keepalive is logged per account, without a second opinion about status", async () => {
    const { run, logs } = harness({ idle: [account()], loggedIn: true, outcome: "failed" })

    const result = await run()

    // The test already fed the breaker; the sweep ran to completion and says so.
    expect(result.outcome).toBe("success")
    const line = logs.find((entry) => entry.msg.includes("failed its keepalive"))
    expect(line?.level).toBe("warn")
    expect(line?.fields.accountId).toBe("acc-1")
  })
})

describe("what the run row says about the sweep itself", () => {
  test("an aborted run stops before spending anything and reports partial", async () => {
    const { run, tested, checked } = harness({ idle: [account()], loggedIn: true, aborted: true })

    const result = await run()

    expect(checked).toEqual([])
    expect(tested).toEqual([])
    expect(result.outcome).toBe("partial")
  })

  test("an idle backlog larger than one batch is partial: the next tick continues", async () => {
    const { run, tested } = harness({
      idle: [account({ id: "a" }), account({ id: "b" })],
      loggedIn: true,
      outcome: "ok",
      batchSize: 2,
    })

    const result = await run()

    expect(tested).toHaveLength(2)
    expect(result.outcome).toBe("partial")
  })

  test("a probe that throws fails the run and says why", async () => {
    const task = createIdleAccountProbeTask({
      accounts: {
        list: async () => [account()],
        findIdle: async () => [],
        updateStatusWhen: async () => undefined,
      },
      test: async () => ({ tested: false }),
      auth: {
        check: async () => {
          throw new Error("claude binary vanished")
        },
      },
      models: {},
      intervalMs: 1,
      idleAfterMs: SEVEN_DAYS_MS,
      batchSize: 1,
      paidTurn: true,
    })

    const result = await task.run({
      now: NOW,
      signal: new AbortController().signal,
      logger: createLogger({ level: "error", write: () => {} }),
    })

    expect(result.outcome).toBe("failed")
    expect(result.error).toContain("claude binary vanished")
  })

  test("nothing to do is a quiet success, not a no-op that looks like a failure", async () => {
    const { run } = harness({ idle: [] })

    expect(await run()).toMatchObject({ outcome: "success", itemsProcessed: 0 })
  })

  test("the idle cutoff is the configured threshold behind now", async () => {
    let seen: Date | undefined
    const task = createIdleAccountProbeTask({
      accounts: {
        list: async () => [],
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
      paidTurn: true,
    })

    await task.run({
      now: NOW,
      signal: new AbortController().signal,
      logger: createLogger({ level: "error", write: () => {} }),
    })

    expect(seen).toEqual(new Date(NOW.getTime() - SEVEN_DAYS_MS))
  })
})

/**
 * The credential keepalive — the half added after the 2026-09-06 losses.
 *
 * A subscription's access token lives ~8 h and **only a real turn refreshes it**: the turn-free
 * handshake the model-catalog sweep runs demonstrably leaves `.credentials.json` untouched. So an
 * account nothing routes to goes cold, and the next thing to touch it finds a refresh the upstream
 * will not honour — after which the CLI blanks the file and only a re-login recovers it.
 *
 * The first test is that failure: a logged-in account whose access token has gone cold must be
 * given a turn, even though it is nowhere near the `idleAfterMs` window the billed half uses.
 */
describe("the credential keepalive", () => {
  test("warms a logged-in account whose access token has gone cold — the 2026-09-06 regression", async () => {
    const cold = account({ id: "cold", lastUsedAt: new Date(NOW.getTime() - 60_000) })
    const h = harness({
      idle: [],
      all: [cold],
      loggedIn: true,
      // Expired an hour ago. Recently *used*, so the idle half would never look at it.
      expiry: { cold: new Date(NOW.getTime() - 60 * 60_000) },
    })

    const outcome = await h.run()

    expect(h.tested).toEqual([{ accountId: "cold", model: "claude-sonnet-4-5" }])
    expect(outcome.outcome).toBe("success")
  })

  test("leaves a warm access token alone", async () => {
    const warm = account({ id: "warm" })
    const h = harness({
      idle: [],
      all: [warm],
      loggedIn: true,
      // Seven hours of life left: far outside the one-hour margin.
      expiry: { warm: new Date(NOW.getTime() + 7 * 60 * 60_000) },
    })

    await h.run()

    // Nothing billed: the common case must stay free.
    expect(h.tested).toEqual([])
  })

  test("an unknown expiry is not cold — it must never bill a turn on a guess", async () => {
    const unknown = account({ id: "unknown" })
    const h = harness({ idle: [], all: [unknown], loggedIn: true, expiry: { unknown: null } })

    await h.run()

    expect(h.tested).toEqual([])
  })

  test("with the keepalive off, a cold credential is reported and not billed", async () => {
    const cold = account({ id: "cold" })
    const h = harness({
      idle: [],
      all: [cold],
      loggedIn: true,
      warmCredentials: false,
      expiry: { cold: new Date(NOW.getTime() - 60 * 60_000) },
    })

    await h.run()

    expect(h.tested).toEqual([])
    expect(
      h.logs.some(
        (line) =>
          line.msg === "subscription access token is cold and was not warmed" &&
          line.fields.accountId === "cold",
      ),
    ).toBe(true)
  })

  test("a logged-out account is never warmed — its credential is already gone", async () => {
    const dead = account({ id: "dead" })
    const h = harness({
      idle: [],
      all: [dead],
      loggedIn: false,
      expiry: { dead: new Date(NOW.getTime() - 60 * 60_000) },
    })

    await h.run()

    expect(h.tested).toEqual([])
  })

  test("without the expiry seam the keepalive does nothing at all", async () => {
    const h = harness({ idle: [], all: [account({ id: "a" })], loggedIn: true })

    await h.run()

    expect(h.tested).toEqual([])
  })
})
