import { describe, expect, test } from "bun:test"
import {
  createAccountRepository,
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
 *
 * The fixture is the acceptance grid: 2 owners x 2 tools x 2 models x {metered, notional, unknown}
 * = 24 attempts, one per cell. The 4 keys are owner x tool; bob/editor is purged through the
 * tombstone path; the cli keys are pool-less; notional traffic runs on a real subscription-provider
 * account row and the rest on a real API-key account row. Half the attempts sit three days back
 * (daily rollups) and half in the last half hour (receipt edges). Expected values are folded by
 * hand from this list, never read back from the code under test.
 */
const fixture = usageHistoryFixture()
const HOUR = 3_600_000
const DAY = 86_400_000

let ACCOUNT_API = ""
let ACCOUNT_SUB = ""
const POOL = crypto.randomUUID()

type Owner = "alice" | "bob"
type Tool = "editor" | "cli"
interface Spec {
  readonly owner: Owner
  readonly tool: Tool
  readonly account: () => string
  readonly pool: string | null
  readonly model: "m1" | "m2"
  readonly basis: "metered" | "notional" | "unknown"
  /** Milliseconds before the test's `now`. Whole days back reach the rollup; minutes the receipts. */
  readonly ago: number
  readonly outcome: "success" | "upstream_error"
}
const specs: Spec[] = []
for (const owner of ["alice", "bob"] as const)
  for (const tool of ["editor", "cli"] as const)
    for (const model of ["m1", "m2"] as const)
      for (const basis of ["metered", "notional", "unknown"] as const) {
        const i = specs.length
        specs.push({
          owner,
          tool,
          account: () => (basis === "notional" ? ACCOUNT_SUB : ACCOUNT_API),
          pool: tool === "cli" ? null : POOL,
          model,
          basis,
          ago: i % 2 === 0 ? 3 * DAY - i * 60_000 : (i + 1) * 60_000,
          outcome: i % 5 === 0 ? "upstream_error" : "success",
        })
      }
const keyName = (s: { owner: Owner; tool: Tool }) => `${s.owner}${s.tool}` as KeyName
type KeyName = "aliceeditor" | "alicecli" | "bobeditor" | "bobcli"
const LATENCY: Record<Owner, number> = { alice: 10, bob: 500 }

const now = new Date()
const ids = {} as Record<KeyName, string>
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
    ids.aliceeditor = await make("alice/editor", "alice", "editor")
    ids.alicecli = await make("alice/cli", "alice", "cli")
    ids.bobeditor = await make("bob/editor", "bob", "editor")
    ids.bobcli = await make("bob/cli", "bob", "cli")
    const accounts = createAccountRepository(db)
    ACCOUNT_API = (
      await accounts.create({ label: "api", provider: "anthropic-api", authMaterial: "enc:x" })
    ).id
    ACCOUNT_SUB = (
      await accounts.create({
        label: "claude sub",
        provider: "anthropic-oauth",
        configDir: "/tmp/fixture-sub",
        billing: "subscription",
      })
    ).id
    await fixture.setUnpricedSince(new Date(now.getTime() - 10 * DAY).toISOString().slice(0, 10))

    const attempts = specs.map((s) =>
      historyAttempt({
        apiKeyId: ids[keyName(s)],
        accountId: s.account(),
        poolId: s.pool,
        model: s.model,
        outcome: s.outcome,
        latencyMs: LATENCY[s.owner],
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
          outcome: a.outcome,
          settledAt: new Date((a.createdAt as Date).getTime() + 1_000),
        }),
      ),
    })
    // Purge bob/editor: the row goes, the tombstone keeps its owner and tool attributable.
    expect((await keysService.remove(ids.bobeditor)).ok).toBe(true)
    expect(await keys.findById(ids.bobeditor)).toBeUndefined()

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
    ["owner", () => `owner=alice`, (s) => s.owner === "alice"],
    ["owner (purged key included)", () => `owner=bob`, (s) => s.owner === "bob"],
    ["tool", () => `tool=editor`, (s) => s.tool === "editor"],
    ["model", () => `model=m2`, (s) => s.model === "m2"],
    ["account", () => `accountId=${ACCOUNT_SUB}`, (s) => s.account() === ACCOUNT_SUB],
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
        specs.filter(
          (s) => inWindow(s) && s.owner === "bob" && s.tool === "cli" && s.model === "m2",
        ),
      )
      const keyOr = await get(`${wquery}&keyId=${ids.alicecli}&keyId=${ids.bobcli}`)
      check(
        keyOr.body,
        specs.filter((s) => inWindow(s) && s.tool === "cli"),
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
    const alice = specs.filter((s) => s.owner === "alice")
    const want = fold(alice)
    expect(want.metered).toBeGreaterThan(0)
    expect(want.notional).toBeGreaterThan(0)
    expect(Number(body.totals.costMetered)).toBeCloseTo(want.metered, 6)
    expect(Number(body.totals.costNotional)).toBeCloseTo(want.notional, 6)
    expect(body.totals.unpriced.attempts).toBe(want.unpriced)
  })

  test("latency, group rows and their series follow the filter", async () => {
    const alice = await get(`window=7d&owner=alice`)
    expect(alice.body.latency).toMatchObject({ p50Ms: LATENCY.alice, p95Ms: LATENCY.alice })
    const bob = await get(`window=7d&owner=bob`)
    expect(bob.body.latency).toMatchObject({ p50Ms: LATENCY.bob, p95Ms: LATENCY.bob })
    const nobody = await get(`window=7d&owner=nobody`)
    expect(nobody.body.latency.p50Ms).toBeNull()
    expect(nobody.body.latency.p95Ms).toBeNull()
    // Group rows carry only the filtered traffic, and each row's sparkline sums to its totals.
    const wantKeys = new Set([ids.aliceeditor, ids.alicecli])
    expect(alice.body.byKey.map((r) => r.id).sort()).toEqual([...wantKeys].sort())
    for (const row of [...alice.body.byKey, ...alice.body.byModel, ...alice.body.byAccount]) {
      expect(row.series.reduce((n, v) => n + v, 0)).toBe(row.totals.requests)
      expect(row.latencyP95Ms).toBe(LATENCY.alice)
    }
    expect(alice.body.byModel.map((r) => r.id).sort()).toEqual(["m1", "m2"])
    expect(alice.body.byModel.reduce((n, r) => n + r.totals.attempts, 0)).toBe(
      alice.body.totals.attempts,
    )
  })

  test("a comma is not a separator, and listing every value equals no filter", async () => {
    const comma = await get(`window=7d&owner=alice,bob`)
    expect(comma.status).toBe(200)
    expect(comma.body.totals.attempts).toBe(0)
    const all = await get(`window=7d`)
    const models = await get(`window=7d&model=m1&model=m2`)
    expect(models.body.totals).toEqual(all.body.totals)
    check(all.body, specs)
  })

  test("uppercase ids are folded, not missed", async () => {
    const lower = await get(`window=7d&keyId=${ids.alicecli}`)
    const upper = await get(`window=7d&keyId=${ids.alicecli.toUpperCase()}&owner=alice`)
    expect(upper.status).toBe(200)
    expect(upper.body.totals).toEqual(lower.body.totals)
    expect(upper.body.totals.attempts).toBeGreaterThan(0)
  })

  test("a misspelled parameter is a 400 naming it, never unfiltered totals", async () => {
    for (const name of ["apiKeyId", "owners", "Owner", "owner[]"]) {
      const response = await app.request(`${ADMIN_USAGE_BASE_PATH}?window=7d&${name}=x`)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain(name)
    }
  })

  test("a window spanning legacy usage_daily days honours the filter", async () => {
    const sql = fixture.get().sql
    await sql.unsafe("alter table usage_daily disable trigger usage_history_baseline_seal")
    await fixture.db().insert(usageDaily).values({
      day: "1984-03-01",
      apiKeyId: ids.aliceeditor,
      accountId: ACCOUNT_API,
      model: "m1",
      requests: 6,
      attempts: 6,
      costMetered: "0.600000",
    })
    await fixture.db().insert(usageDaily).values({
      day: "1984-03-02",
      apiKeyId: ids.bobcli,
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
    for (const q of ["keyId=nope", "poolId=1", "accountId=x", "owner=", "model=", "model=%00"]) {
      const response = await app.request(`${ADMIN_USAGE_BASE_PATH}?window=7d&${q}`)
      expect(response.status).toBe(400)
    }
  })

  test("an unknown key is echoed truncated", async () => {
    const response = await app.request(`${ADMIN_USAGE_BASE_PATH}?window=7d&${"z".repeat(500)}=1`)
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain("z".repeat(65))
  })

  test("window, from and to stay single-valued: the first value wins", async () => {
    const { status, body } = await get(`window=7d&window=bogus`)
    expect(status).toBe(200)
    expect(body.window).toBe("7d")
  })

  test("a filter list is capped at 500 values", async () => {
    const ok = await app.request(`${ADMIN_USAGE_BASE_PATH}?window=7d&${"model=m1&".repeat(500)}`)
    expect(ok.status).toBe(200)
    const tooMany = await app.request(
      `${ADMIN_USAGE_BASE_PATH}?window=7d&${"model=m1&".repeat(501)}`,
    )
    expect(tooMany.status).toBe(400)
  })
})
