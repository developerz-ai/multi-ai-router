import { describe, expect, test } from "bun:test"
import { awaitsRouterRecovery } from "../../../src/services/dataplane/recovery-wait"
import type {
  BindingDecision,
  RejectedCandidate,
  SelectionDecision,
} from "../../../src/services/routing"

const NOW = new Date("2026-10-06T23:15:28.000Z")
const at = (ms: number) => new Date(NOW.getTime() + ms)
const DEADLINE = at(5_000)

function decision(
  rejected: readonly RejectedCandidate[],
  binding: BindingDecision = { state: "none" },
): SelectionDecision {
  return {
    scope: {
      scope: { kind: "all" },
      inScopeAccountIds: rejected.map((entry) => entry.accountId),
      unresolvedTargetIds: [],
    },
    groups: [],
    rejected,
    binding,
    usedOverflow: false,
  }
}

const routerHold = (id: string, resetsAt: Date = at(1_000)): RejectedCandidate => ({
  accountId: id,
  label: id,
  reason: "probe-in-flight",
  resetsAt,
  resetSource: "estimated",
})
const spent = (id: string): RejectedCandidate => ({
  accountId: id,
  label: id,
  reason: "quota-window-spent",
  window: "seven_day",
  resetsAt: at(2 * 86_400_000),
  resetSource: "provider-reported",
})

describe("awaitsRouterRecovery", () => {
  test("a provider-reported spent window alone is the honest answer — no wait", () => {
    expect(awaitsRouterRecovery(decision([spent("a"), spent("b")]), DEADLINE)).toBe(false)
  })

  test("permanent and human-owned states never wait", () => {
    const rejected: RejectedCandidate[] = [
      { accountId: "a", label: "a", reason: "exhausted" },
      { accountId: "b", label: "b", reason: "needs-reauth" },
      { accountId: "c", label: "c", reason: "disabled" },
      { accountId: "d", label: "d", reason: "model-unsupported" },
    ]
    expect(awaitsRouterRecovery(decision(rejected), DEADLINE)).toBe(false)
  })

  test("a provider-clocked cooldown is not the router's own hold", () => {
    const cooling: RejectedCandidate = {
      accountId: "a",
      label: "a",
      reason: "cooling-down",
      resetsAt: at(500),
      resetSource: "provider-reported",
    }
    expect(awaitsRouterRecovery(decision([cooling]), DEADLINE)).toBe(false)
  })

  test("probe-in-flight without the estimated source is not waited for", () => {
    const hold: RejectedCandidate = { ...routerHold("a"), resetSource: "provider-reported" }
    expect(awaitsRouterRecovery(decision([hold]), DEADLINE)).toBe(false)
  })

  test("a hold that releases only after the budget is not waited for", () => {
    expect(awaitsRouterRecovery(decision([routerHold("a", at(120_000))]), DEADLINE)).toBe(false)
  })

  test("every account held by the router's own recovery → wait (prod 23:15:28)", () => {
    const rejected = ["a", "b", "c", "d"].map((id) => routerHold(id))
    expect(awaitsRouterRecovery(decision(rejected), DEADLINE)).toBe(true)
  })

  test("a hold with no instant counts — it settles within a tick or a request", () => {
    const hold: RejectedCandidate = {
      accountId: "a",
      label: "a",
      reason: "probe-in-flight",
      resetSource: "estimated",
    }
    expect(awaitsRouterRecovery(decision([hold]), DEADLINE)).toBe(true)
  })

  test("mixed: one router-held account beside spent ones still waits — it may serve", () => {
    expect(awaitsRouterRecovery(decision([spent("a"), routerHold("b")]), DEADLINE)).toBe(true)
  })

  test("a binding blocked on a router hold waits, whatever else is rejected", () => {
    const binding: BindingDecision = {
      state: "blocked",
      accountId: "a",
      reason: "probe-in-flight",
      resetsAt: at(900),
      resetSource: "estimated",
    }
    expect(awaitsRouterRecovery(decision([spent("b")], binding), DEADLINE)).toBe(true)
  })

  test("a binding blocked on a spent window does not wait, even beside a held account", () => {
    const binding: BindingDecision = {
      state: "blocked",
      accountId: "a",
      reason: "quota-window-spent",
      resetsAt: at(86_400_000),
      resetSource: "provider-reported",
    }
    expect(awaitsRouterRecovery(decision([routerHold("b")], binding), DEADLINE)).toBe(false)
  })
})
