import { isRouterError } from "@multi-ai-router/core"
import {
  createAccountRepository,
  createCatalogSnapshotRepository,
  createDatabase,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import { createRecoveryComponents } from "../../src/composition/recovery"
import { readRecoveryEnv } from "../../src/config/recovery"
import { createLogger } from "../../src/logging/logger"
import { createRecheckService } from "../../src/services/accounts/recheck"
import { createRoutingCatalog, loadCatalog } from "../../src/services/catalog"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
import {
  createDispatcher,
  createHealthStore,
  type FetchLike,
  type VerifiedKey,
} from "../../src/services/dataplane"
import type { UsageRecord } from "../../src/services/usage"

export const databaseUrl = process.env.DATABASE_URL ?? ""
const logger = createLogger({ level: "error", write: () => {} })
export async function globalRecoveryFixture(fetch: FetchLike) {
  await runMigrations({ url: databaseUrl, migrationsFolder: defaultMigrationsFolder() })
  const handle = createDatabase({ url: databaseUrl, maxConnections: 6 })
  const accounts = createAccountRepository(handle.db)
  const cryptor = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
  const account = await accounts.create({
    label: "global recovery integration",
    provider: "zai",
    authMaterial: cryptor.encrypt("fixture-key"),
  })
  try {
    const now = () => new Date()
    await accounts.upsertQuotaWindow(account.id, {
      window: "five_hour",
      utilization: 1,
      utilizationSource: "continuous",
      resetsAt: new Date(Date.now() + 3600000),
      resetSource: "provider-reported",
      lastCheckedAt: now(),
    })
    const makeReplica = async () => {
      const health = createHealthStore({ jitter: () => 0 })
      let components: ReturnType<typeof createRecoveryComponents> | undefined
      const catalog = createRoutingCatalog({
        load: () => loadCatalog(createCatalogSnapshotRepository(handle.db)),
        refreshIntervalMs: 1000,
        onInstalled: (rows) => components?.reconcile(rows),
      })
      components = createRecoveryComponents({
        database: handle.db,
        accounts,
        health,
        catalog,
        config: readRecoveryEnv({}).recovery,
        logger,
        now,
      })
      await catalog.refresh()
      let beforeDecrypt: (() => void) | undefined
      const rows: UsageRecord[] = []
      const usage = {
        rows,
        record: (row: UsageRecord) => {
          rows.push(row)
        },
      }
      const dispatcher = createDispatcher({
        catalog,
        health,
        cipher: {
          decrypt(value) {
            const hook = beforeDecrypt
            beforeDecrypt = undefined
            hook?.()
            return cryptor.decrypt(value)
          },
        },
        usage,
        fetch,
        recovery: components.access,
      })
      const key: VerifiedKey = {
        id: crypto.randomUUID(),
        name: "test",
        prefix: "test",
        scope: { kind: "accounts", accountIds: [account.id] },
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
        expiresAt: null,
      }
      const dispatch = () =>
        dispatcher
          .dispatch({
            ingress: "openai-chat",
            key,
            requestId: crypto.randomUUID(),
            request: new Request("https://router.test/v1/chat/completions", {
              method: "POST",
              body: JSON.stringify({
                model: "glm-4.7",
                messages: [{ role: "user", content: "ping" }],
              }),
            }),
          })
          .catch((error) => {
            if (isRouterError(error)) return new Response(error.message, { status: error.status })
            throw error
          })
      const recheck = createRecheckService({
        accounts,
        recovery: components.repository,
        cooldownSeconds: 60,
        audit: { record: async () => {} },
        refreshCatalog: () => catalog.refreshAfterMutation(),
        onRecoveryRequested: (id) => components?.coordinator.demand(id),
      })
      return {
        components,
        catalog,
        health,
        usage,
        dispatch,
        recheck,
        beforeDecrypt: (hook: () => void) => {
          beforeDecrypt = hook
        },
      }
    }
    const first = await makeReplica(),
      second = await makeReplica()
    return {
      account,
      accounts,
      first,
      second,
      load: () => loadCatalog(createCatalogSnapshotRepository(handle.db)),
      cryptor,
      async close() {
        await Promise.all([
          first.components.coordinator.stop(),
          second.components.coordinator.stop(),
        ])
        await accounts.delete(account.id)
        await handle.close()
      },
    }
  } catch (error) {
    await accounts.delete(account.id)
    await handle.close()
    throw error
  }
}
