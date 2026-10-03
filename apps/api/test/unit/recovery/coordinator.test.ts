import { expect, test } from "bun:test"
import { createRecoveryCoordinator } from "../../../src/services/recovery/coordinator"
import { fixture } from "./fixtures"

test("only demand issues; simultaneous ticks join and catalog precedes capability", async () => {
  const f = fixture()
  await f.coordinator.tick()
  expect(f.counts().issued).toBe(0)
  f.coordinator.demand("account")
  const held = f.holdCatalog()
  const first = f.coordinator.tick()
  const second = f.coordinator.tick()
  expect(first).toBe(second)
  for (let i = 0; i < 20 && f.counts().catalogCalls === 0; i++) await Promise.resolve()
  expect(f.counts().issued).toBe(1)
  expect(f.installed).toHaveLength(0)
  held.resolve()
  await first
  await f.coordinator.tick()
  expect(f.installed).toHaveLength(1)
  expect(f.counts().issued).toBe(1)
})
test("issuance acknowledgment loss hydrates same permit without second issuance", async () => {
  const f = fixture()
  f.ackLost()
  f.coordinator.demand("account")
  await f.coordinator.tick()
  expect(f.installed).toHaveLength(0)
  const permit = f.state().permitId
  await f.coordinator.tick()
  expect(f.installed[0]?.permitId === permit).toBe(true)
  expect(f.counts().issued).toBe(1)
  expect(f.counts().catalogCalls).toBeGreaterThan(0)
})
test("outcome DB retry retains exact permit and never issues again", async () => {
  const f = fixture()
  f.coordinator.demand("account")
  await f.coordinator.tick()
  const cap = f.installed[0]
  if (cap === undefined) throw new Error("missing capability")
  f.outcomeDown(true)
  expect(
    f.coordinator.recordOutcome({
      accountId: cap.accountId,
      generation: cap.generation,
      permitId: cap.permitId,
      ownershipEpoch: cap.ownershipEpoch,
      expected: cap.expected,
      state: "succeeded",
    }),
  ).toBe(true)
  await f.coordinator.tick()
  expect(f.counts().committed).toBe(0)
  f.outcomeDown(false)
  await f.coordinator.tick()
  await f.coordinator.tick()
  expect(f.counts().committed).toBe(1)
  expect(f.counts().issued).toBe(1)
  expect(f.retired).toEqual(["generation"])
})
test("boot identity is genuine per construction and old owner is never hydrated", async () => {
  const f = fixture()
  f.coordinator.demand("account")
  await f.coordinator.tick()
  const restarted = createRecoveryCoordinator({
    ...f.deps,
    install: () => {
      throw new Error("old owner reused")
    },
  })
  expect(restarted.bootId).not.toBe(f.coordinator.bootId)
  await restarted.tick()
  expect(f.counts().issued).toBe(1)
})

test("automatic hint is immutable, joins off path, and never creates idle issuance", async () => {
  const f = fixture()
  let begins = 0
  let captured: unknown
  f.deps.repository.beginAutomaticRecovery = async (input) => {
    begins++
    captured = input
    return f.state()
  }
  const expected = { lifecycleVersion: 1, authMaterial: "cipher", status: "active" as const }
  expect(
    f.coordinator.requestAutomatic({
      accountId: "account",
      expected,
      expectedRecoveryRevision: null,
      reason: "cooldown-expired",
    }),
  ).toBe(true)
  expected.authMaterial = "mutated"
  expect(begins).toBe(0)
  await f.coordinator.tick()
  expect(captured).toMatchObject({
    expected: { authMaterial: "cipher" },
    expectedRecoveryRevision: null,
  })
  expect(begins).toBe(1)
  expect(f.counts().issued).toBe(0)
  f.coordinator.demand("account")
  await f.coordinator.tick()
  expect(f.counts().issued).toBe(1)
})
test("shutdown bounds a stalled catalog and suppresses late capability installation", async () => {
  const f = fixture()
  const scheduled: { delay: number; run: () => void; cancelled: boolean }[] = []
  const coordinator = createRecoveryCoordinator({
    ...f.deps,
    schedule: (run, delay) => {
      const entry = { run, delay, cancelled: false }
      scheduled.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
  })
  const held = f.holdCatalog()
  coordinator.demand("account")
  const ticking = coordinator.tick()
  for (let i = 0; i < 30 && f.counts().catalogCalls === 0; i++) await Promise.resolve()
  const stopping = coordinator.stop()
  scheduled.find((entry) => entry.delay === 20)?.run()
  await stopping
  held.resolve()
  await ticking
  expect(f.installed).toHaveLength(0)
  expect(f.counts().issued).toBe(1)
})

test("automatic queue is bounded and rejects superseded older lifecycle hints", async () => {
  const f = fixture()
  const hint = {
    accountId: "account",
    expected: { lifecycleVersion: 2, authMaterial: "cipher", status: "active" as const },
    expectedRecoveryRevision: null,
    reason: "quota-stale" as const,
  }
  expect(f.coordinator.requestAutomatic(hint)).toBe(true)
  expect(
    f.coordinator.requestAutomatic({
      ...hint,
      expected: { ...hint.expected, lifecycleVersion: 1 },
    }),
  ).toBe(false)
  expect(f.coordinator.requestAutomatic({ ...hint, accountId: "second" })).toBe(true)
  expect(f.coordinator.requestAutomatic({ ...hint, accountId: "third" })).toBe(false)
})
test("automatic acknowledgment loss retries stable candidate and never issues idle grant", async () => {
  const f = fixture()
  const candidates: string[] = []
  f.deps.repository.beginAutomaticRecovery = async (input) => {
    candidates.push(input.generationCandidate)
    if (candidates.length === 1) throw new Error("acknowledgment lost")
    return f.state()
  }
  f.coordinator.requestAutomatic({
    accountId: "account",
    expected: { lifecycleVersion: 1, authMaterial: "cipher", status: "active" },
    expectedRecoveryRevision: null,
    reason: "cooldown-expired",
  })
  await f.coordinator.tick()
  await f.coordinator.tick()
  expect(candidates).toHaveLength(2)
  expect(candidates[0]).toBe(candidates[1])
  expect(f.counts().issued).toBe(0)
})
test("demanded IDs are queried directly instead of an undemanded oldest page", async () => {
  const f = fixture()
  let requested: readonly string[] = []
  const original = f.deps.repository.listPending
  f.deps.repository.listPending = async (input) => {
    requested = input.accountIds
    return original(input)
  }
  f.coordinator.demand("account")
  await f.coordinator.tick()
  expect(requested).toEqual(["account"])
  expect(f.counts().issued).toBe(1)
})
test("uncertain issued permit retires without pending ownership or new issuance", async () => {
  const f = fixture()
  f.coordinator.demand("account")
  await f.coordinator.tick()
  f.deps.repository.listExpiredIssued = async () => [f.state()]
  f.deps.repository.markUncertain = async () => ({ ...f.state(), state: "uncertain" })
  f.coordinator.demand("account")
  await f.coordinator.tick()
  expect(f.counts().issued).toBe(1)
  expect(f.installed).toHaveLength(1)
  expect(f.retired).toEqual(["generation"])
})

test("rejected install retries hydration and catalog without reissuing permit", async () => {
  const f = fixture()
  let attempts = 0
  const coordinator = createRecoveryCoordinator({
    ...f.deps,
    install: (cap) => {
      if (++attempts === 1) return false
      f.installed.push(cap)
      return true
    },
  })
  coordinator.demand("account")
  await coordinator.tick()
  expect(f.installed).toHaveLength(0)
  await coordinator.tick()
  expect(f.installed).toHaveLength(1)
  expect(f.counts().issued).toBe(1)
  expect(attempts).toBe(2)
})

test("forget after authoritative deletion drops queued hints and outcomes", async () => {
  const f = fixture()
  f.coordinator.requestAutomatic({
    accountId: "account",
    expected: { lifecycleVersion: 1, authMaterial: "cipher", status: "active" },
    expectedRecoveryRevision: null,
    reason: "quota-stale",
  })
  f.coordinator.demand("account")
  f.coordinator.forget("account")
  await f.coordinator.tick()
  expect(f.counts().issued).toBe(0)
  expect(f.installed).toHaveLength(0)
})
