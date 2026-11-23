import { describe, expect, test } from "bun:test"
import { isRouterError } from "@multi-ai-router/core"
import {
  accounts,
  type BreakerObservation,
  createAccountBreakerRepository,
  createCatalogSnapshotRepository,
  createRecoveryRepository,
} from "@multi-ai-router/db"
import { eq } from "drizzle-orm"
import { createAccountRepository } from "../../../../packages/db/src/repositories/account-repository"
import {
  historyUrl as url,
  usageHistoryFixture,
} from "../../../../packages/db/test/integration/usage-history-fixture"
import { createLogger } from "../../src/logging/logger"
import { loadCatalog } from "../../src/services/catalog/load"
import { createRoutingCatalog } from "../../src/services/catalog/store"
import { createDispatcher } from "../../src/services/dataplane"
import { createBreakerWriter } from "../../src/services/dataplane/breaker-writer"
import { createHealthStore } from "../../src/services/dataplane/health"
import { accountHealthFacts } from "../../src/services/dataplane/health-observation"
import type { BreakerState } from "../../src/services/routing"
import { globalRecoveryFixture } from "./global-recovery-fixture"

const fixture = usageHistoryFixture()
describe.skipIf(!url)("replica breaker propagation", () => {
  test("writer and catalog timers propagate without manual flush or refresh", async () => {
    const account = await createAccountRepository(fixture.db()).create({
      provider: "zai",
      label: "timer-propagation",
    })
    const snapshots = createCatalogSnapshotRepository(fixture.db())
    const b = createHealthStore()
    let installed: (() => void) | undefined
    const propagated = new Promise<void>((resolve) => {
      installed = resolve
    })
    const catalog = createRoutingCatalog({
      load: () => loadCatalog(snapshots),
      refreshIntervalMs: 20,
      jitter: (interval) => interval * 1.2,
      onInstalled: (rows) => {
        for (const row of rows) b.reconcile(row.id, accountHealthFacts(row))
        if (b.stateOf(account.id).breaker.status === "cooling_down") installed?.()
      },
    })
    const writer = createBreakerWriter({
      repository: createAccountBreakerRepository(fixture.db()),
      logger: createLogger({ level: "error", write: () => undefined }),
      flushIntervalMs: 20,
      shutdownDrainMs: 1000,
      acknowledge: () => undefined,
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await catalog.refresh()
      const selected = catalog.account(account.id)
      if (selected === undefined) throw new Error("fixture account absent")
      const now = new Date()
      const deadline = new Date(now.getTime() + 60000)
      writer.start()
      catalog.start()
      writer.record({
        accountId: account.id,
        expected: selected,
        observedRevision: 0,
        status: "cooling_down",
        cooldownUntil: deadline,
        cooldownSource: "provider-reported",
        consecutiveFailures: 1,
      })
      await Promise.race([
        propagated,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("timer propagation did not install")), 2000)
        }),
      ])
      expect(b.stateOf(account.id).breaker.cooldownUntil).toEqual(deadline)
      // This exercises timers, not a latency bound: DB durations and event-loop delay vary in CI.
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      catalog.stop()
      await writer.stop()
    }
  })

  test("replicas and restart keep hard verdicts parked", async () => {
    const accounts = createAccountRepository(fixture.db())
    const snapshots = createCatalogSnapshotRepository(fixture.db())
    for (const status of ["exhausted", "needs_reauth"] as const) {
      const account = await accounts.create({ provider: "zai", label: status })
      await accounts.update(account.id, { status }, new Date())
      const loaded = (await loadCatalog(snapshots)).accounts.find((row) => row.id === account.id)
      if (loaded === undefined) throw new Error("missing parked account")
      for (const health of [createHealthStore(), createHealthStore(), createHealthStore()]) {
        health.reconcile(account.id, accountHealthFacts(loaded))
        health.recordSuccess(account.id)
        expect(health.stateOf(account.id).breaker.status).toBe(status)
        expect(health.admitProbe(account.id, new Date()).admitted).toBe(false)
      }
    }
  })

  test("independent boots competing for recovery start one actual upstream request", async () => {
    let upstreamStarts = 0
    const f = await globalRecoveryFixture(async () => {
      upstreamStarts++
      return new Response(
        JSON.stringify({
          id: "stub",
          object: "chat.completion",
          model: "glm-4.7",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      )
    })
    try {
      await f.first.recheck.recheck(f.account.id)
      await Promise.all([
        f.first.components.coordinator.tick(),
        f.second.components.coordinator.tick(),
      ])
      await Promise.all([f.first.catalog.refresh(), f.second.catalog.refresh()])
      const responses = await Promise.all([f.first.dispatch(), f.second.dispatch()])
      await Promise.all(responses.map((response) => response.text()))
      expect(upstreamStarts).toBe(1)
    } finally {
      await f.close()
    }
  })

  test("a probe hold taken on one replica is refused on the other until it is released", async () => {
    const account = await createAccountRepository(fixture.db()).create({
      provider: "zai",
      label: "probe-hold",
    })
    const snapshots = createCatalogSnapshotRepository(fixture.db())
    // Two independent boxes over one database: separate stores, separate writers, one Postgres.
    const writerFor = () =>
      createBreakerWriter({
        repository: createAccountBreakerRepository(fixture.db()),
        logger: createLogger({ level: "error", write: () => undefined }),
        flushIntervalMs: 60_000,
        shutdownDrainMs: 1000,
        acknowledge: () => undefined,
      })
    const writerA = writerFor()
    const writerB = writerFor()
    const replica = (writer: ReturnType<typeof writerFor>) => {
      const health = createHealthStore({
        probeHoldMs: 30_000,
        jitter: () => 0,
        onBreaker: (accountId, breaker, observed) =>
          writer.record({
            accountId,
            expected: observed,
            observedRevision: observed.breaker?.revision ?? 0,
            ...breaker,
            cooldownSource: breaker.cooldownSource ?? "unknown",
          }),
        onProbeHold: (accountId, heldUntil, observed) =>
          writer.recordProbeHold({ accountId, expected: observed, probeHeldUntil: heldUntil }),
      })
      const refresh = async () => {
        const loaded = (await loadCatalog(snapshots)).accounts.find((row) => row.id === account.id)
        if (loaded === undefined) throw new Error("fixture account absent")
        health.reconcile(account.id, accountHealthFacts(loaded))
        return loaded
      }
      return { health, refresh }
    }
    const a = replica(writerA)
    const selected = await a.refresh()
    const now = new Date()
    const deadline = new Date(now.getTime() + 60_000)
    a.health.recordFailure(
      account.id,
      {
        kind: "rate-limited",
        resetsAt: deadline,
        resetSource: "provider-reported",
        message: "stub 429",
      },
      now,
      undefined,
      a.health.captureAttempt(account.id, accountHealthFacts(selected)),
    )
    await writerA.flush()
    const b = replica(writerB)
    await b.refresh()
    // Both replicas see the same half-open account, so the gate is entirely the durable hold.
    expect(b.health.stateOf(account.id).breaker.status).toBe("cooling_down")
    const probe = new Date(deadline.getTime() + 1)
    const admission = a.health.admitProbe(account.id, probe)
    expect(admission.admitted).toBe(true)
    await writerA.flush()
    await b.refresh()
    // Replica B never admitted this probe and has no local memory of it.
    expect(b.health.admitProbe(account.id, probe).admitted).toBe(false)
    a.health.releaseProbe(account.id, admission.token)
    await writerA.flush()
    await b.refresh()
    expect(b.health.admitProbe(account.id, probe).admitted).toBe(true)

    // A hold is a half-open gate only: a parked account is never admitted, hold or no hold.
    for (const parked of ["exhausted", "needs_reauth"] as const) {
      await fixture.db().update(accounts).set({ status: parked }).where(eq(accounts.id, account.id))
      const fresh = createHealthStore({ probeHoldMs: 30_000, jitter: () => 0 })
      const row = (await loadCatalog(createCatalogSnapshotRepository(fixture.db()))).accounts.find(
        (candidate) => candidate.id === account.id,
      )
      if (row === undefined) throw new Error("fixture account absent")
      fresh.reconcile(account.id, accountHealthFacts(row))
      expect(fresh.admitProbe(account.id, probe)).toEqual({ admitted: false, held: false })
      fresh.recordSuccess(account.id)
      expect(fresh.stateOf(account.id).breaker.status).toBe(parked)
    }
    await Promise.all([writerA.stop(), writerB.stop()])
  })

  test("a probe's 200 recovers the account although its hold and reading were flushed first", async () => {
    // Prod 2026-11-23, 2.76.0: a 200 every ~35 s, `recovery-admission-refused` in between, forever.
    const account = await createAccountRepository(fixture.db()).create({
      provider: "zai",
      label: "probe-success",
    })
    const snapshots = createCatalogSnapshotRepository(fixture.db())
    const published = new Map<BreakerObservation, BreakerState>()
    const writer = createBreakerWriter({
      repository: createAccountBreakerRepository(fixture.db()),
      logger: createLogger({ level: "error", write: () => undefined }),
      flushIntervalMs: 60_000,
      shutdownDrainMs: 1000,
      acknowledge: (input, row) => {
        const breaker = published.get(input)
        if (breaker !== undefined) health.acknowledgeBreaker(input.accountId, breaker, row)
      },
    })
    const health = createHealthStore({
      probeHoldMs: 30_000,
      jitter: () => 0,
      onBreaker: (accountId, breaker, observed) => {
        const input = {
          accountId,
          expected: observed,
          observedRevision: observed.breaker?.revision ?? 0,
          ...breaker,
          cooldownSource: breaker.cooldownSource ?? ("unknown" as const),
        }
        published.set(input, breaker)
        writer.record(input)
      },
      onProbeHold: (accountId, heldUntil, observed) =>
        writer.recordProbeHold({ accountId, expected: observed, probeHeldUntil: heldUntil }),
    })
    const refresh = async () => {
      const row = (await loadCatalog(snapshots)).accounts.find(({ id }) => id === account.id)
      if (row === undefined) throw new Error("fixture account absent")
      health.reconcile(account.id, accountHealthFacts(row))
      return accountHealthFacts(row)
    }
    const now = new Date()
    const deadline = new Date(now.getTime() + 60_000)
    const observed = health.captureAttempt(account.id, await refresh())
    const refused = { kind: "rate-limited", resetsAt: deadline, message: "stub 429" } as const
    health.recordFailure(
      account.id,
      { ...refused, resetSource: "provider-reported" },
      now,
      undefined,
      observed,
    )
    await writer.flush()
    const facts = await refresh()
    expect(health.stateOf(account.id).breaker.status).toBe("cooling_down")

    const after = new Date(deadline.getTime() + 1)
    const observation = health.captureAttempt(account.id, facts)
    const admission = health.admitProbe(account.id, after)
    expect(admission.admitted).toBe(true)
    await writer.flush()
    await refresh()
    const reading = { limited: false, resetSource: "unknown", windows: [] } as const
    health.applyRateLimit(account.id, reading, after, observation)
    await writer.flush()
    health.recordSuccess(account.id, observation)
    health.releaseProbe(account.id, admission.token)
    await writer.flush()
    await refresh()

    expect(health.stateOf(account.id).breaker.status).toBe("active")
    expect((await refresh()).breaker).toMatchObject({ status: "active", cooldownUntil: null })
    await writer.stop()
  })

  test("independent stores hydrate a flushed restriction and restart retains the deadline", async () => {
    const account = await createAccountRepository(fixture.db()).create({
      provider: "zai",
      label: "replica-breaker",
    })
    const snapshots = createCatalogSnapshotRepository(fixture.db())
    const a = createHealthStore({
      onBreaker: (accountId, breaker, observed) =>
        writer.record({
          accountId,
          expected: observed,
          observedRevision: observed.breaker?.revision ?? 0,
          ...breaker,
          cooldownSource: breaker.cooldownSource ?? "unknown",
        }),
    })
    const writer = createBreakerWriter({
      repository: createAccountBreakerRepository(fixture.db()),
      logger: createLogger({ level: "error", write: () => undefined }),
      flushIntervalMs: 1000,
      shutdownDrainMs: 1000,
      acknowledge: () => undefined,
    })
    const b = createHealthStore()
    const refresh = async (health: ReturnType<typeof createHealthStore>) => {
      const loaded = await loadCatalog(snapshots)
      const selected = loaded.accounts.find((row) => row.id === account.id)
      if (selected === undefined) throw new Error("fixture account absent")
      health.reconcile(account.id, accountHealthFacts(selected))
      return selected
    }
    const selected = await refresh(a)
    await refresh(b)
    const now = new Date()
    const deadline = new Date(now.getTime() + 60000)
    a.recordFailure(
      account.id,
      {
        kind: "rate-limited",
        resetsAt: deadline,
        resetSource: "provider-reported",
        message: "stub 429",
      },
      now,
      undefined,
      a.captureAttempt(account.id, accountHealthFacts(selected)),
    )
    await writer.flush()
    await refresh(b)
    let upstreamStarts = 0
    const upstream = async () => {
      upstreamStarts++
      return new Response("stub")
    }
    const current = await refresh(b)
    const dispatcher = createDispatcher({
      catalog: { accounts: () => [current], pools: () => [] },
      health: b,
      cipher: { decrypt: () => "fixture" },
      usage: { record: () => {} },
      fetch: upstream,
    })
    await dispatcher
      .dispatch({
        ingress: "openai-chat",
        requestId: crypto.randomUUID(),
        key: {
          id: crypto.randomUUID(),
          name: "fixture",
          prefix: "fixture",
          scope: { kind: "all" },
          rateLimitRequests: null,
          rateLimitWindowSeconds: null,
          expiresAt: null,
        },
        request: new Request("https://router.test/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "glm-4.7", messages: [{ role: "user", content: "ping" }] }),
        }),
      })
      .catch((error: unknown) => {
        if (!isRouterError(error)) throw error
        expect(error.status).toBe(429)
      })
    expect(upstreamStarts).toBe(0)
    expect(b.stateOf(account.id).breaker.cooldownUntil).toEqual(deadline)
    const restarted = createHealthStore()
    await refresh(restarted)
    expect(restarted.stateOf(account.id).breaker.cooldownUntil).toEqual(deadline)
    expect(restarted.stateOf(account.id).breaker.cooldownSource).toBe("provider-reported")
    expect(
      await createRecoveryRepository(fixture.db()).beginAutomaticRecovery({
        accountId: account.id,
        expected: account,
        expectedRecoveryRevision: null,
        generationCandidate: crypto.randomUUID(),
        reason: "cooldown-expired",
        cooldownMs: 1,
        maximumOutcomeAgeMs: 60000,
      }),
    ).toBeUndefined()
    await writer.stop()
  })
})
