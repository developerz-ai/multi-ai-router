import { describe, expect, test } from "bun:test"
import { recoveryProbeSender } from "../../../src/composition/recovery"
import { createLogger } from "../../../src/logging/logger"
import { createScheduler } from "../../../src/scheduler"
import { createPoolReapTask } from "../../../src/scheduler/tasks/pool-reap"
import {
  AUDIT_KINDS,
  AUDIT_SUBJECTS,
  type AuditContext,
  createAuditRecorder,
  currentAuditContext,
  ok,
  runWithAuditContext,
} from "../../../src/services/admin"
import { createPoolReaper } from "../../../src/services/pools"
import { createMemoryStore } from "../../support/memory-store"
import { silentLogger } from "../../support/silent-logger"
import { alwaysFree, memoryTaskRepository } from "../scheduler/fixtures"

/**
 * multi-ai-router#453: the recorder stamps the caller from the audit context on every row, and a
 * row with no caller is still written — as `unattributed`, with one error line — never refused.
 */

const NOW = new Date("2026-11-19T12:00:00.000Z")

function capturingLogger() {
  const lines: Record<string, unknown>[] = []
  const logger = createLogger({
    level: "debug",
    write: (line) => void lines.push(JSON.parse(line)),
  })
  return { logger, lines }
}

const SESSION: AuditContext = {
  actor: "ops@example.test",
  actorKind: "session",
  says: "console",
  clientIp: "203.0.113.7",
  userAgent: "console/1.0",
  requestId: "req-1",
}

const EVENT = {
  kind: AUDIT_KINDS.poolUpdated,
  subjectType: AUDIT_SUBJECTS.pool,
  subjectId: "pool-1",
  detail: { memberCount: 0 },
}

describe("the recorder", () => {
  test("stamps every caller field from the audit context", async () => {
    const store = createMemoryStore()
    const recorder = createAuditRecorder(store.audit, silentLogger())

    await runWithAuditContext(SESSION, () => recorder.record(EVENT))

    expect(store.rows.audit).toHaveLength(1)
    expect(store.rows.audit[0]).toMatchObject({
      kind: "pool.updated",
      actor: "ops@example.test",
      actorKind: "session",
      actorSays: "console",
      clientIp: "203.0.113.7",
      userAgent: "console/1.0",
      requestId: "req-1",
    })
  })

  test("with no context, writes unattributed/unknown, logs exactly one error naming the kind, and does not throw", async () => {
    const store = createMemoryStore()
    const { logger, lines } = capturingLogger()
    const recorder = createAuditRecorder(store.audit, logger)

    expect(currentAuditContext()).toBeUndefined()
    await recorder.record(EVENT)

    expect(store.rows.audit).toHaveLength(1)
    expect(store.rows.audit[0]).toMatchObject({
      kind: "pool.updated",
      actor: "unknown",
      actorKind: "unattributed",
      actorSays: null,
      clientIp: null,
      userAgent: null,
      requestId: null,
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: "error",
      msg: "audit event without a caller",
      kind: "pool.updated",
    })
  })

  test("a failing sink still rejects, so a transaction that recorded inside it rolls back", async () => {
    const recorder = createAuditRecorder(
      {
        append: async () => {
          throw new Error("insert failed")
        },
      },
      silentLogger(),
    )

    await expect(runWithAuditContext(SESSION, () => recorder.record(EVENT))).rejects.toThrow(
      "insert failed",
    )
  })
})

describe("a scheduled task", () => {
  test("writes its audit rows as system, saying the task's name", async () => {
    const store = createMemoryStore()
    const pool = await store.pools.create({ name: "emptied" })
    const held = store.rows.pools.find((row) => row.id === pool.id)
    if (held === undefined) throw new Error("pool not stored")
    held.emptySince = new Date(NOW.getTime() - 30 * 24 * 60 * 60_000)
    const key = await store.keys.create({
      name: "only-this-pool",
      value: "cipher",
      prefix: "mar_live_reap000",
      scope: "pools",
    })
    await store.keys.replaceScopeTargets(key.id, { poolIds: [pool.id] })

    const { logger, lines } = capturingLogger()
    const task = createPoolReapTask({
      pools: store.pools,
      reaper: createPoolReaper({
        logger,
        mutations: store.mutations,
        now: () => NOW,
        coherence: { refreshCatalog: async () => {}, forgetKey: () => {}, invalidateKey: () => {} },
      }),
      windowMs: 7 * 24 * 60 * 60_000,
      intervalMs: 60 * 60_000,
      batchSize: 10,
    })
    const scheduler = createScheduler({
      tasks: [task],
      repo: memoryTaskRepository(),
      logger: silentLogger(),
      lock: alwaysFree(),
      jitterFraction: 0,
      now: () => NOW,
    })

    const result = await scheduler.runNow(task.name)

    expect(result.status).toBe("success")
    expect(store.rows.audit.map((row) => row.kind).sort()).toEqual(["key.revoked", "pool.deleted"])
    for (const row of store.rows.audit) {
      expect(row).toMatchObject({ actor: "system", actorKind: "system", actorSays: "pool_reap" })
    }
    expect(lines.filter((line) => line.msg === "audit event without a caller")).toEqual([])
  })

  test("an operator's run-now is still the task's own work: system, not whoever pressed it", async () => {
    const store = createMemoryStore()
    const recorder = createAuditRecorder(store.audit, silentLogger())
    const scheduler = createScheduler({
      tasks: [
        {
          name: "janitor_sweep",
          intervalMs: 60_000,
          run: async () => {
            await recorder.record(EVENT)
            return { outcome: "success", itemsProcessed: 1 }
          },
        },
      ],
      repo: memoryTaskRepository(),
      logger: silentLogger(),
      lock: alwaysFree(),
      jitterFraction: 0,
      now: () => NOW,
    })

    await runWithAuditContext(SESSION, () => scheduler.runNow("janitor_sweep"))

    expect(store.rows.audit[0]).toMatchObject({
      actor: "system",
      actorKind: "system",
      actorSays: "janitor_sweep",
    })
  })
})

describe("the router's own recovery probe", () => {
  test("records its account.tested as the system, never as whoever's request armed the permit", async () => {
    const store = createMemoryStore()
    const recorder = createAuditRecorder(store.audit, silentLogger())
    const send = recoveryProbeSender({
      test: async (accountId) => {
        await recorder.record({
          kind: AUDIT_KINDS.accountTested,
          subjectType: AUDIT_SUBJECTS.account,
          subjectId: accountId,
          detail: { trigger: "router_recovery" },
        })
        return ok({
          accountId,
          lastCheckedAt: NOW.toISOString(),
          nextAllowedAt: NOW.toISOString(),
          tested: true,
          outcome: "ok",
        })
      },
    })

    // A permit demanded while an operator's re-check was running fires later, still in its context.
    await runWithAuditContext(SESSION, () =>
      send({
        accountId: "acct-1",
        model: "m",
        startGuard: async () => {},
        rateLimitSink: () => {},
      }),
    )

    expect(store.rows.audit[0]).toMatchObject({
      kind: "account.tested",
      actor: "system",
      actorKind: "system",
      actorSays: "router-recovery",
    })
  })
})
