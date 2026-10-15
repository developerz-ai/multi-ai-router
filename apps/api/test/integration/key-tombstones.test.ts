import { describe, expect, test } from "bun:test"
import {
  createAdminMutationRepository,
  createApiKeyRepository,
  createApiKeyTombstoneRepository,
  createAuditRepository,
  createUsageRecentRepository,
} from "@multi-ai-router/db"
import {
  historyAttempt,
  historyTerminal,
  historyUrl,
  usageHistoryFixture,
} from "../../../../packages/db/test/integration/usage-history-fixture"
import type { RetentionConfig } from "../../src/config/env"
import { createJanitorTask } from "../../src/scheduler"
import { createAuditRecorder } from "../../src/services/admin/audit"
import { createKeysService } from "../../src/services/keys"
import { catalogLabels, createUsageService } from "../../src/services/usage-read"

/**
 * Attribution outlives the key row (issue #224). Real Postgres, real rollup path, real janitor and
 * real operator delete: usage is recorded at real time and ONLY the janitor tick is advanced, past
 * RETENTION_REVOKED_KEYS_DAYS but inside the raw-usage window, so the raw rows feeding the
 * recent-attempts leg survive alongside the rollup.
 */
const fixture = usageHistoryFixture()

const RETENTION: RetentionConfig = {
  sessionsHours: 24,
  usageDays: 90,
  usageDailyDays: 730,
  auditDays: 365,
  taskRunsDays: 30,
  revokedKeysDays: 30,
  oauthStateMinutes: 10,
  orphanConfigDirHours: 24,
}
const DAY = 86_400_000
const none = async () => 0

function janitor() {
  const db = fixture.db()
  return createJanitorTask({
    sessions: { deleteIdleBefore: none },
    usageRecords: { deleteRetainedBatch: none },
    history: { deleteRetainedHistory: none },
    auditEvents: { deleteOlderThan: none },
    taskRuns: { deleteOlderThan: none },
    keyTombstones: createApiKeyTombstoneRepository(db),
    retention: RETENTION,
    intervalMs: 60_000,
    batchSize: 100,
  })
}

async function tick(now: Date) {
  return janitor().run({
    now,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    signal: new AbortController().signal,
  })
}

function services(nowMs: () => Date) {
  const db = fixture.db()
  const keys = createApiKeyRepository(db)
  const tombstones = createApiKeyTombstoneRepository(db)
  const keysService = createKeysService({
    keys,
    mutations: createAdminMutationRepository(db),
    onCommitted: () => {},
    cipher: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, "") },
    audit: createAuditRecorder(createAuditRepository(db)),
    now: nowMs,
  })
  const usage = createUsageService({
    history: fixture.history(),
    recent: createUsageRecentRepository(db),
    labels: catalogLabels({
      keys,
      tombstones,
      catalog: { accounts: () => [], pools: () => [] },
    }),
    now: nowMs,
    breakdownMaxRows: 100,
  })
  return { keys, tombstones, keysService, usage }
}

async function recordUsage(apiKeyId: string) {
  const attempt = historyAttempt({
    apiKeyId,
    createdAt: new Date(Date.now() - 3_000),
    model: "tomb-model",
  })
  await fixture.usage().insertBatch({
    attempts: [attempt],
    terminals: [historyTerminal(attempt, { settledAt: new Date(Date.now() - 2_000) })],
  })
}

async function readKeyRow(usage: ReturnType<typeof services>["usage"], id: string) {
  const summary = await usage.summary({ window: "lifetime" } as never)
  if (!summary.ok) throw new Error("summary failed")
  const recent = await usage.recent({ limit: 50 } as never)
  if (!recent.ok) throw new Error("recent failed")
  return {
    byKey: summary.value.byKey.find((row) => row.id === id),
    subject: recent.value.attempts.find((a) => a.key.id === id)?.key,
  }
}

describe.skipIf(!historyUrl)("a purged key keeps its attribution", () => {
  test("janitor purge: byKey and the recent subject keep the name, the loader keeps owner/ownerKind/tool", async () => {
    const { keysService, keys, tombstones, usage } = services(() => new Date())
    const created = await keysService.create({
      name: "alice/editor",
      owner: "alice",
      ownerKind: "person",
      tool: "editor",
    } as never)
    if (!created.ok) throw new Error("create failed")
    const id = created.value.id
    await recordUsage(id)
    const revoked = await keysService.revoke(id)
    expect(revoked.ok).toBe(true)

    // Revoked just now; the tick is 40 days on: past revokedKeysDays (30), inside usageDays (90).
    const swept = await tick(new Date(Date.now() + 40 * DAY))
    expect(swept.outcome).toBe("success")
    expect(await keys.findById(id)).toBeUndefined()

    const { byKey, subject } = await readKeyRow(usage, id)
    expect(byKey).toMatchObject({ id, label: "alice/editor", note: null })
    expect(subject).toEqual({ id, label: "alice/editor", note: null })

    const loaded = await catalogLabels({
      keys,
      tombstones,
      catalog: { accounts: () => [], pools: () => [] },
    })()
    expect(loaded.keys.get(id)).toEqual({
      name: "alice/editor",
      owner: "alice",
      ownerKind: "person",
      tool: "editor",
    })
  })

  test("operator delete writes the same tombstone, and the label survives", async () => {
    const { keysService, keys, usage, tombstones } = services(() => new Date())
    const created = await keysService.create({
      name: "ci/agent",
      owner: "ci",
      ownerKind: "service",
      tool: "agent",
    } as never)
    if (!created.ok) throw new Error("create failed")
    const id = created.value.id
    await recordUsage(id)

    const removed = await keysService.remove(id)
    expect(removed.ok).toBe(true)
    expect(await keys.findById(id)).toBeUndefined()

    const { byKey, subject } = await readKeyRow(usage, id)
    expect(byKey).toMatchObject({ id, label: "ci/agent", note: null })
    expect(subject).toMatchObject({ id, label: "ci/agent", note: null })
    const stone = (await tombstones.listAll()).find((row) => row.id === id)
    expect(stone).toMatchObject({ owner: "ci", ownerKind: "service", tool: "agent" })
  })

  test("a tombstone survives inside the usage-daily window and is swept once older", async () => {
    const { keysService, tombstones } = services(() => new Date())
    const created = await keysService.create({ name: "window/key" } as never)
    if (!created.ok) throw new Error("create failed")
    const id = created.value.id
    const t0 = new Date()
    await keysService.remove(id)

    await tick(new Date(t0.getTime() + 700 * DAY))
    expect((await tombstones.listAll()).some((row) => row.id === id)).toBe(true)

    await tick(new Date(t0.getTime() + 731 * DAY))
    expect((await tombstones.listAll()).some((row) => row.id === id)).toBe(false)
  })

  test("verification, reveal and the admin list never see a tombstone", async () => {
    const { keysService, keys } = services(() => new Date())
    const created = await keysService.create({ name: "gone/key" } as never)
    if (!created.ok) throw new Error("create failed")
    const { id, value } = created.value
    await keysService.remove(id)

    const prefix = value.slice(0, 13)
    expect(await keys.findUsableByPrefix(prefix, new Date())).toEqual([])
    const revealed = await keysService.reveal(id)
    expect(revealed.ok).toBe(false)
    const listed = await keysService.list()
    if (!listed.ok) throw new Error("list failed")
    expect(listed.value.some((view) => view.id === id)).toBe(false)
  })

  test("a key with no row and no tombstone is still reported deleted", async () => {
    const { usage } = services(() => new Date())
    const ghost = crypto.randomUUID()
    await recordUsage(ghost)
    const { byKey, subject } = await readKeyRow(usage, ghost)
    expect(byKey).toMatchObject({ id: ghost, label: null, note: "deleted" })
    expect(subject).toEqual({ id: ghost, label: null, note: "deleted" })
  })
})
