import { afterAll, beforeAll } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { createDatabase, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import { createRecoveryRepository } from "../../src/repositories/account-recovery-repository"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { createQuotaWindowMutations } from "../../src/repositories/quota-window-mutations"
import { type AccountRow, accounts } from "../../src/schema/accounts"
import { quotaWindows } from "../../src/schema/quota-windows"
export const url = process.env.DATABASE_URL ?? ""
export function recoveryFixture() {
  let handle: DatabaseHandle | undefined
  const ids: string[] = []
  beforeAll(async () => {
    if (!url) return
    await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
    handle = createDatabase({ url, maxConnections: 3 })
  })
  afterAll(async () => {
    if (handle && ids.length) await handle.db.delete(accounts).where(inArray(accounts.id, ids))
    await handle?.close()
  })
  const db = () => {
    if (handle === undefined) throw new Error("recovery fixture not initialized")
    return handle.db
  }
  const repositories = () => ({
    accounts: createAccountRepository(db()),
    recovery: createRecoveryRepository(db()),
    quota: createQuotaWindowMutations(db()),
  })
  async function seed(status: "active" | "exhausted" | "disabled" | "needs_reauth" = "active") {
    const row = await repositories().accounts.create({
      label: "recovery-fixture",
      provider: "zai",
      status,
      authMaterial: "cipher",
    })
    ids.push(row.id)
    return row
  }
  async function issue(subject?: AccountRow) {
    const account = subject ?? (await seed())
    const recovery = repositories().recovery
    const begin = await recovery.beginAutomaticRecovery({
      accountId: account.id,
      generationCandidate: crypto.randomUUID(),
      expected: account,
      expectedRecoveryRevision: null,
      reason: "quota-stale",
      cooldownMs: 1000,
    })
    if (begin === undefined) throw new Error("missing pending recovery")
    const ownerBootId = crypto.randomUUID()
    await recovery.assignPending({
      accountId: account.id,
      generation: begin.generation,
      expectedEpoch: 0,
      ownerBootId,
      leaseMs: 60000,
    })
    const input = {
      accountId: account.id,
      generation: begin.generation,
      expectedEpoch: 1,
      ownerBootId,
      permitId: crypto.randomUUID(),
      expected: account,
    }
    await recovery.issue(input)
    return input
  }
  return {
    db,
    repositories,
    seed,
    issue,
    windows: (id: string) => db().select().from(quotaWindows).where(eq(quotaWindows.accountId, id)),
  }
}
export const reading = {
  window: "five_hour" as const,
  utilization: 1,
  utilizationSource: "continuous" as const,
  resetSource: "unknown" as const,
  lastCheckedAt: new Date("2020-01-01"),
}
