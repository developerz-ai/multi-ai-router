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
import { selectAccounts } from "../../src/services/routing"
import { pool, account as routingAccount, snapshot } from "../unit/routing/fixtures"

/**
 * Prod, 2026-11-05: zai and MiniMax sat `uncertain` because each recovery permit waited exactly
 * `RECOVERY_MAXIMUM_OUTCOME_MS` for a client request that never came. These boot the real recovery
 * components against Postgres; no client request is sent unless a test says so.
 */
const databaseUrl = process.env.DATABASE_URL ?? ""
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The file's clocks, scaled from production's so fifteen boots of the real components cost seconds,
 * not a quarter of a minute. What each proves is a ratio, and the ratios are kept:
 *
 * - `OUTCOME_BOUND_MS` (`RECOVERY_MAXIMUM_OUTCOME_MS`) is several times any wait a test spends with
 *   a permit `issued` and a tick still to come, so only a deliberate {@link pastBounds} expires one.
 * - `GRACE_MS` (`RECOVERY_REQUEST_WAIT_MS`) is four times `INSIDE_GRACE_MS`, the instant a test
 *   asserts the router has not sent yet, and `PAST_GRACE_MS` is well past it.
 * - `QUIET_MS` is how long "nothing was sent" is watched for where the send, were it coming, is a
 *   microtask-and-a-stub away: every positive counterpart in this file lands within a few ms.
 *
 * A wait for something that **does** happen never sleeps a guess: it polls {@link until}.
 */
const OUTCOME_BOUND_MS = 300
const GRACE_MS = 200
const INSIDE_GRACE_MS = 50
const PAST_GRACE_MS = GRACE_MS + 100
const QUIET_MS = 100

/** Resolves as soon as `condition` holds; fails the test, naming what never came, after `withinMs`. */
async function until(what: string, condition: () => boolean, withinMs = 3_000): Promise<void> {
  const deadline = Date.now() + withinMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

/** Idempotent, and the same schema every time: applied once for the file, not once per fixture. */
let migrated: Promise<unknown> | undefined
const migrate = () => {
  migrated ??= runMigrations({ url: databaseUrl, migrationsFolder: defaultMigrationsFolder() })
  return migrated
}

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
    backoffMs?: number
    provider?: "zai" | "anthropic-oauth"
    supportedModels?: string[]
  } = {},
) {
  await migrate()
  const handle = createDatabase({ url: databaseUrl, maxConnections: 4 })
  const accounts = createAccountRepository(handle.db)
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
  const account = await accounts.create({
    label: "router recovery probe integration",
    provider: options.provider ?? "zai",
    ...(options.provider === "anthropic-oauth"
      ? // Unique per run: `config_dir` is unique, and a fixture path reused across runs makes the
        // insert collide with a row a previous aborted run left behind, which is not the failure
        // this test is about.
        { configDir: `/nonexistent/router-probe-${crypto.randomUUID()}` }
      : { authMaterial: cipher.encrypt("fixture-key") }),
    ...(options.supportedModels === undefined ? {} : { supportedModels: options.supportedModels }),
  })
  const lines: string[] = []
  const logger = createLogger({ level: "info", write: (line) => lines.push(line) })
  // A breaker clock far longer than any wait below, so only a real hold-off can explain silence.
  const health = createHealthStore({ jitter: () => 0, baseBackoffMs: options.backoffMs ?? 60_000 })
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
      RECOVERY_MAXIMUM_OUTCOME_MS: OUTCOME_BOUND_MS,
      RECOVERY_REQUEST_WAIT_MS: options.graceMs ?? 0,
      ...(options.cooldownMs === undefined ? {} : { RECOVERY_COOLDOWN_MS: options.cooldownMs }),
    }).recovery,
    logger,
    now: () => new Date(),
    probeModels: { zai: "glm-4.6", "anthropic-oauth": "claude-haiku-4-5-20251001" },
  })
  await catalog.refresh()
  // Every verdict a probe or a client request hands the coordinator, counted where it arrives.
  let verdicts = 0
  const { coordinator } = components
  const recordOutcome = coordinator.recordOutcome.bind(coordinator)
  coordinator.recordOutcome = (outcome) => {
    verdicts++
    return recordOutcome(outcome)
  }
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
    // The re-check's generation carries this as its `nextAllowedAt`: the same span as the outcome
    // bound, so `pastBounds` is past both and an expired permit is reopenable when it says so.
    cooldownSeconds: OUTCOME_BOUND_MS / 1_000,
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
  const dispatch = (extra: { stream?: boolean } = {}) =>
    dispatcher
      .dispatch({
        ingress: "openai-chat",
        key,
        requestId: crypto.randomUUID(),
        request: new Request("https://router.test/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: "glm-4.6",
            messages: [{ role: "user", content: "ping" }],
            ...extra,
          }),
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
    verdicts: () => verdicts,
    async close() {
      await components?.coordinator.stop()
      await accounts.delete(account.id)
      await handle.close()
    },
  }
}

function expireCooldown(f: Awaited<ReturnType<typeof routerProbeFixture>>) {
  const now = Date.now()
  f.health.recordFailure(
    f.account.id,
    { kind: "rate-limited", status: 429, message: "limited", resetsAt: new Date(now - 1) },
    new Date(now - 60_000),
  )
}

function selected(f: Awaited<ReturnType<typeof routerProbeFixture>>): string | undefined {
  const primary = f.components.access.currentSnapshot(f.account.id)
  if (primary === undefined) throw new Error("missing primary")
  const fallback = routingAccount("fallback", { priority: 10, provider: primary.provider })
  const choice = selectAccounts(
    snapshot(
      [primary, fallback],
      [pool("team", [primary.id, fallback.id], { policy: "priority-failover" })],
      new Date(),
    ),
    { sessionKey: "new", model: "glm-4.6", keyScope: { kind: "pools", poolIds: ["team"] } },
  )
  return choice.ok ? choice.candidates[0]?.account.id : undefined
}

test.skipIf(!databaseUrl)(
  "expired primary is automatically probed and wins priority failover",
  async () => {
    let starts = 0
    const f = await routerProbeFixture(async () => {
      starts++
      return completion()
    })
    try {
      expireCooldown(f)
      expect(await f.recovery()).toBeUndefined()
      expect(selected(f)).toBe("fallback")
      await f.components.coordinator.tick()
      await probeSettled(f)
      expect(starts).toBe(1)
      expect((await f.recovery())?.state).toBe("succeeded")
      expect(selected(f)).toBe(f.account.id)
    } finally {
      await f.close()
    }
  },
  20_000,
)

test.skipIf(!databaseUrl)(
  "an expired cooldown's 429 is durably bounded before retry",
  async () => {
    let starts = 0
    const f = await routerProbeFixture(
      async () => {
        starts++
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        })
      },
      { cooldownMs: 3_000, backoffMs: 50 },
    )
    try {
      expireCooldown(f)
      expect(await f.recovery()).toBeUndefined()
      await f.components.coordinator.tick()
      await probeSettled(f)
      const failed = await f.recovery()
      expect(failed?.state).toBe("failed")
      expect(failed?.nextAllowedAt.getTime()).toBeGreaterThan(Date.now())
      for (let i = 0; i < 3; i++) await f.components.coordinator.tick()
      expect(starts).toBe(1)
      const breakerUntil = f.health.stateOf(f.account.id).breaker.cooldownUntil
      expect(breakerUntil).toBeDefined()
      if (breakerUntil === undefined || failed === undefined)
        throw new Error("missing retry clocks")
      await sleep(Math.max(0, breakerUntil.getTime() - Date.now()) + 50)
      expect(Date.now()).toBeGreaterThanOrEqual(breakerUntil.getTime())
      expect(Date.now()).toBeLessThan(failed.nextAllowedAt.getTime())
      await f.components.coordinator.tick()
      await sleep(QUIET_MS)
      expect(Date.now()).toBeLessThan(failed.nextAllowedAt.getTime())
      expect((await f.recovery())?.state).toBe("failed")
      expect(starts).toBe(1)
      await sleep(Math.max(0, (failed?.nextAllowedAt.getTime() ?? 0) - Date.now()) + 50)
      await f.components.coordinator.tick()
      await until("second probe verdict", () => f.verdicts() === 2)
      await f.components.coordinator.tick()
      expect(starts).toBe(2)
    } finally {
      await f.close()
    }
  },
  20_000,
)

/** An operator re-check, then the tick that issues and installs its permit. */
async function openPermit(f: Awaited<ReturnType<typeof routerProbeFixture>>) {
  const opened = await f.recheck.recheck(f.account.id)
  expect(opened.ok && opened.value.recovery?.state).toBe("pending")
  await f.components.coordinator.tick()
  expect((await f.recovery())?.state).toBe("issued")
}

/**
 * Wait past the outcome bound and the re-check cooldown (the generation's `nextAllowedAt`), then let
 * the coordinator settle. Both are judged on Postgres's clock, and the expiry sweep runs at most
 * once per coordinator interval (250 ms), so the wait clears all three with room.
 */
async function pastBounds(f: Awaited<ReturnType<typeof routerProbeFixture>>) {
  await sleep(OUTCOME_BOUND_MS + 100)
  await f.components.coordinator.tick()
}

/**
 * The probe's verdict has been handed to the coordinator: one tick now writes it. Counted at the
 * coordinator's own door (`fixture.verdicts`) rather than slept for, and never found by ticking in
 * a loop — a tick that ran before the verdict was queued would only wait, but one
 * that ran past the outcome bound would expire the permit this is waiting on.
 */
async function probeSettled(f: Awaited<ReturnType<typeof routerProbeFixture>>) {
  await until("the router's probe to hand in its verdict", () => f.verdicts() > 0)
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
      // by now and settles uncertain (the prod fingerprint). The verdict is waited for rather than
      // assumed to fit inside the bound: on a stalled runner it can land after it, and the tick
      // below would then expire the permit for a reason this test is not about.
      await until("the router's probe to hand in its verdict", () => f.verdicts() > 0)
      await pastBounds(f)
      await f.components.coordinator.tick()
      expect((await f.recovery())?.state).toBe("succeeded")
      expect(starts).toBe(1)
      expect(f.audits).toContainEqual({
        provider: "zai",
        outcome: "ok",
        model: "glm-4.6",
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
    { graceMs: GRACE_MS },
  )
  try {
    const opened = Date.now()
    await openPermit(f)
    await sleep(INSIDE_GRACE_MS)
    expect(starts).toBe(0)
    await until("the probe the grace was holding back", () => starts === 1)
    // Sent because the grace ran out, not ahead of it.
    expect(Date.now() - opened).toBeGreaterThanOrEqual(GRACE_MS)
    await probeSettled(f)
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
      // One tick reopens it (its nextAllowedAt has passed), issues the permit and offers it.
      await f.components.coordinator.tick()
      await probeSettled(f)
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
      await sleep(QUIET_MS)
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
      await probeSettled(f)
      expect((await f.recovery())?.state).toBe("failed")
      expect(starts).toBe(1)
      const until = f.health.stateOf(f.account.id).breaker.cooldownUntil
      expect(until === undefined ? 0 : until.getTime()).toBeGreaterThan(Date.now())
      for (let i = 0; i < 5; i++) {
        await f.components.coordinator.tick()
        await sleep(QUIET_MS / 5)
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
    const f = await routerProbeFixture(async () => completion(), {
      attach: false,
      graceMs: GRACE_MS,
    })
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
      await until("the probe's verdict", () => f.verdicts() > 0)
      // The reading is folded by the probe's caller right after the verdict.
      await until(
        "the probe's rate-limit reading",
        () => f.health.stateOf(f.account.id).breaker.status === "cooling_down",
      )
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
      await until("the probe's verdict", () => f.verdicts() > 0)
      // The reading is folded after the verdict; it must not turn a drained balance into a cooldown.
      await sleep(QUIET_MS / 5)
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
      { graceMs: GRACE_MS },
    )
    try {
      await openPermit(f)
      const response = await f.dispatch()
      expect(response.status).toBe(200)
      expect(starts).toBe(1)
      await sleep(PAST_GRACE_MS)
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
      await until("the router's probe to be on the wire", () => starts === 1)
      const response = await f.dispatch()
      expect(response.status).toBe(429)
      expect(starts).toBe(1)
      release.resolve()
      await probeSettled(f)
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
      { graceMs: GRACE_MS },
    )
    try {
      await openPermit(f)
      f.components.closeIssuance()
      await sleep(PAST_GRACE_MS)
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
      await probeSettled(f)
      expect(starts).toBe(2)
      expect((await f.recovery())?.state).toBe("succeeded")
      expect(f.audits).toEqual([
        { provider: "zai", outcome: "ok", model: "glm-4.6", trigger: "operator" },
        { provider: "zai", outcome: "ok", model: "glm-4.6", trigger: "router_recovery" },
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
      const refusals = () =>
        f.lines.filter((line) => line.includes("router recovery probe cannot reach this account"))
      await until("the probe to say it cannot reach the account", () => refusals().length === 1)
      await pastBounds(f)
      expect((await f.recovery())?.state).toBe("uncertain")
      await f.components.coordinator.tick()
      await sleep(QUIET_MS)
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

/** The model each upstream request named, read off the probe's own body. */
async function modelOf(request: Request): Promise<string> {
  return ((await request.clone().json()) as { model: string }).model
}

test.skipIf(!databaseUrl)(
  "the probe asks for the account's first declared model, the provider default only without one",
  async () => {
    for (const [declared, expected] of [
      [["glm-5", "glm-4.6"], "glm-5"],
      [undefined, "glm-4.6"],
    ] as const) {
      const models: string[] = []
      const f = await routerProbeFixture(
        async (request) => {
          models.push(await modelOf(request))
          return completion()
        },
        declared === undefined ? {} : { supportedModels: [...declared] },
      )
      try {
        await openPermit(f)
        await probeSettled(f)
        expect(models).toEqual([expected])
        expect((await f.recovery())?.state).toBe("succeeded")
      } finally {
        await f.close()
      }
    }
  },
  20_000,
)

test.skipIf(!databaseUrl)(
  "a probe whose model the upstream no longer serves settles uncertain, not succeeded",
  async () => {
    let starts = 0
    const f = await routerProbeFixture(async () => {
      starts++
      // Prod 2026-11-05, MiniMax: the endpoint answered, about a model it retired.
      return new Response(
        JSON.stringify({ error: { message: 'The model "glm-4.6" is no longer available' } }),
        { status: 404, headers: { "content-type": "application/json" } },
      )
    })
    try {
      await openPermit(f)
      await probeSettled(f)
      expect(starts).toBe(1)
      expect((await f.recovery())?.state).toBe("uncertain")
      const breaker = f.health.stateOf(f.account.id).breaker
      expect(breaker.status).toBe("active")
      expect(breaker.consecutiveFailures).toBe(0)
      const refusals = () =>
        f.lines.filter((line) => line.includes("router recovery probe was refused as a request"))
      expect(refusals()).toHaveLength(1)
      expect(refusals()[0]).toContain('"model":"glm-4.6"')
      expect(refusals()[0]).toContain('"modelSource":"provider-default"')
      // Not re-probed on every reopen with a model already refused.
      await pastBounds(f)
      await f.components.coordinator.tick()
      await sleep(QUIET_MS)
      await f.components.coordinator.tick()
      expect(starts).toBe(1)
      expect(refusals()).toHaveLength(1)
    } finally {
      await f.close()
    }
  },
  20_000,
)

test.skipIf(!databaseUrl)(
  "after a refused probe, a client request takes the next permit and the recovery succeeds",
  async () => {
    let starts = 0
    const f = await routerProbeFixture(
      async () => {
        starts++
        return starts === 1
          ? new Response(
              JSON.stringify({ error: { message: 'The model "glm-4.6" is no longer available' } }),
              { status: 404, headers: { "content-type": "application/json" } },
            )
          : completion()
      },
      // The refused probe's own nextAllowedAt passes at once, so a client can open the next one.
      { cooldownMs: 1 },
    )
    try {
      await openPermit(f)
      await probeSettled(f)
      expect((await f.recovery())?.state).toBe("uncertain")
      // The first client request finds the account gated and files the automatic request.
      expect((await f.dispatch()).status).toBe(429)
      await f.components.coordinator.tick()
      expect((await f.recovery())?.state).toBe("issued")
      await sleep(QUIET_MS)
      // The router does not race the client for it: this account's probe was refused.
      expect(starts).toBe(1)
      expect((await f.dispatch()).status).toBe(200)
      expect(starts).toBe(2)
      await f.components.coordinator.tick()
      expect((await f.recovery())?.state).toBe("succeeded")
    } finally {
      await f.close()
    }
  },
  20_000,
)

/**
 * The opening of an Anthropic message stream through its first text delta. The fixture's `zai`
 * account answers on its Anthropic surface, so this is what the upstream sends and the client reads
 * it translated to `chat.completion.chunk`.
 */
function firstContentFrames(text: string): Uint8Array {
  const events: readonly [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "fixture",
          type: "message",
          role: "assistant",
          model: "glm-4.6",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
  ]
  return new TextEncoder().encode(
    events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
  )
}

/**
 * Prod, 2026-11-23 23:13Z: a probe's answer streamed for 33.5 s and held the account's one permit
 * for all of it. A request that arrived a second in waited its whole 30 s budget and was answered
 * `429`, three seconds before the stream ended and the account reopened. A recovering account is
 * proved by its first model output; how the stream ends is still the breaker's to hear.
 */
test.skipIf(!databaseUrl)(
  "a streaming probe reopens the account at its first content, and a later break still strikes",
  async () => {
    let starts = 0
    const firstContent = deferred()
    const breaks = deferred()
    const f = await routerProbeFixture(
      async () => {
        starts++
        if (starts > 1) return completion()
        // The probe: nothing until the test says so, one content frame, then open until it breaks.
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            await firstContent.promise
            controller.enqueue(firstContentFrames("partial"))
            await breaks.promise
            controller.error(new Error("upstream connection reset"))
          },
        })
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
      },
      // No router probe: the client's own streaming request is the designated one.
      { attach: false },
    )
    try {
      await openPermit(f)
      const probing = f.dispatch({ stream: true })
      await until("the client's request to take the permit upstream", () => starts === 1)

      // Before any model output the account has proved nothing: still one request, not two.
      expect((await f.dispatch()).status).toBe(429)
      expect(starts).toBe(1)
      expect(f.verdicts()).toBe(0)

      firstContent.resolve()
      const response = await probing
      expect(response.status).toBe(200)
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      // The client holds the first content; the upstream has said nothing since.
      let seen = ""
      while (!seen.includes("partial")) {
        const next = await reader.read()
        if (next.done) break
        seen += new TextDecoder().decode(next.value)
      }
      expect(seen).toContain("partial")

      // Settled at the first content, with the stream still open behind it.
      await until("the probe to settle at its first content", () => f.verdicts() === 1)
      await f.components.coordinator.tick()
      expect((await f.recovery())?.state).toBe("succeeded")
      expect(f.health.stateOf(f.account.id).breaker.status).toBe("active")

      // The next request reaches the account while the probe's answer is still streaming.
      expect((await f.dispatch()).status).toBe(200)
      expect(starts).toBe(2)

      // The stream breaks after the success was stored: the breaker still hears it.
      breaks.resolve()
      for (;;) {
        const next = await reader.read().catch(() => ({ done: true as const }))
        if (next.done) break
      }
      await until(
        "the broken stream to strike the breaker",
        () => f.health.stateOf(f.account.id).breaker.consecutiveFailures === 1,
      )
      // One verdict for the permit, not a second one overwriting it at the end of the stream.
      expect(f.verdicts()).toBe(1)
      await f.components.coordinator.tick()
      expect((await f.recovery())?.state).toBe("succeeded")
    } finally {
      firstContent.resolve()
      breaks.resolve()
      await f.close()
    }
  },
  20_000,
)
