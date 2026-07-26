import { describe, expect, test } from "bun:test"
import type { AccountStatus } from "@multi-ai-router/core"
import type { AccountRow } from "@multi-ai-router/db"
import { createLogger } from "../../src/logging/logger"
import { createAccountStatusWriter } from "../../src/services/dataplane"
import { account, jsonResponse, subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, MESSAGE, post, settle } from "./harness"

/**
 * A standing block, end to end: a real request gets a real refusal, the breaker forms the verdict,
 * and the verdict reaches a row — off the request path, guarded, and surviving the process.
 *
 * Every piece of this has its own unit test. What only an end-to-end run can show is that the
 * pieces are *connected*: the hook fires from the transport's own failure handling rather than from
 * a test calling `recordFailure` by hand, and the account a restarted router hydrates from the
 * written row is genuinely out of rotation. That gap is exactly the bug — `exhausted` was observed
 * on every replica, stored on none, and the console's red banner had no durable source.
 */

/** Rows keyed by id, with the repository's guard applied honestly. */
function rows(initial: Record<string, AccountStatus> = { "acct-1": "active" }) {
  const table = { ...initial }
  return {
    table,
    updateStatusWhen: async (
      id: string,
      from: readonly AccountStatus[],
      to: AccountStatus,
      _now: Date,
    ): Promise<AccountRow | undefined> => {
      const current = table[id]
      if (current === undefined || !from.includes(current)) return undefined
      table[id] = to
      return { id, status: to } as AccountRow
    },
  }
}

/** The composition root's wiring, in miniature: one writer, hung off the health store's hook. */
function durableHealth(initial?: Record<string, AccountStatus>) {
  const accounts = rows(initial)
  const writer = createAccountStatusWriter({
    accounts,
    logger: createLogger({ level: "error", write: () => undefined }),
    flushIntervalMs: 60_000,
    now: () => new Date("2026-01-01T12:00:00.000Z"),
  })
  return { accounts, writer, hook: { onBlocked: writer.record } }
}

const DEAD_BALANCE = () =>
  jsonResponse(402, {
    type: "error",
    error: { type: "billing_error", message: "credit balance is too low" },
  })

describe("a standing block outlives the process that observed it", () => {
  test("a dead balance is written through to the account row", async () => {
    const { accounts, writer, hook } = durableHealth()
    const { app, health } = harness({ health: hook, responses: [DEAD_BALANCE] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    expect(res.status).toBe(402)
    expect(health.stateOf("acct-1").breaker.status).toBe("exhausted")
    // Queued, not written: the client was answered without waiting on a database.
    expect(writer.stats()).toMatchObject({ pending: 1, written: 0 })
    expect(accounts.table["acct-1"]).toBe("active")

    await writer.flush()
    expect(accounts.table["acct-1"]).toBe("exhausted")
  })

  test("an expired subscription credential is written through as needs_reauth", async () => {
    // The block this matters most for. The router never refreshes a Claude subscription token — the
    // Agent SDK owns it — so noticing the failure and parking the Account *is* the whole mechanism,
    // and a verdict that dies with the process means nobody is ever told to log back in.
    const { accounts, writer, hook } = durableHealth({ sub: "active" })
    const { app } = harness({
      accounts: [subscriptionAccount("sub")],
      health: hook,
      responses: [() => jsonResponse(500, {})],
      invokeSdk: () => Promise.reject(new Error("OAuth token has expired")),
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()
    await writer.flush()

    // 502, not 401: the presented router key was fine and the operator is the one who must re-login.
    expect(res.status).toBe(502)
    // A refreshable token can be *re*-authorized, so the remedy is a login rather than a config
    // edit — the distinction `AUTH_FAILURE_STATUS` draws, and one this write has to preserve.
    expect(accounts.table.sub).toBe("needs_reauth")
  })

  test("a rate limit writes nothing — a clock ends it, and a stored countdown would be a lie", async () => {
    const { accounts, writer, hook } = durableHealth()
    const { app, health } = harness({
      health: hook,
      responses: [() => jsonResponse(429, {}, { "retry-after": "42" })],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()
    await writer.flush()

    expect(res.status).toBe(429)
    expect(health.stateOf("acct-1").breaker.status).toBe("cooling_down")
    expect(accounts.table["acct-1"]).toBe("active")
    expect(writer.stats()).toMatchObject({ pending: 0, written: 0 })
  })

  test("the operator's disabled survives the router's verdict", async () => {
    // The write is attempted and the guard refuses it, which is the only place that rule can be
    // enforced: a check in this process would be a race against every other replica.
    const { accounts, writer, hook } = durableHealth({ "acct-1": "disabled" })
    const { app } = harness({ health: hook, responses: [DEAD_BALANCE] })

    await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()
    await writer.flush()

    expect(accounts.table["acct-1"]).toBe("disabled")
    expect(writer.stats()).toMatchObject({ written: 0, refused: 1 })
  })

  test("fifty requests into the same dead balance are one verdict, not fifty writes", async () => {
    const { accounts, writer, hook } = durableHealth()
    const { app } = harness({
      health: hook,
      responses: Array.from({ length: 50 }, () => DEAD_BALANCE),
    })

    await Promise.all(
      Array.from({ length: 50 }, () => app.request("/v1/messages", post(MESSAGE, bearer()))),
    )
    await settle()
    await writer.flush()

    expect(accounts.table["acct-1"]).toBe("exhausted")
    // One transition, so one row write — however many requests raced into the same refusal. This
    // is why pending is a map: a status is state, and fifty copies of it are still one fact.
    expect(writer.stats().written).toBe(1)
  })
})

describe("the restarted router reads the block back", () => {
  test("a hydrated exhausted is refused by name, and no upstream is called", async () => {
    // A fresh process: nothing in memory, and the only thing it knows about this account is the
    // status the previous one wrote. Without the write-through this is an `active` row, the request
    // is dispatched, and the operator's dashboard says the pool is healthy.
    const { app, upstream, usage } = harness({
      accounts: [account("acct-1", { cipher: CRYPTOR, snapshot: { status: "exhausted" } })],
      responses: [() => jsonResponse(200, {})],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    // 402 naming the top-up, formed from the hydrated row alone — not relayed from an upstream,
    // which was never contacted. `cooling_down` would have been a 429; the two never converge.
    expect(res.status).toBe(402)
    expect(res.headers.get("Retry-After")).toBeNull()
    expect(upstream.calls).toHaveLength(0)
    // Still one usage row: a request the router refused is a request the operator paid attention to.
    expect(usage.rows).toHaveLength(1)

    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain("out of credits")
  })

  test("a healthy sibling still serves — one dead account is not a dead pool", async () => {
    // Pooling is the product: the block has to remove exactly one account from rotation.
    const { app, upstream } = harness({
      accounts: [
        account("acct-1", { cipher: CRYPTOR, snapshot: { status: "exhausted" } }),
        account("acct-2", { cipher: CRYPTOR }),
      ],
      responses: [() => jsonResponse(200, { ok: true })],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    expect(res.status).toBe(200)
    expect(upstream.calls).toHaveLength(1)
  })
})
