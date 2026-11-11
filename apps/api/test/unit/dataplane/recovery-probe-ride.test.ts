import { describe, expect, test } from "bun:test"
import { QuotaExhaustedError } from "@multi-ai-router/core"
import {
  createRecoveryWaiter,
  selectThroughRecovery,
} from "../../../src/services/dataplane/recovery-wait"
import type { SelectionDecision, SelectionResult } from "../../../src/services/routing"
import { clock } from "./fixtures"

/**
 * Plan 101, 12.5 (tesote, 2026-11-09 20:02): a zai recovery probe took 21 s to settle while every
 * waiter's 5 s budget ran out behind it, so the router answered `429` with the account about to
 * serve. Past the budget, a hold that is a probe already on the wire is ridden to its outcome.
 */

function held(retryAtMs: number): SelectionDecision {
  return {
    scope: { scope: { kind: "all" }, inScopeAccountIds: ["zai"], unresolvedTargetIds: [] },
    groups: [],
    rejected: [
      {
        accountId: "zai",
        label: "zai",
        reason: "probe-in-flight",
        resetsAt: new Date(retryAtMs),
        resetSource: "estimated",
      },
    ],
    binding: { state: "none" },
    usedOverflow: false,
  }
}

function scenario(options: { probeBudgetMs?: number; probing: boolean }) {
  const testClock = clock()
  let waited = 0
  const waiter = createRecoveryWaiter({
    options: {
      budgetMs: 5_000,
      intervalMs: 250,
      ...(options.probeBudgetMs === undefined ? {} : { probeBudgetMs: options.probeBudgetMs }),
    },
    clock: testClock,
    sleep: async (ms) => testClock.advance(ms),
    signal: new AbortController().signal,
    onWaited: (ms) => {
      waited += ms
    },
  })
  // The probe settles 8 s in; until then the account is held, its retryAt always a second out.
  const select = (): SelectionResult => {
    const now = testClock.now().getTime()
    const decision = held(now + 1_000)
    if (testClock.elapsed() >= 8_000)
      return { ok: true, candidates: [], decision: { ...decision, rejected: [] } }
    return { ok: false, error: new QuotaExhaustedError("held"), decision }
  }
  const run = () => selectThroughRecovery(select, waiter, testClock.now, () => options.probing)
  return { run, clock: testClock, waited: () => waited }
}

describe("riding a recovery probe in flight", () => {
  test("a probe settling at 8 s serves a waiter whose budget is 5 s", async () => {
    const it = scenario({ probeBudgetMs: 30_000, probing: true })
    const selection = await it.run()
    expect(selection.ok).toBe(true)
    expect(it.clock.elapsed()).toBe(8_000)
    // Every millisecond asleep is reported, so overhead accounting can leave it out (12.4).
    expect(it.waited()).toBe(8_000)
  })

  test("without a configured probe budget the 5 s budget still ends the wait", async () => {
    const it = scenario({ probing: true })
    expect((await it.run()).ok).toBe(false)
    expect(it.clock.elapsed()).toBe(5_000)
  })

  test("a hold with no probe on the wire is not ridden past the budget", async () => {
    const it = scenario({ probeBudgetMs: 30_000, probing: false })
    expect((await it.run()).ok).toBe(false)
    // Today's rule alone: the hold is waited for only while its retryAt fits inside the budget.
    expect(it.clock.elapsed()).toBeLessThanOrEqual(5_000)
  })

  test("the ride is bounded by the probe budget", async () => {
    const it = scenario({ probeBudgetMs: 6_000, probing: true })
    expect((await it.run()).ok).toBe(false)
    expect(it.clock.elapsed()).toBe(6_000)
  })
})
