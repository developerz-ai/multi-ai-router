import { expect, test } from "bun:test"
import type { RecheckResult } from "../../src/lib/api/accounts"
import { recoveryPresentation } from "../../src/routes/accounts/recovery-presentation"

const local = {
  accountId: "a",
  lastCheckedAt: "2026-10-03T12:02:00Z",
  nextAllowedAt: "2026-10-03T12:03:00Z",
  rechecked: true,
  recovery: {
    generation: "new",
    state: "issued",
    outcomeAt: null,
    nextAllowedAt: "2026-10-03T12:03:00Z",
  },
} satisfies RecheckResult
test("fresh local generation cannot combine its timestamp with stale server progress", () => {
  const result = recoveryPresentation(
    {
      requestedAt: "2026-10-03T12:00:00Z",
      recovery: { ...local.recovery, generation: "old", state: "failed" },
    },
    local,
  )
  expect(result).toEqual({ requestedAt: local.lastCheckedAt, recovery: local.recovery })
})
test("a newer server generation replaces all local presentation facts together", () => {
  const server = {
    requestedAt: "2026-10-03T12:04:00Z",
    recovery: { ...local.recovery, generation: "newer", state: "pending" as const },
  }
  expect(recoveryPresentation(server, local)).toBe(server)
})
test("same-generation terminal outcome supersedes issued, while stale pending cannot regress it", () => {
  const server = {
    requestedAt: local.lastCheckedAt,
    recovery: { ...local.recovery, state: "succeeded" as const, outcomeAt: "2026-10-03T12:02:30Z" },
  }
  expect(recoveryPresentation(server, local)).toBe(server)
  expect(
    recoveryPresentation(
      { ...server, recovery: { ...server.recovery, state: "pending", outcomeAt: null } },
      local,
    ).recovery?.state,
  ).toBe("issued")
})
