import { expect, test } from "bun:test"
import {
  createAccountRepository,
  createCatalogSnapshotRepository,
  createDatabase,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import { createRecoveryComponents, recoveryProbeSender } from "../../src/composition/recovery"
import { readRecoveryEnv } from "../../src/config/recovery"
import { createLogger } from "../../src/logging/logger"
import { createRecheckService } from "../../src/services/accounts/recheck"
import { createTestNowService } from "../../src/services/accounts/test-now"
import { createRoutingCatalog, loadCatalog } from "../../src/services/catalog"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
import { createHealthStore, type FetchLike } from "../../src/services/dataplane"

/**
 * Prod, 2026-11-05: zai and MiniMax sat `uncertain` because each recovery permit waited exactly
 * `RECOVERY_MAXIMUM_OUTCOME_MS` for a client request that never came. These boot the real recovery
 * components against Postgres with no client traffic at all.
 */
const databaseUrl = process.env.DATABASE_URL ?? ""
const logger = createLogger({ level: "error", write: () => {} })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function completion(): Response {
  return new Response(
    JSON.stringify({
      id: "fixture",
      object: "chat.completion",
      model: "glm-4.6",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }),
    { headers: { "content-type": "application/json" } },
  )
}

async function routerProbeFixture(
  fetch: FetchLike,
  options: { attach?: boolean; graceMs?: number; cooldownMs?: number } = {},
) {
  await runMigrations({ url: databaseUrl, migrationsFolder: defaultMigrationsFolder() })
  const handle = createDatabase({ url: databaseUrl, maxConnections: 4 })
  const accounts = createAccountRepository(handle.db)
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
  const account = await accounts.create({
    label: "router recovery probe integration",
    provider: "zai",
    authMaterial: cipher.encrypt("fixture-key"),
  })
  // A breaker clock far longer than any wait below, so only a real hold-off can explain silence.
  const health = createHealthStore({ jitter: () => 0, baseBackoffMs: 60_000 })
  let components: ReturnType<typeof createRecoveryComponents> | undefined
  const catalog = createRoutingCatalog({
    load: () => loadCatalog(createCatalogSnapshotRepository(handle.db)),
    refreshIntervalMs: 1000,
    onInstalled: (rows) => components?.reconcile(rows),
  })
  components = createRecoveryComponents({
    database: handle.db,
    accounts,
    health,
    catalog,
    config: readRecoveryEnv({
      RECOVERY_MAXIMUM_OUTCOME_MS: 1_000,
      RECOVERY_REQUEST_WAIT_MS: options.graceMs ?? 0,
      ...(options.cooldownMs === undefined ? {} : { RECOVERY_COOLDOWN_MS: options.cooldownMs }),
    }).recovery,
    logger,
    now: () => new Date(),
    probeModels: { zai: "glm-4.6" },
  })
  await catalog.refresh()
  const testNow = createTestNowService({
    accounts,
    cipher,
    audit: { record: async () => {} },
    cooldownSeconds: 0,
    timeoutMs: 5_000,
    now: () => new Date(),
    fetch,
    health,
  })
  const recheck = createRecheckService({
    accounts,
    recovery: components.repository,
    cooldownSeconds: 1,
    audit: { record: async () => {} },
    refreshCatalog: () => catalog.refreshAfterMutation(),
    onRecoveryRequested: (id) => components?.coordinator.demand(id),
  })
  // Exactly as `composition/index.ts` wires it.
  const attach = () => components?.probe.attach(recoveryProbeSender(testNow))
  if (options.attach !== false) attach()
  const recovery = async () =>
    (await loadCatalog(createCatalogSnapshotRepository(handle.db))).accounts.find(
      (candidate) => candidate.id === account.id,
    )?.recovery
  return {
    account,
    components,
    health,
    recheck,
    recovery,
    attach,
    async close() {
      await components?.coordinator.stop()
      await accounts.delete(account.id)
      await handle.close()
    },
  }
}

test.skipIf(!databaseUrl)(
  "a re-check with no client traffic is probed by the router, not left to end uncertain",
  async () => {
    let starts = 0
    const f = await routerProbeFixture(async () => {
      starts++
      return completion()
    })
    try {
      const opened = await f.recheck.recheck(f.account.id)
      expect(opened.ok && opened.value.recovery?.state).toBe("pending")
      await f.components.coordinator.tick()
      expect((await f.recovery())?.state).toBe("issued")
      // No client request, ever. Past the outcome bound, today's permit is declared uncertain.
      await sleep(1_200)
      await f.components.coordinator.tick()
      await f.components.coordinator.tick()
      expect((await f.recovery())?.state).toBe("succeeded")
      expect(starts).toBe(1)
    } finally {
      await f.close()
    }
  },
  20_000,
)

test.skipIf(!databaseUrl)(
  "an uncertain recovery past nextAllowedAt is reopened and probed with no client",
  async () => {
    let starts = 0
    const f = await routerProbeFixture(
      async () => {
        starts++
        return completion()
      },
      { attach: false },
    )
    try {
      await f.recheck.recheck(f.account.id)
      await f.components.coordinator.tick()
      await sleep(1_200)
      await f.components.coordinator.tick()
      // The prod fingerprint, reproduced with no transport attached: nothing sent, uncertain.
      expect((await f.recovery())?.state).toBe("uncertain")
      expect(starts).toBe(0)
      f.attach()
      // One tick reopens it (its 1s nextAllowedAt has passed), issues the permit and offers it.
      await f.components.coordinator.tick()
      await sleep(200)
      await f.components.coordinator.tick()
      expect(starts).toBe(1)
      expect((await f.recovery())?.state).toBe("succeeded")
    } finally {
      await f.close()
    }
  },
  20_000,
)

test.skipIf(!databaseUrl)(
  "a failed router probe is sent once and its breaker clock holds off the next reopen",
  async () => {
    let starts = 0
    const f = await routerProbeFixture(
      async () => {
        starts++
        return new Response(JSON.stringify({ error: { message: "upstream down" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      },
      // The failed outcome's own nextAllowedAt passes at once; only the breaker can hold it.
      { cooldownMs: 1 },
    )
    try {
      await f.recheck.recheck(f.account.id)
      await f.components.coordinator.tick()
      await sleep(200)
      await f.components.coordinator.tick()
      expect((await f.recovery())?.state).toBe("failed")
      expect(starts).toBe(1)
      const until = f.health.stateOf(f.account.id).breaker.cooldownUntil
      expect(until === undefined ? 0 : until.getTime()).toBeGreaterThan(Date.now())
      for (let i = 0; i < 5; i++) {
        await f.components.coordinator.tick()
        await sleep(100)
      }
      // No new generation either: the breaker's clock keeps the account out of the reopen sweep,
      // and the permit's own start guard would refuse a send under it anyway.
      expect((await f.recovery())?.state).toBe("failed")
      expect(starts).toBe(1)
    } finally {
      await f.close()
    }
  },
  20_000,
)

test.skipIf(!databaseUrl)(
  "a client request that takes the permit inside the wait budget leaves the router nothing to send",
  async () => {
    let starts = 0
    const f = await routerProbeFixture(
      async () => {
        starts++
        return completion()
      },
      { graceMs: 300 },
    )
    try {
      await f.recheck.recheck(f.account.id)
      await f.components.coordinator.tick()
      const permit = f.components.capabilities.available(f.account.id)
      expect(permit).toBeDefined()
      // The same consume a client request's final start guard performs (`recovery-access.ts`).
      expect(
        f.components.capabilities.consume(f.account.id, permit?.generation ?? ""),
      ).toBeDefined()
      await sleep(500)
      expect(starts).toBe(0)
    } finally {
      await f.close()
    }
  },
  20_000,
)
