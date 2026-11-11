import { describe, expect, test } from "bun:test"
import type { RecoverySnapshot } from "../../../src/services/routing"
import { accountIsLiveHealthy } from "../../../src/services/routing/recovery-filter"
import { account, at, health, NOW, window } from "./fixtures"

const recovery = (state: RecoverySnapshot["state"]): RecoverySnapshot => ({
  revision: 1,
  generation: "g",
  lifecycleVersion: 1,
  state,
  nextAllowedAt: at(60_000),
  quotaRevisions: {},
})

// Plan 101, 03.1: the predicate that decides whether an operator re-check publishes a probe.
describe("accountIsLiveHealthy", () => {
  test("an active account with no clock, no spent window and no gate is live-healthy", () => {
    expect(accountIsLiveHealthy(account("a"), NOW, 1)).toBe(true)
    for (const state of ["succeeded", "cancelled"] as const)
      expect(accountIsLiveHealthy(account("a", { recovery: recovery(state) }), NOW, 1)).toBe(true)
  })

  test("anything holding the account out keeps it off the settled path", () => {
    const held = [
      account("a", { status: "cooling_down" }),
      account("a", { status: "exhausted" }),
      account("a", { status: "needs_reauth" }),
      account("a", { status: "disabled" }),
      account("a", { health: health({ cooldownUntil: at(1_000) }) }),
      account("a", {
        quotaWindows: [window("five_hour", { utilization: 1, resetsAt: at(60_000) })],
      }),
      ...(["pending", "issued", "failed", "uncertain"] as const).map((state) =>
        account("a", { recovery: recovery(state) }),
      ),
    ]
    for (const snapshot of held) expect(accountIsLiveHealthy(snapshot, NOW, 1)).toBe(false)
  })

  test("an expired breaker clock no longer holds the account out", () => {
    expect(
      accountIsLiveHealthy(account("a", { health: health({ cooldownUntil: at(-1) }) }), NOW, 1),
    ).toBe(true)
  })
})
