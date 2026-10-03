import { describe, expect, test } from "bun:test"
import type { AccountStatus } from "@multi-ai-router/core"
import { createRecheckService } from "../../../src/services/accounts"
import type { AuditEventInput } from "../../../src/services/admin"
import type { AccountAuthProbe } from "../../../src/services/health/claudeAuthProbe"
import { accountRow } from "../../support/account-row"
import { memoryAccountLifecycle } from "../../support/memory-account-lifecycle"

const NOW = new Date("2026-01-01T12:00:00.000Z")
const row = (id: string, status: AccountStatus = "cooling_down") =>
  accountRow({ id, label: id, provider: "zai", status })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function harness(
  cooldownSeconds = 60,
  rows = [row("a"), row("b")],
  options: {
    beforeCommit?: () => Promise<void>
    barrier?: () => Promise<void>
    auditFails?: boolean
    auth?: AccountAuthProbe
  } = {},
) {
  const commits: string[] = []
  const order: string[] = []
  const audited: AuditEventInput[] = []
  const repository = memoryAccountLifecycle(rows, [])
  let clock = NOW
  const recoveries = new Map<
    string,
    {
      generation: string
      state: "pending" | "cancelled"
      requestedAt: Date
      nextAllowedAt: Date
      outcomeAt: Date | null
    }
  >()
  let turn = Promise.resolve()

  const service = createRecheckService({
    accounts: {
      list: async () => rows,
      findById: async (id) => rows.find((row) => row.id === id),
    },
    recovery: {
      readOperatorCooldown: async (id) => {
        const account = rows.find((row) => row.id === id),
          recovery = recoveries.get(id)
        return account !== undefined && recovery !== undefined && clock < recovery.nextAllowedAt
          ? { account, recovery, rechecked: false, clearedStatus: null }
          : undefined
      },
      beginOperatorRecovery: (input) => {
        const run = turn.then(async () => {
          const account = rows.find((row) => row.id === input.accountId)
          if (account === undefined) return undefined
          const held = recoveries.get(account.id)
          if (held !== undefined && clock < held.nextAllowedAt)
            return { account, recovery: held, rechecked: false, clearedStatus: null }
          await options.beforeCommit?.()
          const current = rows.find((row) => row.id === input.accountId)
          if (current === undefined) return undefined
          const committed = await repository.recheckAccount({ id: current.id, now: clock })
          if (committed === undefined) return undefined
          const recovery = {
            generation: input.generationCandidate,
            state:
              current.status === "disabled" || current.status === "needs_reauth"
                ? ("cancelled" as const)
                : ("pending" as const),
            requestedAt: clock,
            nextAllowedAt: new Date(clock.getTime() + input.cooldownMs),
            outcomeAt: null,
          }
          recoveries.set(current.id, recovery)
          commits.push(current.id)
          return {
            account: committed.account,
            recovery,
            rechecked: true,
            clearedStatus: committed.clearedStatus,
          }
        })
        turn = run.then(
          () => {},
          () => {},
        )
        return run
      },
    },
    audit: {
      record: async (event) => {
        order.push("audit")
        if (options.auditFails) throw new Error("audit unavailable")
        audited.push(event)
      },
    },
    refreshCatalog: async () => {
      order.push("barrier")
      await options.barrier?.()
    },
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    cooldownSeconds,
  })
  return {
    service,
    rows,
    commits,
    order,
    audited,
    repository,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
  }
}

describe("recheck", () => {
  test("commits a full-health recovery intent and installs it before returning", async () => {
    const h = harness()
    const result = await h.service.recheck("a")
    expect(result.ok && result.value.rechecked).toBe(true)
    expect(h.rows[0]).toMatchObject({
      lifecycleVersion: 1,
      healthRecoveryVersion: 1,
      authRecoveryVersion: 0,
      status: "cooling_down",
    })
    expect(h.order).toEqual(["barrier", "audit"])
  })
  test("a second press inside cooldown is refused server-side without another commit", async () => {
    const h = harness()
    await h.service.recheck("a")
    const second = await h.service.recheck("a")
    expect(second.ok && second.value.rechecked).toBe(false)
    expect(h.commits).toEqual(["a"])
  })
  test("refusal is a normal response carrying the original next allowed instant", async () => {
    const { service } = harness()
    const first = await service.recheck("a")
    const second = await service.recheck("a")
    if (!first.ok || !second.ok) throw new Error("expected normal replies")
    expect(second.value.nextAllowedAt).toBe(first.value.nextAllowedAt)
    expect(second.value.lastCheckedAt).toBe(first.value.lastCheckedAt)
  })
  test("cooldown expiry permits exactly another intent", async () => {
    const h = harness()
    await h.service.recheck("a")
    h.advance(60_000)
    const again = await h.service.recheck("a")
    expect(again.ok && again.value.rechecked).toBe(true)
    expect(h.commits).toEqual(["a", "a"])
    expect(h.rows[0]?.healthRecoveryVersion).toBe(2)
  })

  test("recheck-all honors each account's cooldown", async () => {
    const h = harness()
    await h.service.recheck("a")
    const all = await h.service.recheckAll()
    if (!all.ok) throw new Error("expected normal reply")
    expect(all.value.find((entry) => entry.accountId === "a")?.rechecked).toBe(false)
    expect(all.value.find((entry) => entry.accountId === "b")?.rechecked).toBe(true)
    expect(h.commits).toEqual(["a", "b"])
  })

  test("only a committed recheck is audited and no absent probe result is invented", async () => {
    const h = harness()
    await h.service.recheck("a")
    await h.service.recheck("a")
    expect(h.audited).toHaveLength(1)
    expect(h.audited[0]).toMatchObject({
      kind: "account.rechecked",
      subjectId: "a",
      detail: { provider: "zai" },
    })
  })

  test("lifts only currently exhausted status and reports it", async () => {
    const h = harness(60, [row("a", "exhausted")])
    const result = await h.service.recheck("a")
    expect(result.ok && result.value.clearedStatus).toBe("exhausted")
    expect(h.rows[0]?.status).toBe("active")
    expect(h.audited[0]?.detail).toEqual({
      provider: "zai",
      source: "operator_recovery",
      clearedStatus: "exhausted",
    })
  })

  for (const status of ["disabled", "needs_reauth"] as const) {
    test(`preserves ${status} while installing its new recovery epoch`, async () => {
      const h = harness(60, [row("a", status)])
      const result = await h.service.recheck("a")
      expect(result.ok && result.value.clearedStatus).toBeUndefined()
      expect(h.rows[0]).toMatchObject({ status, lifecycleVersion: 1, healthRecoveryVersion: 1 })
      expect(h.order).toEqual(["barrier", "audit"])
    })
  }

  test("recheck-all installs each committed row before its audit", async () => {
    const h = harness(60, [row("a", "exhausted"), row("b", "exhausted")])
    const all = await h.service.recheckAll()
    expect(all.ok && all.value.every((entry) => entry.clearedStatus === "exhausted")).toBe(true)
    expect(h.order).toEqual(["barrier", "audit", "barrier", "audit"])
  })

  test("unknown account returns 404 without committing", async () => {
    const h = harness()
    const result = await h.service.recheck("missing")
    expect(!result.ok && result.failure.status).toBe(404)
    expect(h.commits).toEqual([])
  })

  test("concurrent presses reserve cooldown before SQL and wait for the committed catalog barrier", async () => {
    const started = deferred()
    const sql = deferred()
    const barrierStarted = deferred()
    const barrier = deferred()
    const h = harness(60, [row("a")], {
      beforeCommit: async () => {
        started.resolve()
        await sql.promise
      },
      barrier: async () => {
        barrierStarted.resolve()
        await barrier.promise
      },
    })
    let completed = false
    const first = h.service.recheck("a").then((result) => {
      completed = true
      return result
    })
    await started.promise
    const second = h.service.recheck("a")
    expect(h.commits).toEqual([])
    sql.resolve()
    await barrierStarted.promise
    expect(completed).toBe(false)
    expect(h.audited).toEqual([])
    expect((await second).ok).toBe(true)
    barrier.resolve()
    expect((await first).ok).toBe(true)
    expect(h.commits).toEqual(["a"])
  })

  test("SQL failure creates no durable cooldown and permits a retry", async () => {
    let attempts = 0
    const h = harness(60, [row("a")], {
      beforeCommit: async () => {
        if (++attempts === 1) throw new Error("SQL unavailable")
      },
    })
    await expect(h.service.recheck("a")).rejects.toThrow("SQL unavailable")
    const retry = await h.service.recheck("a")
    expect(retry.ok && retry.value.rechecked).toBe(true)
    expect(h.commits).toEqual(["a"])
  })

  test("auth check captures original facts before an intervening operator disable", async () => {
    const rows = [row("a", "exhausted")]
    const repository = memoryAccountLifecycle(rows, [])
    let observed: Parameters<AccountAuthProbe["check"]>[0] | undefined
    const h = harness(60, rows, {
      beforeCommit: async () => {
        await repository.updateOperatorAccount({ id: "a", patch: { status: "disabled" }, now: NOW })
      },
      auth: {
        check: async (subject) => {
          observed = subject
          return null
        },
      },
    })
    await h.service.recheck("a")
    expect(observed).not.toBe(h.rows[0])
    expect(observed).toMatchObject({ status: "exhausted", lifecycleVersion: 0, authMaterial: null })
    expect(h.rows[0]?.healthRecoveryVersion).toBe(1)
    expect(h.audited[0]?.detail).toEqual({ provider: "zai", source: "operator_recovery" })
  })

  test("audit failure follows an installed committed recovery and retains cooldown", async () => {
    const h = harness(60, [row("a", "exhausted")], { auditFails: true })
    await expect(h.service.recheck("a")).rejects.toThrow("audit unavailable")
    expect(h.order).toEqual(["barrier", "audit"])
    expect(h.rows[0]?.status).toBe("active")
    const refused = await h.service.recheck("a")
    expect(refused.ok && refused.value.rechecked).toBe(false)
  })
})
