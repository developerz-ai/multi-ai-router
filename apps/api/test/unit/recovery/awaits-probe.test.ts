import { expect, test } from "bun:test"
import type { RecoverySnapshot } from "../../../src/services/routing"
import { recoveryAwaitsProbe } from "../../../src/services/routing/recovery-filter"
import { account, at, continuous, health, NOW } from "../routing/fixtures"

function recovery(
  state: RecoverySnapshot["state"],
  nextAllowedAt: Date = at(-1),
): RecoverySnapshot {
  return {
    revision: 1,
    generation: "generation",
    lifecycleVersion: 1,
    state,
    nextAllowedAt,
    quotaRevisions: {},
  }
}

test("failed and uncertain recoveries past nextAllowedAt await the router's probe", () => {
  for (const state of ["failed", "uncertain"] as const)
    expect(recoveryAwaitsProbe(account("a", { recovery: recovery(state) }), NOW, 0.98)).toBe(true)
  // A breaker that already elapsed is the half-open case, not a hold.
  expect(
    recoveryAwaitsProbe(
      account("a", {
        status: "cooling_down",
        recovery: recovery("uncertain"),
        health: health({ cooldownUntil: at(-1) }),
      }),
      NOW,
      0.98,
    ),
  ).toBe(true)
})

test("every other recovery state, and a recovery inside nextAllowedAt, does not", () => {
  expect(recoveryAwaitsProbe(account("a"), NOW, 0.98)).toBe(false)
  for (const state of ["pending", "issued", "succeeded", "cancelled"] as const)
    expect(recoveryAwaitsProbe(account("a", { recovery: recovery(state) }), NOW, 0.98)).toBe(false)
  expect(
    recoveryAwaitsProbe(account("a", { recovery: recovery("failed", at(1)) }), NOW, 0.98),
  ).toBe(false)
})

test("a human-owned status, a running breaker clock or a spent window keeps it off", () => {
  for (const status of ["disabled", "exhausted", "needs_reauth"] as const)
    expect(
      recoveryAwaitsProbe(account("a", { status, recovery: recovery("failed") }), NOW, 0.98),
    ).toBe(false)
  expect(
    recoveryAwaitsProbe(
      account("a", {
        status: "cooling_down",
        recovery: recovery("failed"),
        health: health({ cooldownUntil: at(60_000) }),
      }),
      NOW,
      0.98,
    ),
  ).toBe(false)
  expect(
    recoveryAwaitsProbe(
      account("a", {
        recovery: recovery("uncertain"),
        quotaWindows: [{ ...continuous(1), resetsAt: at(3_600_000) }],
      }),
      NOW,
      0.98,
    ),
  ).toBe(false)
})
