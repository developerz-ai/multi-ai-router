import { expect, test } from "bun:test"
import { databaseUrl, globalRecoveryFixture } from "./global-recovery-fixture"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

for (const newerReading of [false, true]) {
  test.skipIf(!databaseUrl)(
    `two independent boots dispatch one recovery and preserve quota ordering (fresh=${newerReading})`,
    async () => {
      const started = deferred(),
        finish = deferred()
      let starts = 0
      const f = await globalRecoveryFixture(async () => {
        starts++
        started.resolve()
        await finish.promise
        return new Response(
          JSON.stringify({
            id: "fixture",
            object: "chat.completion",
            model: "glm-4.7",
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        )
      })
      try {
        expect(f.first.components.coordinator.bootId).not.toBe(
          f.second.components.coordinator.bootId,
        )
        const recheck = await f.first.recheck.recheck(f.account.id)
        expect(recheck.ok && recheck.value.recovery.state).toBe("pending")
        f.second.components.coordinator.demand(f.account.id)
        await Promise.all([
          f.first.components.coordinator.tick(),
          f.second.components.coordinator.tick(),
        ])
        await Promise.all([f.first.catalog.refresh(), f.second.catalog.refresh()])
        const requests = [f.first, f.second].flatMap((replica) =>
          Array.from({ length: 100 }, () => replica.dispatch()),
        )
        await started.promise
        expect(starts).toBe(1)
        if (newerReading)
          await f.accounts.upsertQuotaWindow(f.account.id, {
            window: "five_hour",
            utilization: 0.8,
            utilizationSource: "continuous",
            resetsAt: new Date(Date.now() + 7200000),
            resetSource: "provider-reported",
            lastCheckedAt: new Date(),
          })
        finish.resolve()
        const responses = await Promise.all(requests)
        for (const response of responses) await response.text()
        expect(responses.filter((response) => response.status === 200)).toHaveLength(1)
        expect(responses.filter((response) => response.status === 429)).toHaveLength(199)
        const refusals = [...f.first.usage.rows, ...f.second.usage.rows].filter(
          (row) => row.accountId === null,
        )
        expect(refusals).toHaveLength(199)
        expect(new Set(refusals.map((row) => row.correlationId)).size).toBe(199)
        await Promise.all([
          f.first.components.coordinator.tick(),
          f.second.components.coordinator.tick(),
        ])
        const windows = await f.accounts.listQuotaWindows([f.account.id])
        if (newerReading) {
          expect(windows[0]?.retiredAt).toBeNull()
          expect(windows[0]?.utilization).toBe(0.8)
          expect(windows[0]?.blocksRouting).toBe(true)
        } else {
          expect(windows[0]?.retiredAt).not.toBeNull()
          expect(windows[0]?.utilization).toBe(1)
          expect(windows[0]?.blocksRouting).toBe(false)
        }
      } finally {
        finish.resolve()
        await f.close()
      }
    },
    20000,
  )
}

test.skipIf(!databaseUrl)(
  "credential replacement installed after selection refuses final start without a strike",
  async () => {
    let starts = 0
    const f = await globalRecoveryFixture(async () => {
      starts++
      return new Response("unexpected")
    })
    try {
      await f.first.recheck.recheck(f.account.id)
      await f.first.components.coordinator.tick()
      const replacement = await f.accounts.updateOperatorAccount({
        id: f.account.id,
        patch: { authMaterial: f.cryptor.encrypt("new-key") },
        now: new Date(),
      })
      expect(replacement).toBeDefined()
      const fresh = await f.load()
      // Real DB mutation is committed; the installation arrives after selection, during credential preparation.
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
