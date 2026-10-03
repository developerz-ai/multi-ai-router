import { describe, expect, test } from "bun:test"
import type { AccountStatus } from "@multi-ai-router/core"
import type { AccountRow } from "@multi-ai-router/db"
import { createLogger, type Logger } from "../../../src/logging/logger"
import {
  type AccountStatusWriterDeps,
  createAccountStatusWriter,
  OVERWRITABLE_BY_OBSERVATION,
  persistable,
} from "../../../src/services/dataplane"
import type { HealthObservation } from "../../../src/services/dataplane/health-observation"
import { accountRow as durableAccountRow } from "../../support/account-row"
import { createMemoryStore } from "../../support/memory-store"
import { NOW } from "./fixtures"

function observation(overrides: Partial<HealthObservation> = {}): HealthObservation {
  return {
    lifecycleVersion: 0,
    healthRecoveryVersion: 0,
    authRecoveryVersion: 0,
    authMaterial: null,
    status: "active",
    observationGeneration: 1,
    verdictVersion: 0,
    ...overrides,
  }
}

/**
 * The durable half of the breaker.
 *
 * `exhausted` means a human has to buy something and `needs_reauth` means a human has to log in, so
 * the verdict is worth nothing unless it reaches a person — and until this writer existed it lived
 * in one replica's memory, vanished on deploy, and left the dashboard reading `active`. What is
 * pinned here is that making it durable costs a request nothing, and that the write can never
 * overwrite a status that was not the router's to form.
 */

/** The real logger with a capturing sink — the line an operator would read, redaction included. */
function logger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = []
  return {
    logger: createLogger({
      level: "warn",
      write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
    lines,
  }
}

interface Write {
  readonly id: string
  readonly expected: {
    lifecycleVersion: number
    authMaterial: string | null
    status: AccountStatus
  }
  readonly to: AccountStatus
}

/** Rows keyed by id, holding the guard honestly: a row outside `from` is not written. */
function repository(rows: Record<string, AccountStatus> = { a: "active", b: "active" }) {
  const writes: Write[] = []
  return {
    rows,
    writes,
    transitionObservedStatus: async ({ id, expected, status }): Promise<AccountRow | undefined> => {
      writes.push({ id, expected, to: status })
      if (
        rows[id] !== expected.status ||
        expected.lifecycleVersion !== 0 ||
        expected.authMaterial !== null
      )
        return undefined
      rows[id] = status
      return durableAccountRow({ id, status })
    },
  }
}

const failing: AccountStatusWriterDeps["accounts"] = {
  transitionObservedStatus: async (): Promise<AccountRow | undefined> => {
    throw new Error("connection refused")
  },
}

function writer(accounts: AccountStatusWriterDeps["accounts"], log: Logger) {
  return createAccountStatusWriter({
    accounts,
    logger: log,
    flushIntervalMs: 1_000,
    now: () => NOW,
  })
}

describe("observed status policy", () => {
  test("only the two standing blocks the breaker forms are persistable", () => {
    expect(persistable("exhausted")).toBe(true)
    expect(persistable("needs_reauth")).toBe(true)
    // A provider's bad 401 must never become indistinguishable from an operator's own switch.
    expect(persistable("disabled")).toBe(false)
    // A clock recovers these, and a stored countdown is stale the moment the process holding it dies.
    expect(persistable("cooling_down")).toBe(false)
    expect(persistable("active")).toBe(false)
  })

  test("an observation may overwrite only what the router itself could have set", () => {
    expect([...OVERWRITABLE_BY_OBSERVATION]).toEqual(["active", "cooling_down"])
    // Stated as an exclusion because that is the rule that matters: the operator's `disabled` and a
    // standing block an operator is already acting on are both off limits.
    expect(OVERWRITABLE_BY_OBSERVATION).not.toContain("disabled")
    expect(OVERWRITABLE_BY_OBSERVATION).not.toContain("needs_reauth")
    expect(OVERWRITABLE_BY_OBSERVATION).not.toContain("exhausted")
  })
})

describe("account status writer", () => {
  test("writes the verdict through on flush", async () => {
    const accounts = repository()
    const write = writer(accounts, logger().logger)

    write.record("a", "exhausted", observation())
    await write.flush()

    expect(accounts.rows.a).toBe("exhausted")
    expect(write.stats()).toMatchObject({ pending: 0, written: 1, refused: 0 })
  })

  test("records nothing on the request path — the update waits for the flush", async () => {
    const accounts = repository()
    const write = writer(accounts, logger().logger)

    write.record("a", "needs_reauth", observation())
    expect(accounts.writes).toHaveLength(0)
    expect(write.stats().pending).toBe(1)

    await write.flush()
    expect(accounts.rows.a).toBe("needs_reauth")
  })

  test("drops a status it may not store, rather than making the call site decide", async () => {
    const accounts = repository()
    const write = writer(accounts, logger().logger)

    // The breaker forms this one from an `api-key` auth failure. It is reported, and not stored.
    write.record("a", "disabled", observation())
    write.record("b", "cooling_down", observation())
    await write.flush()

    expect(accounts.writes).toHaveLength(0)
    expect(write.stats()).toMatchObject({ pending: 0, written: 0 })
  })

  test("the guard is in the statement: a disabled row is never overwritten", async () => {
    const accounts = repository({ a: "disabled" })
    const write = writer(accounts, logger().logger)

    write.record("a", "exhausted", observation())
    await write.flush()

    expect(accounts.rows.a).toBe("disabled")
    // Attempted and refused, not skipped — the check belongs to postgres, not to TypeScript.
    expect(accounts.writes[0]).toMatchObject({ id: "a", to: "exhausted" })
    expect(write.stats()).toMatchObject({ written: 0, refused: 1 })
  })

  test("a standing block is never overwritten by another standing block", async () => {
    const accounts = repository({ a: "needs_reauth" })
    const write = writer(accounts, logger().logger)

    write.record("a", "exhausted", observation())
    await write.flush()

    // The remedy on the operator's screen does not change while they are carrying it out.
    expect(accounts.rows.a).toBe("needs_reauth")
    expect(write.stats().refused).toBe(1)
  })

  test("coalesces: a status is state, so the newest verdict supersedes the older", async () => {
    const accounts = repository()
    const write = writer(accounts, logger().logger)

    for (let index = 0; index < 100; index += 1) write.record("a", "exhausted", observation())
    expect(write.stats().pending).toBe(1)

    await write.flush()
    expect(accounts.writes).toHaveLength(1)
  })

  test("one line per applied transition — the line an operator greps", async () => {
    const sink = logger()
    const accounts = repository()
    const write = writer(accounts, sink.logger)

    write.record("a", "exhausted", observation())
    write.record("b", "exhausted", observation())
    await write.flush()

    expect(sink.lines).toHaveLength(2)
    expect(sink.lines[0]).toMatchObject({
      component: "account-status",
      accountId: "a",
      status: "exhausted",
    })
  })

  test("a refused write is silent — nothing changed, so there is nothing to report", async () => {
    const sink = logger()
    const write = writer(repository({ a: "disabled" }), sink.logger)

    write.record("a", "exhausted", observation())
    await write.flush()

    expect(sink.lines).toHaveLength(0)
  })

  test("forget drops a queued verdict, so a re-check is not undone by a stale one", async () => {
    const accounts = repository()
    const write = writer(accounts, logger().logger)

    write.record("a", "exhausted", observation())
    write.forget("a")
    await write.flush()

    expect(accounts.writes).toHaveLength(0)
    expect(accounts.rows.a).toBe("active")
  })

  test("a verdict that arrives mid-flush belongs to the next one, not to the clear", async () => {
    const accounts = repository()
    const write = writer(accounts, logger().logger)

    write.record("a", "exhausted", observation())
    const flushing = write.flush()
    write.record("b", "needs_reauth", observation())
    await flushing

    expect(write.stats().pending).toBe(1)
    await write.flush()
    expect(accounts.writes.map((entry) => entry.id)).toEqual(["a", "b"])
  })

  test("a failed write retains the verdict for retry without failing traffic — one line, whatever the batch", async () => {
    const sink = logger()
    const write = writer(failing, sink.logger)

    write.record("a", "exhausted", observation())
    write.record("b", "needs_reauth", observation())
    await write.flush()

    expect(write.stats()).toMatchObject({ pending: 2, written: 0, writeFailures: 2 })
    expect(sink.lines).toHaveLength(1)
    expect(sink.lines[0]).toMatchObject({
      component: "account-status",
      accounts: 2,
      reason: "connection refused",
    })
  })

  test("stop flushes what is left, so a clean shutdown loses no verdict", async () => {
    const accounts = repository()
    const write = writer(accounts, logger().logger)

    write.start()
    write.record("a", "exhausted", observation())
    await write.stop()

    expect(accounts.rows.a).toBe("exhausted")
  })
})

test("late obsolete callback cannot overwrite a newer pending credential verdict", async () => {
  const store = createMemoryStore()
  const row = await store.accounts.create(
    { label: "synthetic", provider: "openai-oauth", authMaterial: "old-cipher" },
    NOW,
  )
  const old = observation({ authMaterial: row.authMaterial })
  const replacement = await store.accounts.updateOperatorAccount({
    id: row.id,
    patch: { authMaterial: "new-cipher" },
    now: NOW,
  })
  if (replacement === undefined) throw new Error("missing fixture")
  const fresh = observation({
    lifecycleVersion: replacement.lifecycleVersion,
    authRecoveryVersion: replacement.authRecoveryVersion,
    authMaterial: replacement.authMaterial,
    observationGeneration: 2,
  })
  const write = writer(store.accounts, logger().logger)
  write.record(row.id, "needs_reauth", fresh)
  write.record(row.id, "exhausted", old)
  await write.flush()
  expect((await store.accounts.findById(row.id))?.status).toBe("needs_reauth")
  expect(write.stats()).toMatchObject({ written: 1, refused: 0, pending: 0 })
})
