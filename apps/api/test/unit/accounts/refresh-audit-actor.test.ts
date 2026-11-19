import { describe, expect, test } from "bun:test"
import {
  type AuditContext,
  createAuditRecorder,
  runWithAuditContext,
} from "../../../src/services/admin"
import { createMemoryStore } from "../../support/memory-store"
import { silentLogger } from "../../support/silent-logger"
import { accountRow, harness, NOW } from "./refresh-fixtures"

/**
 * multi-ai-router#453. The credential refresher arms its own timers, outside the scheduler, and an
 * audit context is carried into every timer created inside it. So a refresh armed while an operator's
 * request was running would fire days later still stamped with that operator — worse than
 * unattributed, because it reads as true. Every refresh flight therefore runs as the system, under
 * the refresher's own name, whatever started it.
 */

const OPERATOR: AuditContext = {
  actor: "ops@example.test",
  actorKind: "session",
  says: null,
  clientIp: "203.0.113.7",
  userAgent: "console/1.0",
  requestId: "req-1",
}

const WEEK_AHEAD = new Date(NOW.getTime() + 7 * 24 * 3_600_000)

function audited() {
  const store = createMemoryStore()
  return { store, audit: createAuditRecorder(store.audit, silentLogger()) }
}

async function rows(store: ReturnType<typeof createMemoryStore>, count: number) {
  for (let spin = 0; spin < 200 && store.rows.audit.length < count; spin++) await Bun.sleep(1)
  expect(store.rows.audit).toHaveLength(count)
  return store.rows.audit
}

describe("a credential refresh's audit row", () => {
  test("is the system's even when an operator's request started it", async () => {
    const { store, audit } = audited()
    const h = harness(
      [accountRow({ status: "needs_reauth", tokenExpiresAt: WEEK_AHEAD })],
      {},
      {
        audit,
      },
    )

    await runWithAuditContext(OPERATOR, () => h.refresher.refreshNow("acct-1"))

    const [row] = await rows(store, 1)
    expect(row).toMatchObject({
      kind: "account.reauthorized",
      actor: "system",
      actorKind: "system",
      actorSays: "credential-refresher",
      requestId: null,
    })
  })

  test("a timer armed inside an operator's request fires as the system, not as that operator", async () => {
    const { store, audit } = audited()
    // Real timers: the leak this guards is the runtime carrying the context into `setTimeout`.
    const h = harness(
      [accountRow({ status: "needs_reauth", tokenExpiresAt: WEEK_AHEAD })],
      { minDelayMs: 1 },
      {
        audit,
        schedule: (run, delay) => {
          const timer = setTimeout(run, Math.min(delay, 5))
          return () => clearTimeout(timer)
        },
      },
    )

    await runWithAuditContext(OPERATOR, () => h.refresher.sync("acct-1"))
    // The timer is armed; its clock check passes once the injected clock reaches the due instant.
    h.clock.now = new Date(NOW.getTime() + 60_000)

    const [row] = await rows(store, 1)
    expect(row).toMatchObject({
      kind: "account.reauthorized",
      actorKind: "system",
      actorSays: "credential-refresher",
    })
    expect(row?.actor).not.toBe(OPERATOR.actor)
    await h.refresher.stop()
  })
})
