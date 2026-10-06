import { expect, test } from "bun:test"
import {
  createAccountRepository,
  createDatabase,
  createRecoveryRepository,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import { createRecheckService } from "../../src/services/accounts/recheck"
import { createClaudeAuthProbe } from "../../src/services/health/claudeAuthProbe"

const url = process.env.DATABASE_URL ?? ""
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test.skipIf(!url)(
  "independent replica rechecks reserve one deferred CLI and join its committed auth recovery",
  async () => {
    await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
    const handle = createDatabase({ url, maxConnections: 4 })
    const accounts = createAccountRepository(handle.db)
    const recovery = createRecoveryRepository(handle.db)
    const account = await accounts.create({
      label: "operator claim integration",
      provider: "anthropic-oauth",
      status: "needs_reauth",
    })
    const entered = deferred(),
      finish = deferred()
    let cliCalls = 0
    let barriers = 0
    let demands = 0
    const auth = createClaudeAuthProbe({
      accounts,
      configDirs: { pathFor: (id) => `/fixture/${id}` },
      cli: {
        check: async () => {
          cliCalls++
          entered.resolve()
          await finish.promise
          return { loggedIn: true, email: null, subscriptionType: null }
        },
      },
      now: () => new Date(),
      audit: { record: async () => {} },
      mutationCommitted: async () => {
        barriers++
      },
    })
    const service = () =>
      createRecheckService({
        accounts,
        recovery,
        auth,
        operatorCheckLeaseMs: 30000,
        cooldownSeconds: 60,
        refreshCatalog: async () => {
          barriers++
        },
        onRecoveryRequested: () => {
          demands++
        },
        audit: { record: async () => {} },
      })
    try {
      const first = service().recheck(account.id)
      await entered.promise
      const second = await service().recheck(account.id)
      if (!second.ok) throw new Error("expected busy response")
      expect(second.value).toMatchObject({
        rechecked: false,
        checkInProgress: true,
        lastCheckedAt: null,
      })
      expect(second.value.recovery).toBeUndefined()
      expect(cliCalls).toBe(1)
      expect((await accounts.findById(account.id))?.lifecycleVersion).toBe(0)
      finish.resolve()
      const accepted = await first
      if (!accepted.ok) throw new Error("expected joined auth recovery")
      expect(accepted.value.rechecked).toBe(false)
      expect(accepted.value.auth?.statusChangedTo).toBe("active")
      expect(accepted.value.recovery?.state).toBe("cancelled")
      const current = await accounts.findById(account.id)
      expect(current?.lifecycleVersion).toBe(1)
      expect(current?.authRecoveryVersion).toBe(1)
      expect(current?.healthRecoveryVersion).toBe(0)
      expect(barriers).toBe(2)
      expect(demands).toBe(0)
    } finally {
      finish.resolve()
      await accounts.delete(account.id)
      await handle.close()
    }
  },
)
