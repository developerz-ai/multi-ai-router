import { expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import {
  createRecheckService,
  type OperatorRecoveryRepository,
} from "../../../src/services/accounts/recheck"
import { accountRow } from "../../support/account-row"
import { operatorCheckRepository } from "../../support/operator-check-repository"

const REQUESTED = new Date("2026-10-03T18:00:00Z")
const NEXT = new Date("2026-10-03T18:01:00Z")
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function composed(
  repository: Pick<OperatorRecoveryRepository, "beginOperatorRecovery">,
  options: {
    barrier?: () => Promise<void>
    auditFails?: boolean
  } = {},
) {
  const events: string[] = []
  return {
    events,
    service: createRecheckService({
      accounts: { list: async () => [accountRow()], findById: async () => accountRow() },
      recovery: operatorCheckRepository({
        begin: repository.beginOperatorRecovery,
        find: () => accountRow(),
      }),
      cooldownSeconds: 60,
      refreshCatalog: async () => {
        events.push("barrier")
        await options.barrier?.()
      },
      onRecoveryRequested: () => {
        events.push("demand")
      },
      audit: {
        record: async () => {
          events.push("audit")
          if (options.auditFails) throw new Error("audit unavailable")
        },
      },
    }),
  }
}
function committed(account: AccountRow = accountRow()) {
  return {
    account,
    recovery: {
      generation: "generation-fixture",
      state: "pending" as const,
      requestedAt: REQUESTED,
      nextAllowedAt: NEXT,
      outcomeAt: null,
    },
    rechecked: true,
    clearedStatus: null,
  }
}

test("service returns durable database times and pending progress, not a healthy verdict", async () => {
  let suppliedCooldown: number | undefined
  const h = composed({
    beginOperatorRecovery: async (input) => {
      suppliedCooldown = input.cooldownMs
      return committed()
    },
  })
  const response = await h.service.recheck(accountRow().id)
  if (!response.ok) throw new Error("expected accepted request")
  expect(response.value).toMatchObject({
    rechecked: true,
    lastCheckedAt: REQUESTED.toISOString(),
    nextAllowedAt: NEXT.toISOString(),
    recovery: { generation: "generation-fixture", state: "pending", outcomeAt: null },
  })
  expect(suppliedCooldown).toBe(60_000)
  expect(JSON.stringify(response)).not.toContain("connected")
})

test("committed generation installs locally before demand, audit and response", async () => {
  const entered = deferred()
  const barrier = deferred()
  const h = composed(
    { beginOperatorRecovery: async () => committed() },
    {
      barrier: async () => {
        entered.resolve()
        await barrier.promise
      },
      auditFails: true,
    },
  )
  const result = h.service.recheck(accountRow().id)
  await entered.promise
  expect(h.events).toEqual(["barrier"])
  barrier.resolve()
  await expect(result).rejects.toThrow("audit unavailable")
  expect(h.events).toEqual(["barrier", "demand", "audit"])
})

test("reserved check joining an uncertain generation installs without another demand or audit", async () => {
  const prior = committed()
  const h = composed({
    beginOperatorRecovery: async () => ({
      ...prior,
      rechecked: false,
      recovery: { ...prior.recovery, state: "uncertain" },
    }),
  })
  const result = await h.service.recheck(accountRow().id)
  if (!result.ok) throw new Error("existing generation must be a normal response")
  expect(result.value.rechecked).toBe(false)
  expect(result.value.recovery?.state).toBe("uncertain")
  expect(result.value.lastCheckedAt).toBe(REQUESTED.toISOString())
  expect(h.events).toEqual(["barrier"])
})

test("two service instances expose the same atomic repository generation across a refused press", async () => {
  const prior = committed()
  let requested = false
  const repository: Pick<OperatorRecoveryRepository, "beginOperatorRecovery"> = {
    beginOperatorRecovery: async () => {
      const accepted = !requested
      requested = true
      return { ...prior, rechecked: accepted }
    },
  }
  const first = composed(repository)
  const second = composed(repository)
  const results = await Promise.all([
    first.service.recheck(prior.account.id),
    second.service.recheck(prior.account.id),
  ])
  expect(results.filter((result) => result.ok && result.value.rechecked)).toHaveLength(1)
  for (const result of results) {
    if (!result.ok) throw new Error("expected normal result")
    expect(result.value.recovery?.generation).toBe(prior.recovery.generation)
    expect(result.value.nextAllowedAt).toBe(NEXT.toISOString())
  }
  expect(first.events).toEqual(["barrier", "demand", "audit"])
  expect(second.events).toEqual(["barrier", "demand"])
})
