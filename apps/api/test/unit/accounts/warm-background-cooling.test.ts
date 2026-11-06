import { describe, expect, test } from "bun:test"
import type { AccountStatus } from "@multi-ai-router/core"
import { createWarmBackgroundStartGuard } from "../../../src/composition/background-admission"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"
import { accountRow } from "../../support/account-row"
import { account, NOW } from "../dataplane/fixtures"

function guard(
  status: AccountStatus,
  admitCooling: boolean,
  utilization = 0,
  cooldownReason?: "credential-rejected",
) {
  const row = accountRow()
  const current = account(row.id, { provider: row.provider })
  const live = {
    ...current.snapshot,
    status,
    health: {
      ...current.snapshot.health,
      ...(cooldownReason === undefined ? {} : { cooldownReason }),
    },
    quotaWindows: [
      {
        window: "seven_day" as const,
        utilization,
        utilizationSource: "continuous" as const,
        resetSource: "provider-reported" as const,
        resetsAt: new Date(NOW.getTime() + 3 * 86_400_000),
        lastCheckedAt: NOW,
      },
    ],
  }
  return createWarmBackgroundStartGuard(
    {
      accounts: { readEligibleBackgroundAccount: async () => row },
      catalog: { accounts: () => [current] },
      access: { currentSnapshot: () => live },
      now: () => NOW,
      quotaSpentThreshold: 1,
      admitCooling,
    },
    { ...row, authMaterial: current.authMaterial },
  )
}

describe("the cooldown recheck's start guard", () => {
  test("admits a cooling account and a spent window: they are what it came to look at", async () => {
    await guard("cooling_down", true)()
    await guard("active", true, 1)()
  })

  test.each(["exhausted", "needs_reauth", "disabled"] as const)(
    "refuses %s at the final boundary, whatever selected it",
    async (status) => {
      expect(guard(status, true)()).rejects.toBeInstanceOf(UpstreamAdmissionRefused)
    },
  )

  test("refuses a refused key: it has its own re-test clock", async () => {
    expect(guard("cooling_down", true, 0, "credential-rejected")()).rejects.toBeInstanceOf(
      UpstreamAdmissionRefused,
    )
  })

  test("ordinary background admission is unchanged: both still refuse", async () => {
    expect(guard("cooling_down", false)()).rejects.toBeInstanceOf(UpstreamAdmissionRefused)
    expect(guard("active", false, 1)()).rejects.toBeInstanceOf(UpstreamAdmissionRefused)
  })
})
