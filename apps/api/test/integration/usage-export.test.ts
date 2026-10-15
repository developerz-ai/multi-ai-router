import { describe, expect, test } from "bun:test"
import {
  createAdminMutationRepository,
  createApiKeyRepository,
  createApiKeyTombstoneRepository,
  createAuditRepository,
  createUsageRecentRepository,
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
import {
  accountProviders,
  catalogLabels,
  createUsageService,
  type UsageSummary,
} from "../../src/services/usage-read"
import { micros, records, sum, sumMicros } from "../support/csv-sums"

/**
 * The CSV export (issue #226) through the real route, resolver, repositories and Postgres.
 * Models are attacker-chosen strings (any router-key holder picks one), so three of the fixture
 * models are a formula, a tab-led formula and a comma; one key is named like a formula.
 */
const fixture = usageHistoryFixture()
const HOUR = 3_600_000
const DAY = 86_400_000

const HEADER =
  "day,owner,owner_kind,tool,key_name,key_prefix,pool,account,provider,model,requests,attempts,errors,tokens_in,tokens_out,cache_read,cache_write,cost_metered_usd,cost_notional_usd,unpriced_attempts"

const ACCOUNT_API = crypto.randomUUID()
const ACCOUNT_SUB = crypto.randomUUID()
const ACCOUNT_GONE = crypto.randomUUID()
const POOL = crypto.randomUUID()

const FORMULA = "@SUM(1)"
const TABBED = "\t=cmd"
const COMMA = "gpt,4"

type KeyName = "alice" | "bob" | "bobPurged"
interface Spec {
  readonly key: KeyName
  readonly account: string
  readonly pool: string | null
  readonly model: string
  readonly basis: "metered" | "notional" | "unknown"
  readonly ago: number
}
const specs: Spec[] = [
  {
    key: "alice",
    account: ACCOUNT_API,
    pool: POOL,
    model: FORMULA,
    basis: "metered",
    ago: 3 * DAY,
  },
  {
    key: "alice",
    account: ACCOUNT_SUB,
    pool: POOL,
    model: TABBED,
    basis: "notional",
    ago: 3 * DAY,
  },
  { key: "bob", account: ACCOUNT_API, pool: null, model: COMMA, basis: "unknown", ago: 2 * DAY },
  {
    key: "bobPurged",
    account: ACCOUNT_GONE,
    pool: null,
    model: "m1",
    basis: "metered",
    ago: 2 * DAY,
  },
  {
    key: "alice",
    account: ACCOUNT_SUB,
    pool: POOL,
    model: "m1",
    basis: "notional",
    ago: 30 * 60_000,
  },
  { key: "bob", account: ACCOUNT_API, pool: POOL, model: "m1", basis: "metered", ago: 20 * 60_000 },
  { key: "bob", account: ACCOUNT_API, pool: POOL, model: "m1", basis: "metered", ago: 10 * 60_000 },
]

const now = new Date()
const ids = {} as Record<KeyName, string>
const prefixes = {} as Record<KeyName, string>
const secrets: string[] = []
let app: Hono<AdminAuthEnv>

const ISO = (ms: number) => new Date(ms).toISOString()
const WIDE = `from=${ISO(now.getTime() - 7 * DAY)}&to=${ISO(now.getTime() + HOUR)}`

async function exportOf(query: string, target: Hono<AdminAuthEnv> = app) {
  const response = await target.request(`${ADMIN_USAGE_BASE_PATH}/export.csv?${query}`)
  return { response, text: await response.text() }
}
async function summaryOf(query: string) {
  const response = await app.request(`${ADMIN_USAGE_BASE_PATH}?${query}`)
  return (await response.json()) as UsageSummary
}
describe.skipIf(!historyUrl)("usage CSV export over HTTP and Postgres", () => {
  test("seed: keys (one purged), accounts, pools and usage", async () => {
    const db = fixture.db()
    const keys = createApiKeyRepository(db)
    const tombstones = createApiKeyTombstoneRepository(db)
    const cipher = {
      encrypt: (s: string) => `enc:${s}`,
      decrypt: (s: string) => s.replace(/^enc:/, ""),
    }
    const keysService = createKeysService({
      keys,
      mutations: createAdminMutationRepository(db),
      onCommitted: () => {},
      cipher,
      audit: createAuditRecorder(createAuditRepository(db)),
      now: () => new Date(),
    })
    const make = async (name: string, owner: string, tool: string, slot: KeyName) => {
      const created = await keysService.create({ name, owner, ownerKind: "person", tool } as never)
      if (!created.ok) throw new Error("create failed")
      ids[slot] = created.value.id
      prefixes[slot] = created.value.prefix
    }
    await make('=HYPERLINK("x")', "alice", "editor", "alice")
    await make("bob, the key", "bob", "cli", "bob")
    await make("bob/old", "bob", "cli", "bobPurged")
    for (const slot of ["alice", "bob", "bobPurged"] as const) {
      const row = await keys.findById(ids[slot])
      if (row === undefined) throw new Error("missing key row")
      secrets.push(row.value, cipher.decrypt(row.value))
    }
    await fixture.setUnpricedSince(new Date(now.getTime() - 10 * DAY).toISOString().slice(0, 10))

    const attempts = specs.map((s) =>
      historyAttempt({
        apiKeyId: ids[s.key],
        accountId: s.account,
        poolId: s.pool,
        model: s.model,
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
          settledAt: new Date((a.createdAt as Date).getTime() + 1_000),
        }),
      ),
    })
    expect((await keysService.remove(ids.bobPurged)).ok).toBe(true)

    const catalog = {
      accounts: () =>
        [
          { id: ACCOUNT_API, snapshot: { label: "api-one", provider: "openai" } },
          { id: ACCOUNT_SUB, snapshot: { label: "sub-one", provider: "claude-sdk" } },
        ] as never,
      pools: () => [{ id: POOL, name: "main-pool" }] as never,
    }
    const build = (exportMaxRows: number) => {
      const service = createUsageService({
        history: fixture.history(),
        recent: createUsageRecentRepository(db),
        labels: catalogLabels({ keys, tombstones, catalog }),
        providers: accountProviders(catalog),
        now: () => new Date(),
        breakdownMaxRows: 100,
        exportMaxRows,
      })
      const target = new Hono<AdminAuthEnv>()
      target.route(
        ADMIN_USAGE_BASE_PATH,
        adminUsageRoutes({ service, guard: async (_c, next) => next() }),
      )
      return target
    }
    app = build(50_000)
  })

  test("the header row is exact and the response is a CSV attachment", async () => {
    const { response, text } = await exportOf("window=7d")
    expect(response.status).toBe(200)
    expect(text.split("\r\n")[0]).toBe(HEADER)
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-store")
    // Every record ends CRLF: removing CRLFs leaves no bare line feed.
    expect(text.endsWith("\r\n")).toBe(true)
    expect(text.replaceAll("\r\n", "").includes("\n")).toBe(false)
  })

  test("the filename carries the window and is safe for a custom ISO range", async () => {
    const named = await exportOf("window=7d")
    expect(named.response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="usage-7d-[A-Za-z0-9._-]+\.csv"$/,
    )
    const custom = await exportOf(WIDE)
    const disposition = custom.response.headers.get("content-disposition") ?? ""
    expect(disposition).toMatch(/^attachment; filename="usage-custom-[A-Za-z0-9._-]+\.csv"$/)
    expect(disposition).not.toContain(":")
  })

  test("a formula-named key and formula-like models are guarded; commas keep the columns", async () => {
    const rows = records((await exportOf(WIDE)).text)
    const names = new Set(rows.map((row) => row.key_name))
    expect(names.has('\'=HYPERLINK("x")')).toBe(true)
    expect(names.has("bob, the key")).toBe(true)
    const models = new Set(rows.map((row) => row.model))
    expect(models.has(`'${FORMULA}`)).toBe(true)
    expect(models.has("'\t'=cmd")).toBe(true)
    expect(models.has(COMMA)).toBe(true)
    // csv-parse already throws on a ragged row; this pins the count itself.
    for (const row of rows) expect(Object.keys(row)).toHaveLength(HEADER.split(",").length)
  })

  test("cells come from the label maps; absent values are empty", async () => {
    const rows = records((await exportOf(WIDE)).text)
    const alice = rows.find((row) => row.model === "m1" && row.owner === "alice")
    expect(alice).toMatchObject({
      owner: "alice",
      owner_kind: "person",
      tool: "editor",
      key_prefix: prefixes.alice,
      pool: "main-pool",
      account: "sub-one",
      provider: "claude-sdk",
    })
    expect(alice?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // A pool-less key: empty pool. A deleted account: empty account and provider. A purged key
    // keeps owner, tool and prefix through its tombstone.
    const purged = rows.find((row) => row.key_prefix === prefixes.bobPurged)
    expect(purged).toMatchObject({
      key_name: "bob/old",
      owner: "bob",
      tool: "cli",
      pool: "",
      account: "",
      provider: "",
    })
  })

  test("no key value and no stored ciphertext appears in the file", async () => {
    const { text } = await exportOf(WIDE)
    expect(secrets.length).toBe(6)
    for (const secret of secrets) expect(text.includes(secret)).toBe(false)
  })

  test("on measured days unpriced_attempts reads a number", async () => {
    const measured = records((await exportOf(WIDE)).text)
    expect(measured.every((row) => /^\d+$/.test(row.unpriced_attempts ?? ""))).toBe(true)
  })

  const filterSets = ["", "owner=alice", "owner=bob&tool=cli", "model=m1", `poolId=${POOL}`]
  for (const [name, window] of [
    ["7d", "window=7d"],
    ["a custom window ending after today", WIDE],
    ["hourly", `from=${ISO(now.getTime() - HOUR)}&to=${ISO(now.getTime() + HOUR)}`],
  ] as const)
    test(`per-column sums equal the summary: ${name}`, async () => {
      for (const filter of filterSets) {
        const query = filter === "" ? window : `${window}&${filter}`
        const rows = records((await exportOf(query)).text)
        const { totals } = await summaryOf(query)
        expect(sum(rows, "requests")).toBe(totals.requests)
        expect(sum(rows, "attempts")).toBe(totals.attempts)
        expect(sum(rows, "errors")).toBe(totals.errors)
        expect(sum(rows, "tokens_in")).toBe(totals.tokensIn)
        expect(sum(rows, "tokens_out")).toBe(totals.tokensOut)
        expect(sum(rows, "cache_read")).toBe(totals.cacheReadTokens)
        expect(sum(rows, "cache_write")).toBe(totals.cacheWriteTokens)
        expect(sumMicros(rows, "cost_metered_usd")).toBe(micros(totals.costMetered))
        expect(sumMicros(rows, "cost_notional_usd")).toBe(micros(totals.costNotional))
        expect(sum(rows, "unpriced_attempts")).toBe(totals.unpriced.attempts ?? 0)
      }
    })

  test("the filters narrow the rows the way they narrow the summary", async () => {
    const rows = records((await exportOf(`${WIDE}&owner=alice`)).text)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.owner === "alice")).toBe(true)
    expect(records((await exportOf(`${WIDE}&owner=nobody`)).text)).toEqual([])
  })
})
