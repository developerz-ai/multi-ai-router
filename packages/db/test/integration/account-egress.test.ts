import { describe, expect, test } from "bun:test"
import { createAccountEgressHealthRepository } from "../../src/repositories/account-egress-health-repository"
import { createAccountRepository } from "../../src/repositories/account-repository"
import type { StoredEgressProxy } from "../../src/schema/accounts"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

/** Proxy health rows and the compare-and-swap an `egress_proxy_check` repair commits through. */
const fixture = ownDatabaseFixture("account_egress")
const at = (minute: number) => new Date(Date.UTC(2026, 10, 24, 0, minute))
const proxy = (n: number, extra: Partial<StoredEgressProxy> = {}): StoredEgressProxy => ({
  address: `10.0.0.${n}:8080`,
  sealed: `sealed-${n}`,
  ...extra,
})

describe.skipIf(ownDatabaseUrl === "")("account egress persistence", () => {
  test("recordCheck counts failures, resets on ok and on a new assignment, keeps the swap clock", async () => {
    const accounts = createAccountRepository(fixture.db())
    const health = createAccountEgressHealthRepository(fixture.db())
    const account = await accounts.create({ label: "egress-health", provider: "zai" })
    const check = (
      assignment: string,
      outcome: "ok" | "unreachable" | "refused",
      countsAsFailure: boolean,
      minute: number,
    ) =>
      health.recordCheck({
        accountId: account.id,
        assignment,
        outcome,
        status: outcome === "ok" ? 200 : null,
        latencyMs: 12,
        countsAsFailure,
        checkedAt: at(minute),
      })

    expect((await check("a", "unreachable", true, 1))?.consecutiveFailures).toBe(1)
    expect((await check("a", "unreachable", true, 2))?.consecutiveFailures).toBe(2)
    // An operator's own test is shown and never counted.
    expect((await check("a", "unreachable", false, 3))?.consecutiveFailures).toBe(2)
    // Alive but refusing the target: the proxy answered, so the run of failures ends.
    const refused = await check("a", "refused", true, 3)
    expect(refused).toMatchObject({
      consecutiveFailures: 0,
      lastOutcome: "refused",
      lastOkAt: null,
    })
    await check("a", "unreachable", true, 3)
    await check("a", "unreachable", true, 3)

    await health.recordRepair({ accountId: account.id, assignment: "a", repair: "no_candidate" })
    expect((await health.listForAccounts([account.id]))[0]).toMatchObject({
      repair: "no_candidate",
      consecutiveFailures: 2,
      swaps: 0,
      lastSwapAt: null,
    })

    const ok = await check("a", "ok", true, 4)
    expect(ok).toMatchObject({
      consecutiveFailures: 0,
      repair: "idle",
      lastOkAt: at(4),
      lastStatus: 200,
    })

    await check("a", "unreachable", true, 5)
    await health.recordRepair({
      accountId: account.id,
      assignment: "b",
      repair: "idle",
      swappedAt: at(6),
    })
    expect((await health.listForAccounts([account.id]))[0]).toMatchObject({
      assignment: "b",
      consecutiveFailures: 0,
      lastOutcome: null,
      lastOkAt: null,
      lastSwapAt: at(6),
      swaps: 1,
    })
    // A first failure on the new proxy starts at one, and the cooldown clock survives.
    const next = await check("b", "unreachable", true, 7)
    expect(next).toMatchObject({ consecutiveFailures: 1, lastSwapAt: at(6), swaps: 1 })
    // An operator reassigning writes nothing here; the next check sees the mismatch and restarts.
    const reassigned = await check("c", "unreachable", true, 8)
    expect(reassigned).toMatchObject({ assignment: "c", consecutiveFailures: 1, lastSwapAt: at(6) })
  })

  test("a check or repair for a deleted account writes nothing, and rows go with their account", async () => {
    const accounts = createAccountRepository(fixture.db())
    const health = createAccountEgressHealthRepository(fixture.db())
    const gone = crypto.randomUUID()
    expect(
      await health.recordCheck({
        accountId: gone,
        assignment: "a",
        outcome: "ok",
        status: 200,
        latencyMs: 1,
        countsAsFailure: false,
        checkedAt: at(1),
      }),
    ).toBeUndefined()
    await health.recordRepair({ accountId: gone, assignment: "a", repair: "cooldown" })
    const account = await accounts.create({ label: "egress-gone", provider: "zai" })
    await health.recordRepair({ accountId: account.id, assignment: "a", repair: "cooldown" })
    await accounts.delete(account.id)
    expect(await health.listForAccounts([account.id, gone])).toEqual([])
    expect(await health.listForAccounts([])).toEqual([])
  })

  test("listWithEgressProxy returns only proxied accounts, without credential columns", async () => {
    const accounts = createAccountRepository(fixture.db())
    const plain = await accounts.create({
      label: "egress-none",
      provider: "zai",
      authMaterial: "env",
    })
    const proxied = await accounts.create({
      label: "egress-set",
      provider: "zai",
      authMaterial: "env",
    })
    await accounts.update(
      proxied.id,
      { egressProxy: proxy(40, { vendor: "webshare", vendorId: "p40" }) },
      at(1),
    )
    const rows = await accounts.listWithEgressProxy()
    const mine = rows.filter((row) => row.id === proxied.id || row.id === plain.id)
    expect(mine).toEqual([
      {
        id: proxied.id,
        label: "egress-set",
        provider: "zai",
        baseUrl: null,
        dialect: null,
        status: "active",
        egressProxy: proxy(40, { vendor: "webshare", vendorId: "p40" }),
      },
    ])
    expect(Object.keys(mine[0] ?? {})).not.toContain("authMaterial")
  })

  test("swapEgressProxy applies only against the expected proxy, and an operator edit wins", async () => {
    const accounts = createAccountRepository(fixture.db())
    const account = await accounts.create({ label: "egress-swap", provider: "zai" })
    await accounts.update(account.id, { egressProxy: proxy(1) }, at(1))

    // The operator edits between the sweep's read and its commit.
    await accounts.update(account.id, { egressProxy: proxy(2) }, at(2))
    expect(
      await accounts.swapEgressProxy({
        id: account.id,
        expectedSealed: "sealed-1",
        next: proxy(3),
        exclusive: true,
        actor: "operator",
        now: at(3),
      }),
    ).toBeUndefined()
    expect((await accounts.findById(account.id))?.egressProxy).toEqual(proxy(2))

    const swapped = await accounts.swapEgressProxy({
      id: account.id,
      expectedSealed: "sealed-2",
      next: proxy(3, { vendor: "webshare", vendorId: "p3", replace: "on-failure" }),
      exclusive: true,
      actor: "operator",
      now: at(4),
    })
    expect(swapped?.egressProxy).toEqual(
      proxy(3, { vendor: "webshare", vendorId: "p3", replace: "on-failure" }),
    )
    // A cleared proxy has no `sealed` to match.
    await accounts.update(account.id, { egressProxy: null }, at(5))
    expect(
      await accounts.swapEgressProxy({
        id: account.id,
        expectedSealed: "sealed-3",
        next: proxy(4),
        exclusive: false,
        actor: "operator",
        now: at(6),
      }),
    ).toBeUndefined()
  })

  test("an exclusive swap refuses a proxy another account holds by address or vendor identity", async () => {
    const accounts = createAccountRepository(fixture.db())
    const holder = await accounts.create({ label: "egress-holder", provider: "zai" })
    const mover = await accounts.create({ label: "egress-mover", provider: "zai" })
    await accounts.update(
      holder.id,
      { egressProxy: proxy(20, { vendor: "webshare", vendorId: "p20" }) },
      at(1),
    )
    await accounts.update(
      mover.id,
      { egressProxy: proxy(21, { vendor: "webshare", vendorId: "p21" }) },
      at(1),
    )
    const swap = (next: StoredEgressProxy, exclusive: boolean) =>
      accounts.swapEgressProxy({
        id: mover.id,
        expectedSealed: "sealed-21",
        next,
        exclusive,
        actor: "operator",
        now: at(2),
      })

    // Same address under different credentials, then the same vendor id at a new address.
    expect(await swap({ ...proxy(20), sealed: "other" }, true)).toBeUndefined()
    expect(
      await swap({ address: "10.9.9.9:1", sealed: "x", vendor: "webshare", vendorId: "p20" }, true),
    ).toBeUndefined()
    expect((await accounts.findById(mover.id))?.egressProxy).toEqual(
      proxy(21, { vendor: "webshare", vendorId: "p21" }),
    )
    // Its own identity is never "taken": a re-seal in place keeps address and vendor id.
    const resealed = await swap(
      { address: "10.0.0.21:8080", sealed: "sealed-21b", vendor: "webshare", vendorId: "p21" },
      false,
    )
    expect(resealed?.egressProxy).toMatchObject({ sealed: "sealed-21b" })
  })

  test("a sweep's swap needs the stored proxy to still say on-failure; the operator's does not", async () => {
    const accounts = createAccountRepository(fixture.db())
    const account = await accounts.create({ label: "egress-mode", provider: "zai" })
    await accounts.update(account.id, { egressProxy: proxy(30, { replace: "on-failure" }) }, at(1))
    // The operator sets it back to manual between the sweep's decision and its commit.
    const manual = await accounts.swapEgressProxy({
      id: account.id,
      expectedSealed: "sealed-30",
      next: proxy(30, { replace: "manual" }),
      exclusive: false,
      actor: "operator",
      now: at(2),
    })
    expect(manual?.egressProxy).toEqual(proxy(30, { replace: "manual" }))
    const sweep = () =>
      accounts.swapEgressProxy({
        id: account.id,
        expectedSealed: "sealed-30",
        next: proxy(31, { replace: "on-failure" }),
        exclusive: true,
        actor: "sweep",
        now: at(3),
      })
    expect(await sweep()).toBeUndefined()
    // A proxy with no stated mode is manual too.
    await accounts.update(account.id, { egressProxy: proxy(30) }, at(4))
    expect(await sweep()).toBeUndefined()
    await accounts.update(account.id, { egressProxy: proxy(30, { replace: "on-failure" }) }, at(5))
    expect((await sweep())?.egressProxy).toEqual(proxy(31, { replace: "on-failure" }))
  })

  // A swap that committed without its cooldown stamp would leave only the failure threshold
  // between it and the next swap. With `recorded`, both land or neither does.
  test("a recorded swap writes the proxy and its cooldown stamp together, or neither", async () => {
    const accounts = createAccountRepository(fixture.db())
    const health = createAccountEgressHealthRepository(fixture.db())
    const account = await accounts.create({ label: "egress-atomic", provider: "zai" })
    await accounts.update(account.id, { egressProxy: proxy(50, { replace: "on-failure" }) }, at(1))
    await health.recordCheck({
      accountId: account.id,
      assignment: "a50",
      outcome: "unreachable",
      status: null,
      latencyMs: null,
      countsAsFailure: true,
      checkedAt: at(1),
    })
    const row = async () => (await health.listForAccounts([account.id]))[0]
    const swap = (expectedSealed: string, assignment: string, swappedAt?: Date) =>
      accounts.swapEgressProxy({
        id: account.id,
        expectedSealed,
        next: proxy(51, { replace: "on-failure" }),
        exclusive: true,
        actor: "sweep",
        now: at(2),
        recorded: { assignment, ...(swappedAt === undefined ? {} : { swappedAt }) },
      })

    // The compare-and-swap lost: no health write at all.
    expect(await swap("sealed-other", "a51", at(2))).toBeUndefined()
    expect(await row()).toMatchObject({ assignment: "a50", consecutiveFailures: 1, swaps: 0 })

    // The health write fails: the proxy stays what it was.
    await fixture
      .get()
      .sql.unsafe(
        "alter table account_egress_health add constraint test_no_swaps check (swaps = 0) not valid",
      )
    await expect(swap("sealed-50", "a51", at(2))).rejects.toThrow()
    expect((await accounts.findById(account.id))?.egressProxy).toEqual(
      proxy(50, { replace: "on-failure" }),
    )
    await fixture
      .get()
      .sql.unsafe("alter table account_egress_health drop constraint test_no_swaps")

    // Applied: both, and the new assignment starts clean.
    expect((await swap("sealed-50", "a51", at(3)))?.egressProxy).toEqual(
      proxy(51, { replace: "on-failure" }),
    )
    expect(await row()).toMatchObject({
      assignment: "a51",
      consecutiveFailures: 0,
      lastOutcome: null,
      repair: "idle",
      lastSwapAt: at(3),
      swaps: 1,
    })
  })

  // A hold (`no_candidate`, `cooldown`) is about a dead proxy. Once it answers at all it is alive,
  // so the hold ends with the run of failures, on `refused` as on `ok`.
  test("a live proxy clears the repair hold: refused as well as ok", async () => {
    const accounts = createAccountRepository(fixture.db())
    const health = createAccountEgressHealthRepository(fixture.db())
    for (const outcome of ["refused", "ok"] as const) {
      const account = await accounts.create({ label: `egress-hold-${outcome}`, provider: "zai" })
      const check = (result: "unreachable" | "refused" | "ok", countsAsFailure: boolean) =>
        health.recordCheck({
          accountId: account.id,
          assignment: "a",
          outcome: result,
          status: null,
          latencyMs: 1,
          countsAsFailure,
          checkedAt: at(1),
        })
      await check("unreachable", true)
      await health.recordRepair({ accountId: account.id, assignment: "a", repair: "no_candidate" })
      // A dead proxy, counted or an operator's own test, keeps the hold.
      expect((await check("unreachable", true))?.repair).toBe("no_candidate")
      expect((await check("unreachable", false))?.repair).toBe("no_candidate")
      expect(await check(outcome, true)).toMatchObject({ repair: "idle", consecutiveFailures: 0 })
    }
  })
})
