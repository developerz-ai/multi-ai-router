import { expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { createRuntimeMetrics } from "../../../src/observability"
import { createHealthStore } from "../../../src/services/dataplane"
import { createRecoveryAccess } from "../../../src/services/dataplane/recovery-access"
import { createRecoveryCapabilities } from "../../../src/services/dataplane/recovery-capability"
import type { RecoveryCoordinator } from "../../../src/services/recovery"
import { account, catalog, NOW } from "../dataplane/fixtures"

test("runtime inventory reads actual replica permits without consuming or requesting recovery", () => {
  const issued = account("issued", {
    snapshot: {
      recovery: {
        state: "issued",
        revision: 1,
        generation: "generation",
        lifecycleVersion: 0,
        nextAllowedAt: NOW,
        quotaRevisions: {},
      },
    },
  })
  const ordinary = account("ordinary")
  const raw = catalog(
    [issued, ordinary],
    [
      {
        id: "pool",
        name: "pool",
        policy: "priority-failover",
        members: [{ accountId: issued.id }, { accountId: ordinary.id }],
      },
    ],
  )
  const expected = {
    lifecycleVersion: issued.lifecycleVersion,
    authMaterial: issued.authMaterial,
    status: issued.snapshot.status,
  }
  const capabilities = createRecoveryCapabilities("local-boot", () => ({
    ...expected,
    generation: "generation",
    recoveryRevision: 1,
  }))
  let coordinatorCalls = 0
  const touched = () => {
    coordinatorCalls += 1
  }
  const coordinator: RecoveryCoordinator = {
    bootId: "local-boot",
    demand: touched,
    forget: touched,
    start: touched,
    requestAutomatic: () => {
      touched()
      return true
    },
    recordOutcome: () => {
      touched()
      return true
    },
    tick: async () => {
      touched()
    },
    stop: async () => {
      touched()
    },
  }
  const health = createHealthStore()
  const access = createRecoveryAccess({
    catalog: raw,
    readAccount: (id) => raw.accounts().find((row) => row.id === id),
    coordinator,
    health,
    capabilities,
    now: () => NOW,
    retryAfterMs: 1_000,
    quotaStaleAfterMs: 60_000,
  })
  const metrics = (source: typeof raw) =>
    createRuntimeMetrics({
      catalog: source,
      health,
      metricInventory: { pool: ["model"] },
      now: () => NOW,
      logger: createLogger({ level: "error", write: () => {} }),
      usage: () => ({
        stats: () => ({ depth: 0, dropped: 0, written: 0, writeFailures: 0, writeDiscarded: 0 }),
      }),
    })
  const permit = {
    revision: 1,
    accountId: issued.id,
    generation: "generation",
    permitId: "permit",
    ownerBootId: "foreign-boot",
    ownershipEpoch: 1,
    expected,
    quotaRevisions: {},
  }
  const recoverySample =
    'router_pool_model_available_accounts{pool_id="pool",model="model",admission="recovery"}'
  const ordinarySample =
    'router_pool_model_available_accounts{pool_id="pool",model="model",admission="ordinary"}'
  const decorated = metrics(access.catalog)
  expect(capabilities.install(permit)).toBe(false)
  expect(decorated.expose()).toContain(`${recoverySample} 0`)
  expect(capabilities.install({ ...permit, ownerBootId: "local-boot" })).toBe(true)
  // Raw persisted issued state cannot assert that this replica holds a usable permit.
  expect(metrics(raw).expose()).toContain(`${recoverySample} 0`)
  for (let scrape = 0; scrape < 3; scrape += 1) {
    const body = decorated.expose()
    expect(body).toContain(`${recoverySample} 1`)
    expect(body).toContain(`${ordinarySample} 1`)
    expect(capabilities.available(issued.id)?.permitId).toBe("permit")
  }
  expect(coordinatorCalls).toBe(0)
  expect(capabilities.consume(issued.id, "generation")?.permitId).toBe("permit")
  expect(decorated.expose()).toContain(`${recoverySample} 0`)
  expect(coordinatorCalls).toBe(0)
})
