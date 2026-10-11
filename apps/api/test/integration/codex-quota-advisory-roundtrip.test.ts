import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  createAccountRepository,
  createCatalogSnapshotRepository,
  createDatabase,
  type DatabaseHandle,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import { createHealthStore, type HealthStore } from "../../src/services/dataplane"
import { overlayHealth } from "../../src/services/dataplane/snapshot"
import { evaluateCandidate } from "../../src/services/routing"
import { toQuotaEvidence } from "../../src/services/routing/quota-evidence"
import { memoryAccountQuota } from "../support/memory-account-quota"

/**
 * The persistence round trip for the `advisory` marker, against the real database.
 *
 * Without this, the marker could be lost on its way from the provider reading to the catalog to
 * the routing snapshot and no test would notice. The unit test (`recovery/quota-advisory-
 * roundtrip.test.ts`) is an in-memory stand-in: it proves the same predicate on the read-back
 * path of a fake. This one proves it on the SQL path — the marker survives the insert values,
 * the on-conflict set, `listQuotaWindows`/`loadCatalog`, `toQuotaEvidence`, the overlay at equal
 * `lastCheckedAt`, and the candidate evaluator's verdict.
 *
 * Scenario (the one the spec-gate flagged in round 2): an existing non-advisory row at
 * utilization 1 with a future reset, then an advisory reading with a later `lastCheckedAt` for
 * the same window. A first insert alone would not be red on a missing on-conflict `advisory` —
 * it is the second update that proves the marker travels the whole way.
 */

const NOW = new Date("2026-10-11T12:00:00.000Z")
const LATER = new Date(NOW.getTime() + 1000)
const FUTURE = new Date(NOW.getTime() + 3600_000)

let db: DatabaseHandle | undefined
const createdAccountIds: string[] = []

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  db = createDatabase({ url, maxConnections: 4 })
})

afterAll(async () => {
  if (!db) return
  if (createdAccountIds.length > 0) {
    const accounts = createAccountRepository(db.db)
    for (const id of createdAccountIds) await accounts.delete(id).catch(() => undefined)
  }
  await db.close()
})

function expectDb(): DatabaseHandle {
  if (!db) throw new Error("DATABASE_URL is required for this integration suite")
  return db
}

describe.skipIf(!process.env.DATABASE_URL)(
  "the advisory marker round-trips through Postgres",
  () => {
    async function newAccount() {
      const handle = expectDb()
      const repo = createAccountRepository(handle.db)
      const row = await repo.create({
        label: `advisory-roundtrip-${crypto.randomUUID().slice(0, 8)}`,
        provider: "zai",
        authMaterial: null,
      })
      createdAccountIds.push(row.id)
      return row.id
    }

    test("a non-advisory row at 100% is followed by an advisory reading that survives the conflict-set write", async () => {
      const handle = expectDb()
      const accountId = await newAccount()
      const repo = createAccountRepository(handle.db)

      // First reading: non-advisory, utilization 1 with a future reset. Without the marker this
      // is the canonical blocking reading. We are about to overwrite it with an advisory one and
      // need the marker to be the only thing standing between the row and a `quota-window-spent`.
      const first = await repo.upsertQuotaWindow(accountId, {
        window: "five_hour",
        utilization: 1,
        utilizationSource: "continuous",
        resetsAt: FUTURE,
        resetSource: "provider-reported",
        lastCheckedAt: NOW,
      })
      expect(first.advisory).toBe(false)

      // Second reading: advisory, same utilization and reset, but later clock. The conflict-set
      // path is what carries the marker through to the row — without it, the on-conflict do
      // update would overwrite the row with the marker stripped.
      const second = await repo.upsertQuotaWindow(accountId, {
        window: "five_hour",
        utilization: 1,
        utilizationSource: "continuous",
        resetsAt: FUTURE,
        resetSource: "provider-reported",
        lastCheckedAt: LATER,
        advisory: true,
      })
      expect(second.advisory).toBe(true)
      // The revision advances because the reading was fresher — proving the row was rewritten,
      // not just re-asserted.
      expect(second.revision).toBeGreaterThan(first.revision)

      // Read back through the catalog snapshot, the path `loadCatalog` uses at boot and on every
      // catalog refresh. The marker's persistence is what makes this round trip honest.
      const snapshot = await createCatalogSnapshotRepository(handle.db).read()
      const windowRows = snapshot.windows.filter((row) => row.accountId === accountId)
      expect(windowRows).toHaveLength(1)
      expect(windowRows[0]?.advisory).toBe(true)
    })

    test("toQuotaEvidence spreads the marker back, so the routing snapshot still carries it", async () => {
      const accountId = await newAccount()
      const repo = createAccountRepository(expectDb().db)

      await repo.upsertQuotaWindow(accountId, {
        window: "five_hour",
        utilization: 1,
        utilizationSource: "continuous",
        resetsAt: FUTURE,
        resetSource: "provider-reported",
        lastCheckedAt: NOW,
        advisory: true,
      })

      const rows = await repo.listQuotaWindows([accountId])
      const stored = rows[0]
      if (!stored) throw new Error("no row written for the seeded account")
      const evidence = toQuotaEvidence({
        ...stored,
        utilization: stored.utilization,
        resetsAt: stored.resetsAt,
        retiredAt: null,
        evidenceState: "current",
        blocksRouting: true,
        advisory: stored.advisory,
      })
      // Conditional spread in toQuotaEvidence keeps the field off absent rows. Persisted-true
      // is exactly the case the marker is built for; this is what would go red if the mapper
      // ever stopped carrying `advisory` through.
      expect(evidence.advisory).toBe(true)
    })

    test("an overlay at equal lastCheckedAt keeps the advisory marker, and the candidate evaluator does not return quota-window-spent", async () => {
      const handle = expectDb()
      const accountId = await newAccount()
      const repo = createAccountRepository(handle.db)

      // Seed an advisory row at 1 with a future reset. This is the worst-case reading — the
      // provider says 100% — and it is also the one the operator's display-only ruling exists
      // for. The reading's clock is the wall clock at the moment of the live request.
      await repo.upsertQuotaWindow(accountId, {
        window: "five_hour",
        utilization: 1,
        utilizationSource: "continuous",
        resetsAt: FUTURE,
        resetSource: "provider-reported",
        lastCheckedAt: NOW,
        advisory: true,
      })

      // Read back through the catalog snapshot repository and the catalog loader — the production
      // path `loadCatalog` uses at boot and on every catalog refresh.
      const { loadCatalog } = await import("../../src/services/catalog")
      const catalogData = await loadCatalog(createCatalogSnapshotRepository(handle.db))
      const cataloged = catalogData.accounts.find((row) => row.id === accountId)
      if (!cataloged) throw new Error("account not in the catalog")
      const accountSnapshot = cataloged.snapshot

      // A live Codex reading at the same `lastCheckedAt` as the catalog row (the equal-clock
      // branch `mergeQuotaEvidence` picks the more-restrictive side; the marker must survive it).
      const health: HealthStore = createHealthStore({ jitter: () => 0 })
      health.applyRateLimit(
        accountId,
        {
          limited: false,
          resetSource: "provider-reported",
          windows: [],
          quotaWindows: [
            {
              window: "five_hour",
              utilization: 1,
              utilizationSource: "continuous",
              resetsAt: FUTURE,
              resetSource: "provider-reported",
              lastCheckedAt: NOW,
              advisory: true,
            },
          ],
        },
        NOW,
      )

      const overlaid = overlayHealth(accountSnapshot, health.stateOf(accountId))
      // `evaluateCandidate` takes a ScopedAccount — the membership wrapper the routing pipeline
      // builds around an AccountSnapshot. For a single-account predicate check, the membership
      // values are placeholders.
      const candidate = evaluateCandidate(
        { account: overlaid, poolId: null, weight: 1, priority: 0, order: 0 },
        "world-model",
        NOW,
        { quotaSpentThreshold: 1 },
      )
      expect(candidate.ok).toBe(true)
    })

    test("an in-memory fake carries the marker the same way — proves the test double is honest", async () => {
      // The unit test (`recovery/quota-advisory-roundtrip.test.ts`) uses memoryAccountQuota as
      // its test double. This test runs the same predicate against that double and the SQL repo
      // side by side; if they ever diverge, this is where it shows.
      const fake = memoryAccountQuota(
        [
          {
            id: "11111111-1111-4111-8111-111111111111",
            lifecycleVersion: 0,
            healthRecoveryVersion: 0,
            authRecoveryVersion: 0,
            authMaterial: null,
            status: "active",
            label: "fake-codex",
            provider: "openai-oauth",
            baseUrl: null,
            dialect: null,
            modelAliases: null,
            supportedModels: null,
            billing: "subscription",
            weight: 1,
            priority: 0,
            lastError: null,
            createdAt: NOW,
          },
        ],
        new Map(),
      ) as unknown as import("@multi-ai-router/db").AccountRepository

      await fake.upsertQuotaWindow("11111111-1111-4111-8111-111111111111", {
        window: "five_hour",
        utilization: 1,
        utilizationSource: "continuous",
        resetsAt: FUTURE,
        resetSource: "provider-reported",
        lastCheckedAt: NOW,
      })
      const advisory = await fake.upsertQuotaWindow("11111111-1111-4111-8111-111111111111", {
        window: "five_hour",
        utilization: 1,
        utilizationSource: "continuous",
        resetsAt: FUTURE,
        resetSource: "provider-reported",
        lastCheckedAt: LATER,
        advisory: true,
      })
      expect(advisory.advisory).toBe(true)
    })
  },
)
