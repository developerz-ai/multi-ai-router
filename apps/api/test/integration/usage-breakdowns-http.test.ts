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
import { catalogLabels, createUsageService } from "../../src/services/usage-read"

/**
 * Owner and tool breakdowns, the three non-owner buckets and the retired marker (issue #246),
 * through the real route, resolver, repositories and Postgres.
 *
 * Every row below is folded by hand from `sources`, never read back from the code under test. The
 * fixture covers each way a usage row can fail to name an owner: a key with no owner or tool, a
 * key with an owner but no kind, a key that is gone with no tombstone, and a row with no key.
 */
const fixture = usageHistoryFixture()
const HOUR = 3_600_000
const DAY = 86_400_000
const now = new Date()

interface Row {
  readonly id: string | null
  readonly label: string | null
  readonly note: string | null
  readonly ownerKind?: string | null
  readonly retired?: boolean
  readonly totals: { requests: number; attempts: number; errors: number; tokensIn: number }
  readonly latencyP50Ms: number | null
  readonly latencyP95Ms: number | null
  readonly series: number[]
}
interface Body {
  totals: { requests: number; attempts: number; costMetered: string; costNotional: string }
  coverage: { breakdown: { truncated: string[] } }
  byKey: Row[]
  byOwner: Row[]
  byTool: Row[]
}

type Slot =
  | "aliceEditor"
  | "bobEditor"
  | "svcAlice"
  | "unassignedKey"
  | "bare"
  | "carol"
  | "ghost"
  | "none"
  | "dave1"
  | "dave2"
  | "dave3"
interface Source {
  readonly slot: Slot
  readonly n: number
  readonly latency: number
  /** owner bucket id and tool bucket id this slot must land in. */
  readonly owner: string
  readonly tool: string
  readonly basis: "metered" | "notional"
}
const sources: Source[] = [
  {
    slot: "aliceEditor",
    n: 4,
    latency: 10,
    owner: "person/alice",
    tool: "editor",
    basis: "metered",
  },
  { slot: "bobEditor", n: 2, latency: 20, owner: "person/bob", tool: "editor", basis: "notional" },
  { slot: "svcAlice", n: 3, latency: 30, owner: "service/alice", tool: "cli", basis: "metered" },
  {
    slot: "unassignedKey",
    n: 2,
    latency: 40,
    owner: "person/unassigned",
    tool: "unassigned",
    basis: "metered",
  },
  { slot: "bare", n: 1, latency: 50, owner: "#unassigned", tool: "#unassigned", basis: "metered" },
  {
    slot: "carol",
    n: 2,
    latency: 60,
    owner: "unknown/carol",
    tool: "#unassigned",
    basis: "metered",
  },
  { slot: "ghost", n: 2, latency: 70, owner: "#deleted", tool: "#deleted", basis: "metered" },
  { slot: "none", n: 3, latency: 80, owner: "#none", tool: "#none", basis: "notional" },
  { slot: "dave1", n: 1, latency: 90, owner: "person/dave", tool: "dx", basis: "metered" },
  { slot: "dave2", n: 2, latency: 90, owner: "person/dave", tool: "dx", basis: "metered" },
  { slot: "dave3", n: 3, latency: 90, owner: "person/dave", tool: "dx", basis: "metered" },
]
/** Attempt i of a source: even ones sit three days back (rollups), odd ones minutes back (receipts). */
const ago = (i: number) => (i % 2 === 0 ? 3 * DAY - i * 60_000 : (i + 1) * 60_000)
const attemptsOf = (s: Source) => Array.from({ length: s.n }, (_, i) => ago(i))

const ids = {} as Record<Slot, string>
let app: Hono<AdminAuthEnv>
let tinyApp: Hono<AdminAuthEnv>

async function get(target: Hono<AdminAuthEnv>, query: string) {
  const response = await target.request(`${ADMIN_USAGE_BASE_PATH}?${query}`)
  return { status: response.status, body: (await response.json()) as Body }
}
const WINDOWS: readonly [string, string, (age: number) => boolean][] = [
  ["7d", "window=7d", (age) => age < 7 * DAY],
  [
    "hourly",
    `from=${new Date(now.getTime() - HOUR).toISOString()}&to=${new Date(now.getTime() + HOUR).toISOString()}`,
    (age) => age < HOUR,
  ],
]
/** What a group id should total in a window, by hand. */
function want(pick: (s: Source) => string, inWindow: (age: number) => boolean) {
  const out = new Map<string, number>()
  for (const s of sources) {
    const n = attemptsOf(s).filter(inWindow).length
    if (n > 0) out.set(pick(s), (out.get(pick(s)) ?? 0) + n)
  }
  return out
}
const byId = (rows: Row[], id: string | null, note: string | null = null) =>
  rows.find((r) => r.id === id && (id !== null || r.note === note))
const wireId = (bucket: string) => (bucket.startsWith("#") ? null : bucket)
const wireNote = (bucket: string) => (bucket.startsWith("#") ? bucket.slice(1) : null)

describe.skipIf(!historyUrl)("usage owner and tool breakdowns over HTTP and Postgres", () => {
  test("seed", async () => {
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
    const make = async (name: string, rest: Record<string, string>) => {
      const created = await keysService.create({ name, ...rest } as never)
      if (!created.ok) throw new Error("create failed")
      return created.value.id
    }
    ids.aliceEditor = await make("alice-editor", {
      owner: "alice",
      ownerKind: "person",
      tool: "editor",
    })
    ids.bobEditor = await make("bob-editor", { owner: "bob", ownerKind: "person", tool: "editor" })
    ids.svcAlice = await make("svc-alice", { owner: "alice", ownerKind: "service", tool: "cli" })
    ids.unassignedKey = await make("literal", {
      owner: "unassigned",
      ownerKind: "person",
      tool: "unassigned",
    })
    ids.bare = await make("bare", {})
    ids.carol = await make("carol", { owner: "carol" })
    for (const slot of ["dave1", "dave2", "dave3"] as const)
      ids[slot] = await make(slot, { owner: "dave", ownerKind: "person", tool: "dx" })
    ids.ghost = crypto.randomUUID()
    ids.none = ""
    expect((await keysService.remove(ids.bobEditor)).ok).toBe(true)

    const attempts = sources.flatMap((s) =>
      attemptsOf(s).map((age) =>
        historyAttempt({
          apiKeyId: s.slot === "none" ? null : ids[s.slot],
          model: "m1",
          latencyMs: s.latency,
          costBasis: s.basis,
          costEstimate: "0.100000",
          tokensIn: 10,
          tokensOut: 5,
          createdAt: new Date(now.getTime() - age),
        }),
      ),
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
    const build = (breakdownMaxRows: number) => {
      const service = createUsageService({
        history: fixture.history(),
        recent: createUsageRecentRepository(db),
        labels: catalogLabels({
          keys,
          tombstones,
          catalog: { accounts: () => [], pools: () => [] },
        }),
        now: () => new Date(),
        breakdownMaxRows,
      })
      const hono = new Hono<AdminAuthEnv>()
      hono.route(
        ADMIN_USAGE_BASE_PATH,
        adminUsageRoutes({ service, guard: async (_c, next) => next() }),
      )
      return hono
    }
    app = build(100)
    tinyApp = build(2)
  })

  for (const [wname, wquery, inWindow] of WINDOWS) {
    test(`${wname}: byOwner and byTool rows equal the hand sums, one row per bucket`, async () => {
      const { status, body } = await get(app, wquery)
      expect(status).toBe(200)
      for (const [rows, pick] of [
        [body.byOwner, (s: Source) => s.owner],
        [body.byTool, (s: Source) => s.tool],
      ] as const) {
        const expected = want(pick, inWindow)
        expect(rows.length).toBe(expected.size)
        for (const [bucket, attempts] of expected) {
          const row = byId(rows, wireId(bucket), wireNote(bucket))
          expect(row?.totals.attempts).toBe(attempts)
          expect(row?.totals.requests).toBe(attempts)
          expect(row?.totals.tokensIn).toBe(attempts * 10)
          expect(row?.series.reduce((n, v) => n + v, 0)).toBe(attempts)
        }
        expect(rows.reduce((n, r) => n + r.totals.attempts, 0)).toBe(body.totals.attempts)
      }
    })
  }

  test("each non-owner bucket is its own row with a null id, a null label and its own note", async () => {
    const { body } = await get(app, "window=7d")
    for (const rows of [body.byOwner, body.byTool]) {
      for (const note of ["unassigned", "deleted", "none"]) {
        const found = rows.filter((r) => r.id === null && r.note === note)
        expect(found.length).toBe(1)
        expect(found[0]?.label).toBeNull()
        // Only owner rows carry the field; on them it is null, never merely absent.
        if (rows === body.byOwner) expect(found[0]?.ownerKind).toBeNull()
      }
    }
  })

  test("latency and series follow the bucket, not the null id", async () => {
    const { body } = await get(app, "window=7d")
    const latencyOf = (slot: Slot) => sources.find((s) => s.slot === slot)?.latency
    for (const note of ["deleted", "none"] as const) {
      const slot = note === "deleted" ? "ghost" : "none"
      for (const rows of [body.byOwner, body.byTool]) {
        const row = byId(rows, null, note)
        expect(row?.latencyP50Ms).toBe(latencyOf(slot))
        expect(row?.latencyP95Ms).toBe(latencyOf(slot))
      }
    }
    expect(byId(body.byOwner, null, "unassigned")?.latencyP50Ms).toBe(latencyOf("bare"))
    expect(byId(body.byOwner, "person/alice")?.latencyP95Ms).toBe(latencyOf("aliceEditor"))
    expect(byId(body.byTool, "cli")?.latencyP95Ms).toBe(latencyOf("svcAlice"))
  })

  test("an owner and a tool literally named unassigned are their own rows", async () => {
    const { body } = await get(app, "window=7d")
    const owner = byId(body.byOwner, "person/unassigned")
    expect(owner?.label).toBe("unassigned")
    expect(owner?.note).toBeNull()
    expect(owner?.totals.attempts).toBe(2)
    expect(byId(body.byTool, "unassigned")?.totals.attempts).toBe(2)
    expect(byId(body.byOwner, null, "unassigned")?.totals.attempts).toBe(1)
    expect(byId(body.byTool, null, "unassigned")?.totals.attempts).toBe(3)
  })

  test("a person and a service sharing a slug are two byOwner rows; no kind is null", async () => {
    const { body } = await get(app, "window=7d")
    const person = byId(body.byOwner, "person/alice")
    const service = byId(body.byOwner, "service/alice")
    expect(person?.ownerKind).toBe("person")
    expect(service?.ownerKind).toBe("service")
    expect(person?.label).toBe("alice")
    expect(service?.label).toBe("alice")
    expect(person?.totals.attempts).toBe(4)
    expect(service?.totals.attempts).toBe(3)
    const carol = byId(body.byOwner, "unknown/carol")
    expect(carol?.ownerKind).toBeNull()
    expect(carol?.label).toBe("carol")
    expect(byId(body.byTool, "editor")?.label).toBe("editor")
  })

  test("retired is true only for a key that exists only as a tombstone", async () => {
    const { body } = await get(app, "window=7d")
    expect(byId(body.byKey, ids.bobEditor)?.retired).toBe(true)
    expect(byId(body.byKey, ids.aliceEditor)?.retired).toBe(false)
    const ghost = byId(body.byKey, ids.ghost)
    expect(ghost?.note).toBe("deleted")
    expect(ghost?.retired).toBe(false)
    const none = byId(body.byKey, null, "none")
    expect(none?.retired).toBe(false)
    expect(byId(body.byKey, ids.bobEditor)?.note).toBeNull()
  })

  test("many keys fold into one owner row before the cap", async () => {
    const { body } = await get(tinyApp, "window=7d&owner=dave")
    expect(body.byKey.length).toBe(2)
    expect(body.coverage.breakdown.truncated).toContain("apiKeyId")
    expect(body.coverage.breakdown.truncated).not.toContain("owner")
    expect(body.byOwner.length).toBe(1)
    expect(body.byOwner[0]?.totals.attempts).toBe(6)
    expect(body.byTool.length).toBe(1)
    expect(body.byTool[0]?.totals.attempts).toBe(6)
  })

  test("coverage.breakdown.truncated names owner and tool when capped", async () => {
    const { body } = await get(tinyApp, "window=7d")
    expect(body.coverage.breakdown.truncated).toContain("owner")
    expect(body.coverage.breakdown.truncated).toContain("tool")
    expect(body.byOwner.length).toBe(2)
  })

  test("metered and notional are never summed", async () => {
    const { body } = await get(app, "window=7d")
    const bob = byId(body.byOwner, "person/bob") as unknown as {
      totals: { attempts: number; costMetered: string; costNotional: string }
    }
    expect(bob.totals.attempts).toBe(2)
    expect(Number(bob.totals.costMetered)).toBe(0)
    expect(Number(bob.totals.costNotional)).toBeCloseTo(0.2, 6)
  })

  test("a window served from usage_daily groups the same way", async () => {
    const sql = fixture.get().sql
    await sql.unsafe("alter table usage_daily disable trigger usage_history_baseline_seal")
    const account = crypto.randomUUID()
    await fixture.db().insert(usageDaily).values({
      day: "1984-03-01",
      apiKeyId: ids.aliceEditor,
      accountId: account,
      model: "m1",
      requests: 6,
      attempts: 6,
    })
    await fixture.db().insert(usageDaily).values({
      day: "1984-03-02",
      apiKeyId: ids.ghost,
      accountId: account,
      model: "m1",
      requests: 2,
      attempts: 2,
    })
    await sql.unsafe("alter table usage_daily enable trigger usage_history_baseline_seal")
    const { body } = await get(app, "from=1984-02-28T00:00:00.000Z&to=1984-03-05T00:00:00.000Z")
    expect(byId(body.byOwner, "person/alice")?.totals.attempts).toBe(6)
    expect(byId(body.byOwner, null, "deleted")?.totals.attempts).toBe(2)
    expect(byId(body.byTool, "editor")?.totals.attempts).toBe(6)
    expect(body.byOwner.length).toBe(2)
  })
})
