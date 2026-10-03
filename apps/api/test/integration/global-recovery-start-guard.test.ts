import { expect, test } from "bun:test"
import { databaseUrl, globalRecoveryFixture } from "./global-recovery-fixture"

for (const change of ["lifecycle", "credential", "recovery"] as const) {
  test.skipIf(!databaseUrl)(
    `ordinary queued attempt refuses installed ${change} before upstream start`,
    async () => {
      let starts = 0
      const f = await globalRecoveryFixture(async () => {
        starts++
        return new Response("unexpected")
      })
      try {
        await f.accounts.upsertQuotaWindow(f.account.id, {
          window: "five_hour",
          utilization: 0,
          utilizationSource: "continuous",
          resetsAt: new Date(Date.now() + 3600000),
          resetSource: "provider-reported",
          lastCheckedAt: new Date(),
        })
        await f.first.catalog.refresh()
        if (change === "recovery") {
          await f.first.components.repository.beginOperatorRecovery({
            accountId: f.account.id,
            generationCandidate: crypto.randomUUID(),
            cooldownMs: 60000,
          })
        } else {
          await f.accounts.updateOperatorAccount({
            id: f.account.id,
            patch:
              change === "credential"
                ? { authMaterial: f.cryptor.encrypt("replacement") }
                : { status: "active" },
            now: new Date(),
          })
        }
        const fresh = await f.load()
        f.first.beforeDecrypt(() => f.first.components.reconcile(fresh.accounts))
        const response = await f.first.dispatch()
        expect(response.status).toBe(429)
        expect(starts).toBe(0)
        expect(f.first.health.stateOf(f.account.id).breaker.consecutiveFailures).toBe(0)
        expect(f.first.usage.rows).toHaveLength(1)
        expect(f.first.usage.rows[0]?.accountId).toBeNull()
      } finally {
        await f.close()
      }
    },
  )
}

test.skipIf(!databaseUrl)(
  "fresh spent quota blocks a previously designated permit before final start",
  async () => {
    let starts = 0
    const f = await globalRecoveryFixture(async () => {
      starts++
      return new Response("unexpected")
    })
    try {
      await f.first.recheck.recheck(f.account.id)
      await f.first.components.coordinator.tick()
      await f.accounts.upsertQuotaWindow(f.account.id, {
        window: "five_hour",
        utilization: 1,
        utilizationSource: "continuous",
        resetsAt: new Date(Date.now() + 7200000),
        resetSource: "provider-reported",
        lastCheckedAt: new Date(),
      })
      const fresh = await f.load()
      f.first.beforeDecrypt(() => f.first.components.reconcile(fresh.accounts))
      const response = await f.first.dispatch()
      expect(response.status).toBe(429)
      expect(starts).toBe(0)
      expect(f.first.health.stateOf(f.account.id).breaker.consecutiveFailures).toBe(0)
      expect(f.first.usage.rows).toHaveLength(1)
      expect(f.first.usage.rows[0]?.accountId).toBeNull()
    } finally {
      await f.close()
    }
  },
)
