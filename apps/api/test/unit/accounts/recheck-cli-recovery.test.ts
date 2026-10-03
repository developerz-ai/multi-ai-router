import { expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import {
  createRecheckService,
  type OperatorRecoveryRepository,
} from "../../../src/services/accounts/recheck"
import type { AccountAuthProbe } from "../../../src/services/health/claudeAuthProbe"
import { accountRow } from "../../support/account-row"
import { operatorCheckRepository } from "../../support/operator-check-repository"

function harness(
  initial: AccountRow,
  auth: AccountAuthProbe,
  begin: OperatorRecoveryRepository["beginOperatorRecovery"],
  read: OperatorRecoveryRepository["readOperatorCooldown"] = async () => undefined,
) {
  let row = initial
  let demanded = 0
  const service = createRecheckService({
    accounts: { findById: async () => row, list: async () => [row] },
    auth,
    recovery: operatorCheckRepository({ begin, read, find: () => row }),
    cooldownSeconds: 60,
    refreshCatalog: async () => {},
    audit: { record: async () => {} },
    onRecoveryRequested: () => {
      demanded++
    },
  })
  return {
    service,
    current: () => row,
    replace: (next: AccountRow) => {
      row = next
    },
    demanded: () => demanded,
  }
}
function result(account: AccountRow, state: "pending" | "cancelled") {
  return {
    account,
    rechecked: true,
    clearedStatus: null,
    recovery: {
      generation: "generation",
      state,
      requestedAt: new Date("2026-10-03T18:00:00Z"),
      nextAllowedAt: new Date("2026-10-03T18:01:00Z"),
      outcomeAt: null,
    },
  }
}
function report(loggedIn: boolean) {
  return {
    loggedIn,
    email: "private@example.test",
    subscriptionType: null,
    statusChangedTo: null,
    checkedAt: "2026-10-03T18:00:00Z",
  }
}

test("positive CLI recovery finishes before atomic recheck captures the new lifecycle", async () => {
  const original = accountRow({ status: "needs_reauth", lifecycleVersion: 7 })
  const h = harness(
    original,
    {
      check: async (subject) => {
        expect(subject.lifecycleVersion).toBe(7)
        h.replace({ ...original, status: "active", lifecycleVersion: 8, authRecoveryVersion: 1 })
        return { ...report(true), statusChangedTo: "active" }
      },
    },
    async (input) => {
      expect(input.negativeAuthObservation).toBeUndefined()
      expect(h.current().lifecycleVersion).toBe(8)
      return result({ ...h.current(), lifecycleVersion: 9, healthRecoveryVersion: 1 }, "pending")
    },
  )
  const response = await h.service.recheck(original.id)
  expect(response.ok).toBe(true)
  expect(h.demanded()).toBe(1)
})

test("negative CLI evidence keeps exhausted status and never schedules a permit", async () => {
  const original = accountRow({ status: "exhausted", lifecycleVersion: 4, authMaterial: "cipher" })
  const h = harness(original, { check: async () => report(false) }, async (input) => {
    expect(input.negativeAuthObservation).toEqual({
      lifecycleVersion: 4,
      authMaterial: "cipher",
      loggedIn: false,
    })
    return result({ ...original, lifecycleVersion: 5, healthRecoveryVersion: 1 }, "cancelled")
  })
  const response = await h.service.recheck(original.id)
  if (!response.ok) throw new Error("expected result")
  expect(response.value.clearedStatus).toBeUndefined()
  expect(response.value.recovery?.state).toBe("cancelled")
  expect(h.demanded()).toBe(0)
})

test("disable while CLI is paused is preserved by the fresh atomic recheck", async () => {
  const original = accountRow({ lifecycleVersion: 3 })
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = harness(
    original,
    {
      check: async () => {
        entered()
        await paused
        return report(true)
      },
    },
    async () => {
      expect(h.current().status).toBe("disabled")
      return result({ ...h.current(), lifecycleVersion: 5, healthRecoveryVersion: 1 }, "cancelled")
    },
  )
  const request = h.service.recheck(original.id)
  await started
  h.replace({ ...original, status: "disabled", lifecycleVersion: 4 })
  release()
  const response = await request
  expect(response.ok).toBe(true)
  expect(h.demanded()).toBe(0)
})

test("durable cooldown skips a positive CLI mutation until expiry", async () => {
  const original = accountRow({ status: "needs_reauth", lifecycleVersion: 7 })
  let expired = false
  let cliCalls = 0
  let begins = 0
  const h = harness(
    original,
    {
      check: async () => {
        cliCalls++
        h.replace({ ...original, lifecycleVersion: 8, authRecoveryVersion: 1, status: "active" })
        return report(true)
      },
    },
    async () => {
      begins++
      return result(h.current(), "pending")
    },
    async () => {
      return expired ? undefined : { ...result(original, "cancelled"), rechecked: false }
    },
  )
  const held = await h.service.recheck(original.id)
  expect(held.ok && held.value.rechecked).toBe(false)
  expect(cliCalls).toBe(0)
  expect(begins).toBe(0)
  expect(h.current().lifecycleVersion).toBe(7)
  expect(h.demanded()).toBe(0)
  expired = true
  const accepted = await h.service.recheck(original.id)
  expect(accepted.ok && accepted.value.rechecked).toBe(true)
  expect(cliCalls).toBe(1)
  expect(h.current().lifecycleVersion).toBe(8)
})

test("concurrent presses within one service await one authentication probe", async () => {
  const original = accountRow()
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const h = harness(
    original,
    {
      check: async () => {
        calls++
        entered()
        await paused
        return null
      },
    },
    async () => result(original, "pending"),
  )
  const first = h.service.recheck(original.id)
  await started
  const second = h.service.recheck(original.id)
  expect(second).toBe(first)
  expect(calls).toBe(1)
  release()
  expect(await second).toEqual(await first)
  expect(h.demanded()).toBe(1)
})
