import { expect, test } from "bun:test"
import { createRecoveryCoordinator } from "../../../src/services/recovery/coordinator"
import { fixture } from "./fixtures"

async function issued() {
  const f = fixture()
  f.coordinator.demand("account")
  await f.coordinator.tick()
  const capability = f.installed[0]
  if (capability === undefined) throw new Error("missing capability")
  const outcome = (state: "succeeded" | "failed" | "uncertain") => ({
    accountId: capability.accountId,
    generation: capability.generation,
    permitId: capability.permitId,
    ownershipEpoch: capability.ownershipEpoch,
    expected: capability.expected,
    state,
  })
  return { f, outcome }
}

// Prod 2026-11-02: `router_shutdown` queued this verdict, `stop()` dropped the queue, and the row
// stayed `issued` under a dead boot for RECOVERY_MAXIMUM_OUTCOME_MS, 429ing the whole account.
test("an attempt abandoned by shutdown writes its uncertain outcome before stop resolves", async () => {
  const { f, outcome } = await issued()
  expect(f.coordinator.recordOutcome(outcome("uncertain"))).toBe(true)
  await f.coordinator.stop()
  expect(f.state().state).toBe("uncertain")
  expect(f.counts().committed).toBe(1)
  expect(f.retired).toEqual(["generation"])
})

test("a verdict queued before shutdown is written as observed, not overwritten", async () => {
  const { f, outcome } = await issued()
  f.coordinator.recordOutcome(outcome("succeeded"))
  await f.coordinator.stop()
  expect(f.state().state).toBe("succeeded")
})

test("an issued permit with no verdict settles uncertain, never succeeded", async () => {
  const { f } = await issued()
  await f.coordinator.stop()
  expect(f.state().state).toBe("uncertain")
  expect(f.retired).toEqual(["generation"])
})

test("issuance already committing when stop begins is settled, not stranded", async () => {
  const f = fixture()
  const original = f.deps.repository.issue
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  f.deps.repository.issue = async (input) => {
    entered.resolve()
    await gate.promise
    return original(input)
  }
  f.coordinator.demand("account")
  const ticking = f.coordinator.tick()
  await entered.promise
  const stopping = f.coordinator.stop()
  gate.resolve()
  await stopping
  await ticking
  expect(f.counts().issued).toBe(1)
  expect(f.installed).toHaveLength(0)
  expect(f.state().state).toBe("uncertain")
})

test("a stopping boot never settles a permit another live boot owns", async () => {
  const { f } = await issued()
  const owner = f.state().ownerBootId
  await createRecoveryCoordinator(f.deps).stop()
  expect(f.state().state).toBe("issued")
  expect(f.state().ownerBootId).toBe(owner)
  expect(f.retired).toEqual([])
})

test("closing issuance stops new permits while outcomes keep flowing through the HTTP drain", async () => {
  const pending = fixture()
  let assigned = 0
  const assign = pending.deps.repository.assignPending
  pending.deps.repository.assignPending = async (input) => {
    assigned++
    return assign(input)
  }
  pending.coordinator.closeIssuance()
  pending.coordinator.demand("account")
  await pending.coordinator.tick()
  expect(assigned).toBe(0)
  expect(pending.counts().issued).toBe(0)

  const { f, outcome } = await issued()
  f.coordinator.closeIssuance()
  f.coordinator.recordOutcome(outcome("succeeded"))
  await f.coordinator.tick()
  expect(f.state().state).toBe("succeeded")
})

test("no pending permit is issued after stop", async () => {
  const f = fixture()
  await f.coordinator.stop()
  f.coordinator.demand("account")
  await f.coordinator.tick()
  expect(f.counts().issued).toBe(0)
  expect(f.state().state).toBe("pending")
})

test("a lost outcome write still settles the permit uncertain and stop resolves", async () => {
  const { f, outcome } = await issued()
  f.coordinator.recordOutcome(outcome("succeeded"))
  f.outcomeDown(true)
  await f.coordinator.stop()
  expect(f.state().state).toBe("uncertain")
})

test("a stalled settlement is bounded by the drain deadline and warns", async () => {
  const { f } = await issued()
  const warnings: string[] = []
  const scheduled: { delay: number; run: () => void }[] = []
  const coordinator = createRecoveryCoordinator({
    ...f.deps,
    warn: (message) => warnings.push(message),
    schedule: (run, delay) => {
      scheduled.push({ run, delay })
      return () => {}
    },
    repository: {
      ...f.deps.repository,
      settleIssuedForOwner: () => new Promise(() => {}),
    },
  })
  const stopping = coordinator.stop()
  scheduled.find((entry) => entry.delay === 20)?.run()
  await stopping
  expect(warnings.some((message) => message.includes("drain timed out"))).toBe(true)
})

test("a failed settlement sweep warns and stop still resolves", async () => {
  const f = fixture()
  const warnings: string[] = []
  const coordinator = createRecoveryCoordinator({
    ...f.deps,
    warn: (message) => warnings.push(message),
    repository: {
      ...f.deps.repository,
      settleIssuedForOwner: async () => {
        throw new Error("DB unavailable")
      },
    },
  })
  await coordinator.stop()
  expect(warnings).toHaveLength(1)
})

test("after the drain deadline, no further sweep runs and a restart waits for the old drain", async () => {
  const { f } = await issued()
  const gate = Promise.withResolvers<void>()
  const scheduled: { delay: number; run: () => void }[] = []
  let sweeps = 0
  const coordinator = createRecoveryCoordinator({
    ...f.deps,
    schedule: (run, delay) => {
      scheduled.push({ run, delay })
      return () => {}
    },
    repository: {
      ...f.deps.repository,
      settleIssuedForOwner: async () => {
        sweeps += 1
        await gate.promise
        // A full batch would ask for another sweep, which the expired drain must not run.
        return Array.from({ length: f.deps.config.batchSize }, () => f.state())
      },
    },
  })
  const stopping = coordinator.stop()
  scheduled.find((entry) => entry.delay === f.deps.config.shutdownDrainMs)?.run()
  await stopping
  const armedBefore = scheduled.length
  coordinator.start()
  expect(scheduled.length).toBe(armedBefore)
  gate.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(sweeps).toBe(1)
  coordinator.start()
  expect(scheduled.length).toBe(armedBefore + 1)
})
