/**
 * `exhausted` has a bounded exit (rule 7, amended: developerz.ai#7868).
 *
 * Through 2.48.0 nothing but an operator's "Re-check now" ever looked at an `exhausted` account
 * again. A misread wall — a throttle worded like a balance — parked a healthy account for good:
 * MiniMax sat out from 10-28 to 11-03 with nobody pressing the button. The ruling: a park with no
 * bounded exit is worse than a cheap re-test. So an `exhausted` account is re-tested through that
 * same button, first after an hour and then on a doubling clock capped at a day, and every re-test
 * is an alert line. A drained balance costs one failed probe a day; a misread one is back within
 * the hour.
 */
import { describe, expect, test } from "bun:test"
import type { AccountStatus } from "@multi-ai-router/core"
import { createLogger } from "../../../src/logging/logger"
import {
  createExhaustedRetest,
  type ExhaustedWatchStore,
  memoryExhaustedWatchStore,
} from "../../../src/scheduler/tasks/exhausted-retest"
import type { RoutableAccount } from "../../../src/services/dataplane/types"
import {
  type ExhaustedWatch,
  retestMaxGapMs,
  retestWait,
  retestWaitCapMs,
  stepExhaustedWatch,
  worstCaseTickMs,
} from "../../../src/services/routing/exhausted-retest"
import { account, NOW } from "../routing/fixtures"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// One hourly timer plus bounded work after an early re-test and before a late successor: the wait
// must stop one complete actual-retest gap below `maxMs`.
const SCHEDULE = { firstMs: HOUR, maxMs: DAY, tickMs: 3 * HOUR }
const T0 = NOW.getTime()

describe("the re-test clock", () => {
  test("doubles from an hour and stops one actual-retest gap short of a day", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => retestWait(n, SCHEDULE) / HOUR)).toEqual([
      1, 2, 4, 8, 16, 21, 21,
    ])
  })

  test("the cap leaves room for the tick that fires the re-test, so no gap passes a day", () => {
    expect(retestWaitCapMs(SCHEDULE)).toBe(SCHEDULE.maxMs - SCHEDULE.tickMs)
    expect(retestWait(5, SCHEDULE)).toBe(SCHEDULE.maxMs - SCHEDULE.tickMs)
    expect(retestMaxGapMs(SCHEDULE)).toBe(SCHEDULE.maxMs)
    expect(retestMaxGapMs(SCHEDULE)).toBeLessThanOrEqual(SCHEDULE.maxMs)
  })

  test("a tick's worst case includes its timer and bounded work before and after re-tests", () => {
    expect(worstCaseTickMs(HOUR, 0)).toBe(HOUR)
    expect(worstCaseTickMs(3_600_000, 0.2)).toBe(4_320_000)
    expect(worstCaseTickMs(3_600_000, 0.2)).toBe(72 * MINUTE)
    expect(worstCaseTickMs(HOUR, 0.2, HOUR)).toBe(192 * MINUTE)
  })

  test("worst-case scheduler ticks and nonzero task runs keep actual re-tests within the cap", () => {
    const taskRunMs = HOUR
    const timerMs = 40 * MINUTE
    const jitterFraction = 0.2
    const jitteredTimerMs = worstCaseTickMs(timerMs, jitterFraction)
    const tickMs = worstCaseTickMs(timerMs, jitterFraction, taskRunMs)
    const schedule = { firstMs: HOUR, maxMs: DAY, tickMs }
    let watch: ExhaustedWatch | undefined = { retests: 5, dueAt: T0, lastRetestAt: T0 }
    const actualRetests = [T0]

    // The first re-test is at its task's start; successors are deliberately at their tasks' ends.
    // A one-run allowance passes the old idealized end-to-end case but fails this actual scheduler
    // ordering when the timer is late by its full jittered interval.
    for (
      let tickStartedAt = T0;
      tickStartedAt < T0 + 7 * DAY;
      tickStartedAt += jitteredTimerMs + taskRunMs
    ) {
      const step = stepExhaustedWatch(watch, true, tickStartedAt, schedule)
      watch = step.watch
      if (step.retest) {
        actualRetests.push(actualRetests.length === 1 ? tickStartedAt : tickStartedAt + taskRunMs)
      }
    }

    const gaps = actualRetests.slice(1).map((at, index) => at - (actualRetests[index] ?? at))
    expect(gaps.length).toBeGreaterThan(0)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(DAY)
  })

  test("a newly exhausted account is first re-tested an hour later, not at once", () => {
    const first = stepExhaustedWatch(undefined, true, T0, SCHEDULE)

    expect(first.retest).toBe(false)
    expect(first.watch).toEqual({ retests: 0, dueAt: T0 + HOUR, lastRetestAt: null })
  })

  test("a due watch re-tests and pushes the next one out by the doubled wait", () => {
    const watch: ExhaustedWatch = { retests: 0, dueAt: T0 + HOUR, lastRetestAt: null }
    const step = stepExhaustedWatch(watch, true, T0 + HOUR, SCHEDULE)

    expect(step.retest).toBe(true)
    expect(step.watch).toEqual({ retests: 1, dueAt: T0 + 3 * HOUR, lastRetestAt: T0 + HOUR })
  })

  test("nothing is re-tested before it is due", () => {
    const watch: ExhaustedWatch = { retests: 2, dueAt: T0 + HOUR, lastRetestAt: T0 - HOUR }

    expect(stepExhaustedWatch(watch, true, T0, SCHEDULE)).toEqual({ watch, retest: false })
  })

  test("a re-tested account that is serving keeps its count until it has served a full day", () => {
    const watch: ExhaustedWatch = { retests: 3, dueAt: T0 + 8 * HOUR, lastRetestAt: T0 }

    expect(stepExhaustedWatch(watch, false, T0 + HOUR, SCHEDULE).watch).toEqual(watch)
    expect(stepExhaustedWatch(watch, false, T0 + DAY, SCHEDULE).watch).toBeUndefined()
  })

  test("an account that was never re-tested and is not exhausted is not watched", () => {
    expect(stepExhaustedWatch(undefined, false, T0, SCHEDULE)).toEqual({
      watch: undefined,
      retest: false,
    })
  })
})

function routable(id: string, status: AccountStatus = "exhausted"): RoutableAccount {
  return {
    id,
    driver: { provider: "minimax" },
    snapshot: account(id, { provider: "minimax", status }),
  } as unknown as RoutableAccount
}

function lane(
  accounts: readonly RoutableAccount[],
  store: ExhaustedWatchStore = memoryExhaustedWatchStore(),
) {
  const rechecked: string[] = []
  const refuse = new Set<string>()
  const lines: Record<string, unknown>[] = []
  const logger = createLogger({ level: "info", write: (line) => void lines.push(JSON.parse(line)) })
  const statuses = new Map(accounts.map((held) => [held.id, held.snapshot.status]))
  const retest = createExhaustedRetest({
    recheck: async (accountId) => {
      rechecked.push(accountId)
      return refuse.has(accountId) ? ("refused" as const) : ("rechecked" as const)
    },
    schedule: SCHEDULE,
    store,
  })
  const tick = (atMs: number) =>
    retest({
      accounts: () => accounts,
      snapshot: (id) => {
        const held = accounts.find((candidate) => candidate.id === id)
        const status = statuses.get(id)
        return held === undefined || status === undefined ? undefined : { ...held.snapshot, status }
      },
      now: new Date(atMs),
      logger,
      signal: new AbortController().signal,
    })
  return { rechecked, lines, statuses, tick, refuse }
}

describe("the exhausted re-test lane", () => {
  test("no exhausted account goes a day without a re-test, and each one is an alert", async () => {
    const l = lane([routable("drained")])

    // Hourly ticks for three days: re-tests land at +1h, +3h, +7h, +15h, +31h, +54h.
    for (let hour = 0; hour <= 72; hour += 1) await l.tick(T0 + hour * HOUR)

    expect(l.rechecked).toEqual(["drained", "drained", "drained", "drained", "drained", "drained"])
    const alerts = l.lines.filter((line) => line.msg === "exhausted account re-tested")
    expect(alerts).toHaveLength(6)
    expect(alerts[0]).toMatchObject({ accountId: "drained", provider: "minimax", retest: 1 })
    expect(alerts[5]).toMatchObject({
      retest: 6,
      nextRetestAt: new Date(T0 + 73 * HOUR).toISOString(),
    })
  })

  test("an account that is not exhausted is never re-tested", async () => {
    const l = lane([routable("fine", "active"), routable("cooling", "cooling_down")])

    for (let hour = 0; hour <= 48; hour += 1) await l.tick(T0 + hour * HOUR)

    expect(l.rechecked).toEqual([])
  })

  test("a re-test that brought the account back ends the clock", async () => {
    const l = lane([routable("topped-up")])
    await l.tick(T0)
    await l.tick(T0 + HOUR)
    expect(l.rechecked).toEqual(["topped-up"])

    l.statuses.set("topped-up", "active")
    for (let hour = 2; hour <= 30; hour += 1) await l.tick(T0 + hour * HOUR)

    expect(l.rechecked).toEqual(["topped-up"])
  })

  test("a refused claim (an operator's check holds the lease) is no re-test: no count, no alert, retried next tick", async () => {
    const l = lane([routable("drained")])
    l.refuse.add("drained")
    await l.tick(T0)
    await l.tick(T0 + HOUR)
    expect(l.lines.filter((line) => line.msg === "exhausted account re-tested")).toHaveLength(0)

    l.refuse.delete("drained")
    await l.tick(T0 + 2 * HOUR)

    expect(l.rechecked).toEqual(["drained", "drained"])
    const alerts = l.lines.filter((line) => line.msg === "exhausted account re-tested")
    // The first re-test that ran is re-test 1, and the next waits the first doubling: 2 h.
    expect(alerts).toEqual([
      expect.objectContaining({ retest: 1, nextRetestAt: new Date(T0 + 4 * HOUR).toISOString() }),
    ])
  })

  // 03.7 (ruled): a thrown re-test may never have taken the claim, so it is treated like a refused
  // one — the stored count and wait stand and the next tick asks again.
  test("a failed re-test is logged and does not advance the clock", async () => {
    const lines: Record<string, unknown>[] = []
    let fail = true
    const store = memoryExhaustedWatchStore()
    const retest = createExhaustedRetest({
      recheck: async (): Promise<"rechecked"> => {
        if (fail) throw new Error("recovery repository unavailable")
        return "rechecked"
      },
      schedule: SCHEDULE,
      store,
    })
    const accounts = [routable("drained")]
    const tick = (atMs: number) =>
      retest({
        accounts: () => accounts,
        snapshot: () => accounts[0]?.snapshot,
        now: new Date(atMs),
        logger: createLogger({ level: "info", write: (line) => void lines.push(JSON.parse(line)) }),
        signal: new AbortController().signal,
      })

    await tick(T0)
    expect(await tick(T0 + HOUR)).toBe(0)
    expect(await store.list()).toEqual([
      { accountId: "drained", retests: 0, dueAt: new Date(T0 + HOUR), lastRetestAt: null },
    ])
    fail = false
    expect(await tick(T0 + 2 * HOUR)).toBe(1)

    expect(lines.filter((line) => line.msg === "exhausted account re-test failed")).toHaveLength(1)
    const alerts = lines.filter((line) => line.msg === "exhausted account re-tested")
    expect(alerts).toEqual([
      expect.objectContaining({ retest: 1, nextRetestAt: new Date(T0 + 4 * HOUR).toISOString() }),
    ])
  })
})

/** 07.6: the ladder outlives a replica hand-off and a restart. */
describe("the persisted ladder", () => {
  test("two instances alternating over one store produce the single-instance re-test instants", async () => {
    const single = lane([routable("drained")])
    for (let hour = 0; hour <= 72; hour += 1) await single.tick(T0 + hour * HOUR)

    const store = memoryExhaustedWatchStore()
    const a = lane([routable("drained")], store)
    const b = lane([routable("drained")], store)
    for (let hour = 0; hour <= 72; hour += 1) await (hour % 2 === 0 ? a : b).tick(T0 + hour * HOUR)

    const instants = (lines: Record<string, unknown>[]) =>
      lines.filter((line) => line.msg === "exhausted account re-tested").map((line) => line.retest)
    expect([...instants(a.lines), ...instants(b.lines)].sort()).toEqual(instants(single.lines))
    expect(a.rechecked.length + b.rechecked.length).toBe(single.rechecked.length)
  })

  test("a fresh instance over a store holding retests: 3 waits for dueAt", async () => {
    const store = memoryExhaustedWatchStore()
    await store.save("drained", {
      retests: 3,
      dueAt: new Date(T0 + 8 * HOUR),
      lastRetestAt: new Date(T0),
    })
    const restarted = lane([routable("drained")], store)
    for (let hour = 1; hour < 8; hour += 1) await restarted.tick(T0 + hour * HOUR)
    expect(restarted.rechecked).toEqual([])

    await restarted.tick(T0 + 8 * HOUR)
    expect(restarted.rechecked).toEqual(["drained"])
    expect((await store.list())[0]).toMatchObject({ retests: 4 })
  })

  test("a watch for an account no longer in the catalog is removed", async () => {
    const store = memoryExhaustedWatchStore()
    await store.save("gone", { retests: 1, dueAt: new Date(T0), lastRetestAt: null })
    await lane([routable("drained")], store).tick(T0)
    expect((await store.list()).map((row) => row.accountId)).toEqual(["drained"])
  })
})
