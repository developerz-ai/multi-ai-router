import { describe, expect, test } from "bun:test"
import {
  createAdminMutationRepository,
  createApiKeyRepository,
  createApiKeyTombstoneRepository,
  createAuditRepository,
  createUsageRecentRepository,
  usageDaily,
} from "@multi-ai-router/db"
import { Hono } from "hono"
import {
  historyAttempt,
  historyTerminal,
  historyUrl,
  usageHistoryFixture,
} from "../../../../packages/db/test/integration/usage-history-fixture"
import type { AdminAuthEnv } from "../../src/middleware/adminAuth"
import { ADMIN_USAGE_BASE_PATH, adminUsageRoutes } from "../../src/routes/admin/usage"
import { createAuditRecorder } from "../../src/services/admin/audit"
import { createKeysService } from "../../src/services/keys"
import { catalogLabels, createUsageService, type UsageSummary } from "../../src/services/usage-read"

/**
 * Usage filters (issue #225) through the real route, resolver, repositories and Postgres.
 * Two owners x two tools x two models x {metered, notional, unknown}, a subscription account, a
 * pool-less key and a key purged through the tombstone path. Expected values are folded by hand
 * from the fixture list below.
 */
const fixture = usageHistoryFixture()
const HOUR = 3_600_000
const DAY = 86_400_000

const ACCOUNT_API = crypto.randomUUID()
const ACCOUNT_SUB = crypto.randomUUID()
const POOL = crypto.randomUUID()

interface Spec {
  readonly key: "aliceEditor" | "aliceCli" | "bobEditor" | "bobCli"
  readonly account: string
  readonly pool: string | null
  readonly model: "m1" | "m2"
  readonly basis: "metered" | "notional" | "unknown"
  /** Milliseconds before the test's `now`. Whole days back reach the rollup; minutes the receipts. */
  readonly ago: number
  readonly outcome?: "success" | "upstream_error"
}
const specs: Spec[] = [
  {
    key: "aliceEditor",
    account: ACCOUNT_API,
    pool: POOL,
    model: "m1",
    basis: "metered",
    ago: 3 * DAY,
  },
  {
    key: "aliceEditor",
    account: ACCOUNT_SUB,
    pool: POOL,
    model: "m2",
    basis: "notional",
    ago: 3 * DAY - HOUR,
  },
  {
    key: "aliceCli",
    account: ACCOUNT_API,
    pool: null,
    model: "m1",
    basis: "unknown",
    ago: 3 * DAY - 2 * HOUR,
  },
  {
    key: "bobEditor",
    account: ACCOUNT_API,
    pool: POOL,
    model: "m2",
    basis: "metered",
    ago: 2 * DAY,
  },
  {
    key: "bobEditor",
    account: ACCOUNT_SUB,
    pool: POOL,
    model: "m1",
    basis: "notional",
    ago: 40 * 60_000,
    outcome: "upstream_error",
  },
  {
    key: "bobCli",
    account: ACCOUNT_API,
    pool: null,
    model: "m2",
    basis: "unknown",
    ago: 30 * 60_000,
  },
  {
    key: "aliceEditor",
    account: ACCOUNT_SUB,
    pool: POOL,
    model: "m1",
    basis: "notional",
    ago: 20 * 60_000,
  },
  {
    key: "bobCli",
    account: ACCOUNT_SUB,
    pool: POOL,
    model: "m1",
    basis: "metered",
    ago: 10 * 60_000,
  },
]

const now = new Date()
const ids = {} as Record<Spec["key"], string>
let app: Hono<AdminAuthEnv>

async function get(query: string) {
  const response = await app.request(`${ADMIN_USAGE_BASE_PATH}?${query}`)
  return { status: response.status, body: (await response.json()) as UsageSummary }
}
const fold = (picked: Spec[]) => ({
  attempts: picked.length,
  requests: picked.length,
  errors: picked.filter((s) => s.outcome === "upstream_error").length,
  tokensIn: picked.length * 10,
  metered: picked.filter((s) => s.basis === "metered").length * 0.1,
  notional: picked.filter((s) => s.basis === "notional").length * 0.2,
  unpriced: picked.filter((s) => s.basis === "unknown").length,
})
function check(body: UsageSummary, picked: Spec[]) {
  const want = fold(picked)
  expect(body.totals).toMatchObject({
    attempts: want.attempts,
    requests: want.requests,
    errors: want.errors,
    tokensIn: want.tokensIn,
  })
  expect(Number(body.totals.costMetered)).toBeCloseTo(want.metered, 6)
  expect(Number(body.totals.costNotional)).toBeCloseTo(want.notional, 6)
  expect(body.totals.unpriced.attempts).toBe(want.unpriced)
  // Series, failures and coverage agree with the filtered totals.
  expect(body.series.reduce((n, p) => n + p.attempts, 0)).toBe(want.attempts)
  expect(body.series.reduce((n, p) => n + p.requests, 0)).toBe(want.requests)
  expect(body.failures.attempts).toBe(want.attempts)
  expect(body.coverage.incomplete).toBe(false)
}

describe.skipIf(!historyUrl)("usage filters over HTTP and Postgres", () => {
  test("seed: keys (one purged through the tombstone path) and usage", async () => {
    const db = fixture.db()
    const keys = createApiKeyRepository(db)
    const tombstones = createApiKeyTombstoneRepository(db)
    const keysService = createKeysService({
      keys,
      mutations: createAdminMutationRepository(db),
      onCommitted: () => {},
      cipher: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") },
      audit: createAuditRecorder(createAuditRepository(db)),
      now: () => new Date(),
    })
    const make = async (name: string, owner: string, tool: string) => {
      const created = await keysService.create({
        name,
        owner,
        ownerKind: "person",
        tool,
      } as never)
      if (!created.ok) throw new Error("create failed")
      return created.value.id
    }
    ids.aliceEditor = await make("alice/editor", "alice", "editor")
    ids.aliceCli = await make("alice/cli", "alice", "cli")
    ids.bobEditor = await make("bob/editor", "bob", "editor")
    ids.bobCli = await make("bob/cli", "bob", "cli")
    await fixture.setUnpricedSince(new Date(now.getTime() - 10 * DAY).toISOString().slice(0, 10))

    const attempts = specs.map((s) =>
      historyAttempt({
        apiKeyId: ids[s.key],
        accountId: s.account,
        poolId: s.pool,
        model: s.model,
        outcome: s.outcome ?? "success",
        costBasis: s.basis,
        costEstimate:
          s.basis === "unknown" ? null : s.basis === "metered" ? "0.100000" : "0.200000",
        tokensIn: 10,
        tokensOut: 5,
        createdAt: new Date(now.getTime() - s.ago),
      }),
    )
    await fixture.usage().insertBatch({
      attempts,
      terminals: attempts.map((a) =>
        historyTerminal(a, {
          outcome: a.outcome ?? "success",
          settledAt: new Date((a.createdAt as Date).getTime() + 1_000),
        }),
      ),
    })
    // Purge bob/editor: the row goes, the tombstone keeps its owner and tool attributable.
    expect((await keysService.remove(ids.bobEditor)).ok).toBe(true)
    expect(await keys.findById(ids.bobEditor)).toBeUndefined()

    const service = createUsageService({
      history: fixture.history(),
      recent: createUsageRecentRepository(db),
      labels: catalogLabels({ keys, tombstones, catalog: { accounts: () => [], pools: () => [] } }),
      now: () => new Date(),
      breakdownMaxRows: 100,
    })
    app = new Hono<AdminAuthEnv>()
    app.route(
      ADMIN_USAGE_BASE_PATH,
      adminUsageRoutes({ service, guard: async (_c, next) => next() }),
    )
  })

  const dims: readonly [string, (q: string) => string, (s: Spec) => boolean][] = [
    ["owner", () => `owner=alice`, (s) => s.key.startsWith("alice")],
    ["owner (purged key included)", () => `owner=bob`, (s) => s.key.startsWith("bob")],
    ["tool", () => `tool=editor`, (s) => s.key.endsWith("Editor")],
    ["model", () => `model=m2`, (s) => s.model === "m2"],
    ["account", () => `accountId=${ACCOUNT_SUB}`, (s) => s.account === ACCOUNT_SUB],
    ["pool", () => `poolId=${POOL}`, (s) => s.pool === POOL],
  ]
  const windows: readonly [string, string][] = [
    ["7d", "window=7d"],
    [
      "hourly",
      `from=${new Date(now.getTime() - HOUR).toISOString()}&to=${new Date(now.getTime() + HOUR).toISOString()}`,
    ],
  ]
  for (const [wname, wquery] of windows) {
    const inWindow = (s: Spec) => (wname === "7d" ? s.ago < 7 * DAY : s.ago < HOUR)
    for (const [name, q, pick] of dims)
      test(`${wname}: ${name}`, async () => {
        const { status, body } = await get(`${wquery}&${q("")}`)
        expect(status).toBe(200)
        check(
          body,
          specs.filter((s) => inWindow(s) && pick(s)),
        )
      })
    test(`${wname}: OR within a dimension, AND across`, async () => {
      const or = await get(`${wquery}&owner=alice&owner=bob`)
      check(or.body, specs.filter(inWindow))
      const and = await get(`${wquery}&owner=bob&tool=cli&model=m2`)
      check(
        and.body,
        specs.filter((s) => inWindow(s) && s.key === "bobCli" && s.model === "m2"),
      )
      const keyOr = await get(`${wquery}&keyId=${ids.aliceCli}&keyId=${ids.bobCli}`)
      check(
        keyOr.body,
        specs.filter((s) => inWindow(s) && (s.key === "aliceCli" || s.key === "bobCli")),
      )
    })
  }

  test("an owner or tool matching no key returns zeros and a valid empty response", async () => {
    for (const q of ["owner=nobody", "tool=nothing", "owner=alice&tool=nothing"]) {
      const { status, body } = await get(`window=7d&${q}`)
      expect(status).toBe(200)
      expect(body.totals).toMatchObject({ attempts: 0, requests: 0, tokensIn: 0 })
      expect(body.totals.unpriced.attempts).toBe(0)
      expect(body.series.every((p) => p.attempts === 0)).toBe(true)
      expect(body.byKey).toEqual([])
      expect(body.failures.attempts).toBe(0)
    }
  })

  test("metered and notional are reported apart, unpriced under the filter", async () => {
    const { body } = await get(`window=7d&owner=alice`)
    expect(Number(body.totals.costMetered)).toBeCloseTo(0.1, 6)
    expect(Number(body.totals.costNotional)).toBeCloseTo(0.4, 6)
    expect(body.totals.unpriced.attempts).toBe(1)
  })

  test("a window spanning legacy usage_daily days honours the filter", async () => {
    const sql = fixture.get().sql
    await sql.unsafe("alter table usage_daily disable trigger usage_history_baseline_seal")
    await fixture.db().insert(usageDaily).values({
      day: "1984-03-01",
      apiKeyId: ids.aliceEditor,
      accountId: ACCOUNT_API,
      model: "m1",
      requests: 6,
      attempts: 6,
      costMetered: "0.600000",
    })
    await fixture.db().insert(usageDaily).values({
      day: "1984-03-02",
      apiKeyId: ids.bobCli,
      accountId: ACCOUNT_API,
      model: "m2",
      requests: 2,
      attempts: 2,
    })
    await sql.unsafe("alter table usage_daily enable trigger usage_history_baseline_seal")
    const range = "from=1984-02-28T00:00:00.000Z&to=1984-03-05T00:00:00.000Z"
    const alice = await get(`${range}&owner=alice`)
    expect(alice.body.totals).toMatchObject({ attempts: 6, requests: 6 })
    expect(Number(alice.body.totals.costMetered)).toBeCloseTo(0.6, 6)
    expect(alice.body.coverage.legacy).toBe(true)
    const bobCli = await get(`${range}&owner=bob&tool=cli`)
    expect(bobCli.body.totals).toMatchObject({ attempts: 2 })
    expect((await get(`${range}&owner=nobody`)).body.totals.attempts).toBe(0)
  })

  test("malformed ids are a 400, never a database error", async () => {
    for (const q of ["keyId=nope", "poolId=1", "accountId=x", "owner=", "model="]) {
      const response = await app.request(`${ADMIN_USAGE_BASE_PATH}?window=7d&${q}`)
      expect(response.status).toBe(400)
    }
  })

  test("window, from and to stay single-valued: the first value wins", async () => {
    const { status, body } = await get(`window=7d&window=bogus`)
    expect(status).toBe(200)
    expect(body.window).toBe("7d")
  })
})
