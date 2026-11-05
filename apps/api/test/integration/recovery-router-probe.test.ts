import { expect, test } from "bun:test"
import { isRouterError } from "@multi-ai-router/core"
import {
  type ApiKeyRepository,
  type ApiKeyRow,
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
import {
  createDispatcher,
  createHealthStore,
  type FetchLike,
  type VerifiedKey,
} from "../../src/services/dataplane"
import type { RecoveryProbeSend } from "../../src/services/dataplane/recovery-probe"

/**
 * Prod, 2026-11-05: zai and MiniMax sat `uncertain` because each recovery permit waited exactly
 * `RECOVERY_MAXIMUM_OUTCOME_MS` for a client request that never came. These boot the real recovery
 * components against Postgres; no client request is sent unless a test says so.
 */
const databaseUrl = process.env.DATABASE_URL ?? ""
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

/** Key scopes as the reach reads them, without leaving rows behind in a shared database. */
function keysReaching(
  reach: "all" | "none",
): Pick<ApiKeyRepository, "list" | "listTargetsForKeys"> {
  const key = { id: crypto.randomUUID(), scope: "all", revoked: false, expiresAt: null }
  return {
    list: async () => (reach === "all" ? [key as unknown as ApiKeyRow] : []),
    listTargetsForKeys: async () => ({ pools: [], accounts: [] }),
  }
}

async function routerProbeFixture(
  fetch: FetchLike,
  options: {
    attach?: boolean
    graceMs?: number
    cooldownMs?: number
    reach?: "all" | "none"
    testNowCooldownSeconds?: number
    provider?: "zai" | "anthropic-oauth"
  } = {},
) {
  await runMigrations({ url: databaseUrl, migrationsFolder: defaultMigrationsFolder() })
  const handle = createDatabase({ url: databaseUrl, maxConnections: 4 })
  const accounts = createAccountRepository(handle.db)
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
  const account = await accounts.create({
    label: "router recovery probe integration",
    provider: options.provider ?? "zai",
    ...(options.provider === "anthropic-oauth"
      ? { configDir: "/nonexistent/router-probe" }
      : { authMaterial: cipher.encrypt("fixture-key") }),
  })
  const lines: string[] = []
  const logger = createLogger({ level: "info", write: (line) => lines.push(line) })
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
    keys: keysReaching(options.reach ?? "all"),
    reachTtlMs: 1000,
    config: readRecoveryEnv({
      RECOVERY_MAXIMUM_OUTCOME_MS: 1_000,
      RECOVERY_REQUEST_WAIT_MS: options.graceMs ?? 0,
      ...(options.cooldownMs === undefined ? {} : { RECOVERY_COOLDOWN_MS: options.cooldownMs }),
    }).recovery,
    logger,
    now: () => new Date(),
    probeModels: { zai: "glm-4.6", "anthropic-oauth": "claude-haiku-4-5-20251001" },
  })
  await catalog.refresh()
  const audits: unknown[] = []
  // No `sdkProbe`: a Claude subscription here is an account the transport cannot test.
  const testNow = createTestNowService({
    accounts,
    cipher,
    audit: {
      record: async (event) => {
        audits.push(event.detail)
      },
    },
    cooldownSeconds: options.testNowCooldownSeconds ?? 0,
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
  const dispatcher = createDispatcher({
    catalog,
    health,
    cipher,
    usage: { record: () => {} },
    fetch,
    recovery: components.access,
  })
  const key: VerifiedKey = {
    id: crypto.randomUUID(),
    name: "test",
    prefix: "test",
    scope: { kind: "accounts", accountIds: [account.id] },
    rateLimitRequests: null,
    rateLimitWindowSeconds: null,
    expiresAt: null,
  }
  const dispatch = () =>
    dispatcher
      .dispatch({
        ingress: "openai-chat",
        key,
        requestId: crypto.randomUUID(),
        request: new Request("https://router.test/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "ping" }] }),
        }),
      })
      .catch((error) => {
        if (isRouterError(error)) return new Response(error.message, { status: error.status })
        throw error
      })
  // Exactly as `composition/index.ts` wires it.
  const attach = (sender: RecoveryProbeSend = recoveryProbeSender(testNow)) =>
    components?.probe.attach(sender)
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
    testNow,
    dispatch,
    recovery,
    attach,
    lines,
    audits,
    async close() {
      await components?.coordinator.stop()
      await accounts.delete(account.id)
      await handle.close()
    },
  }
}

/** An operator re-check, then the tick that issues and installs its permit. */
async function openPermit(f: Awaited<ReturnType<typeof routerProbeFixture>>) {
  const opened = await f.recheck.recheck(f.account.id)
  expect(opened.ok && opened.value.recovery?.state).toBe("pending")
  await f.components.coordinator.tick()
  expect((await f.recovery())?.state).toBe("issued")
}

/** Wait past the 1 s outcome bound and the 1 s re-check cooldown, then let the coordinator settle. */
async function pastBounds(f: Awaited<ReturnType<typeof routerProbeFixture>>) {
  await sleep(1_200)
  await f.components.coordinator.tick()
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
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
      await openPermit(f)
      // No client request, ever. Without the router's probe, this permit is past the outcome bound
      // by now and settles uncertain (the prod fingerprint).
      await pastBounds(f)
      await f.components.coordinator.tick()
      expect((await f.recovery())?.state).toBe("succeeded")
      expect(starts).toBe(1)
      expect(f.audits).toContainEqual({
        provider: "zai",
        outcome: "ok",
        trigger: "router_recovery",
      })
    } finally {
      await f.close()
    }
  },
  20_000,
)

test.skipIf(!databaseUrl)("the router waits out a non-zero grace before it probes", async () => {
  let starts = 0
  const f = await routerProbeFixture(
    async () => {
      starts++
      return completion()
    },
    { graceMs: 300 },
  )
  try {
    await openPermit(f)
    await sleep(100)
    expect(starts).toBe(0)
    await sleep(400)
    expect(starts).toBe(1)
    await f.components.coordinator.tick()
    expect((await f.recovery())?.state).toBe("succeeded")
  } finally {
    await f.close()
  }
})

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
      await openPermit(f)
      await pastBounds(f)
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
  "an uncertain recovery no usable key reaches is not reopened",
  async () => {
    let starts = 0
    const f = await routerProbeFixture(
      async () => {
        starts++
        return completion()
      },
      { attach: false, reach: "none" },
    )
    try {
      await openPermit(f)
      await pastBounds(f)
      expect((await f.recovery())?.state).toBe("uncertain")
      f.attach()
      await f.components.coordinator.tick()
      await sleep(200)
      await f.components.coordinator.tick()
      expect(starts).toBe(0)
      expect((await f.recovery())?.state).toBe("uncertain")
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
      await openPermit(f)
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

const limitedFor = (ms: number) => ({
  limited: true,
  resetsAt: new Date(Date.now() + ms),
  resetSource: "provider-reported" as const,
  windows: [],
})

test.skipIf(!databaseUrl)(
  "a success is recorded before the probe's rate-limit reading, as on the client path",
  async () => {
    const f = await routerProbeFixture(async () => completion(), { attach: false, graceMs: 300 })
    try {
      // The provider served the probe and reported its window now spent. Folded first, the
      // reading advances the verdict, the success is refused as stale, and the reset trips on top
      // of the two strikes the success should have cleared.
      f.attach(async ({ startGuard, rateLimitSink }) => {
        await startGuard()
        rateLimitSink(limitedFor(3_600_000))
        return { kind: "answered", ok: true, message: "200" }
      })
      await openPermit(f)
      const strike = { kind: "server-error" as const, message: "earlier strike" }
      f.health.recordFailure(f.account.id, strike, new Date())
      f.health.recordFailure(f.account.id, strike, new Date())
      expect(f.health.stateOf(f.account.id).breaker.consecutiveFailures).toBe(2)
      await sleep(500)
      const breaker = f.health.stateOf(f.account.id).breaker
      expect(breaker.status).toBe("cooling_down")
      expect(breaker.consecutiveFailures).toBe(1)
    } finally {
      await f.close()
    }
  },
  20_000,
)

test.skipIf(!databaseUrl)(
  "a drained balance reporting a limited window still lands exhausted",
  async () => {
    const f = await routerProbeFixture(async () => completion(), { attach: false })
    try {
      f.attach(async ({ startGuard, rateLimitSink }) => {
        await startGuard()
        rateLimitSink(limitedFor(3_600_000))
        return { kind: "answered", ok: false, failureKind: "credits-exhausted", message: "402" }
      })
      await openPermit(f)
      await sleep(200)
      expect(f.health.stateOf(f.account.id).breaker.status).toBe("exhausted")
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
      await openPermit(f)
      const response = await f.dispatch()
      expect(response.status).toBe(200)
      expect(starts).toBe(1)
      await sleep(500)
      expect(starts).toBe(1)
    } finally {
      await f.close()
    }
  },
  20_000,
)

test.skipIf(!databaseUrl)(
  "a client request during the router's probe is refused as probe-in-flight, never sent",
  async () => {
    let starts = 0
    const release = deferred()
    const f = await routerProbeFixture(async () => {
      starts++
      await release.promise
      return completion()
    })
    try {
      await openPermit(f)
      await sleep(100)
      expect(starts).toBe(1)
      const response = await f.dispatch()
      expect(response.status).toBe(429)
      expect(starts).toBe(1)
      release.resolve()
      await sleep(100)
      await f.components.coordinator.tick()
      expect((await f.recovery())?.state).toBe("succeeded")
    } finally {
      release.resolve()
      await f.close()
    }
  },
  20_000,
)

test.skipIf(!databaseUrl)(
  "closing issuance during the grace period cancels the router's probe",
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
      await openPermit(f)
      f.components.closeIssuance()
      await sleep(500)
      expect(starts).toBe(0)
    } finally {
      await f.close()
    }
  },
  20_000,
)

test.skipIf(!databaseUrl)(
  "an operator's Test now inside its cooldown does not eat the router's probe",
  async () => {
    let starts = 0
    const f = await routerProbeFixture(
      async () => {
        starts++
        return completion()
      },
      { testNowCooldownSeconds: 120 },
    )
    try {
      const pressed = await f.testNow.test(f.account.id, { model: "glm-4.6" })
      expect(pressed.ok && pressed.value.tested).toBe(true)
      await openPermit(f)
      await sleep(200)
      await f.components.coordinator.tick()
      expect(starts).toBe(2)
      expect((await f.recovery())?.state).toBe("succeeded")
      expect(f.audits).toEqual([
        { provider: "zai", outcome: "ok", trigger: "operator" },
        { provider: "zai", outcome: "ok", trigger: "router_recovery" },
      ])
    } finally {
      await f.close()
    }
  },
  20_000,
)

test.skipIf(!databaseUrl)(
  "an account the transport cannot test is logged once and not reopened every outcome bound",
  async () => {
    let starts = 0
    const f = await routerProbeFixture(
      async () => {
        starts++
        return completion()
      },
      { provider: "anthropic-oauth" },
    )
    try {
      await openPermit(f)
      await sleep(200)
      const refusals = () =>
        f.lines.filter((line) => line.includes("router recovery probe cannot reach this account"))
      expect(refusals()).toHaveLength(1)
      await pastBounds(f)
      expect((await f.recovery())?.state).toBe("uncertain")
      await f.components.coordinator.tick()
      await sleep(200)
      await f.components.coordinator.tick()
      expect((await f.recovery())?.state).toBe("uncertain")
      expect(refusals()).toHaveLength(1)
      expect(starts).toBe(0)
    } finally {
      await f.close()
    }
  },
  20_000,
)
