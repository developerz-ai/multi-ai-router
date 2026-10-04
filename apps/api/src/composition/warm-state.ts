import { createCatalogSnapshotRepository } from "@multi-ai-router/db"
import { createSdkQuotaStore } from "../providers"
import { createRoutingCatalog, loadCatalog } from "../services/catalog"
import { createPriceBook } from "../services/cost"
import {
  createAccountStatusWriter,
  createHealthStore,
  createQuotaWindowWriter,
} from "../services/dataplane"
import { accountHealthFacts } from "../services/dataplane/health-observation"
import { quotaCatalogReconciler } from "../services/dataplane/quota-catalog"
import { createModelCatalogStore } from "../services/models"
import { createRecoveryComponents } from "./recovery"

import type { createRuntimeRepositories } from "./runtime-repositories"
import type { RuntimeDeps } from "./runtime-types"
export function createWarmState(
  deps: RuntimeDeps,
  repositories: ReturnType<typeof createRuntimeRepositories>,
  now: () => Date,
) {
  const { env, database, logger } = deps
  const { accounts, priceOverrides, modelCatalog } = repositories
  // --- warm state -----------------------------------------------------------
  // The Claude subscription transport's quota state: keyed by Account and living as long as this
  // runtime, because a `rate_limit_event` on one turn is what cools the account down on the next
  // (docs/idea/11-anthropic-agent-sdk.md §5) and a module-level one would bleed between runtimes
  // inside a single process.
  //
  // Built unconditionally: whether a deployment serves subscriptions is a question about its
  // accounts, not about its wiring, and an operator who connects one must not need a restart.
  const sdkQuota = createSdkQuotaStore()
  const reconcileSdkQuota = quotaCatalogReconciler(sdkQuota)
  // The durable half of quota state. A reading is observed by whichever replica served the request,
  // so it is written by that replica, off its request path — never by a scheduled task, whose
  // advisory lock would persist one replica's readings and silently drop everyone else's.
  const quotaWriter = createQuotaWindowWriter({
    accounts,
    logger,
    flushIntervalMs: env.dataPlane.quotaWriteIntervalMs,
    shutdownDrainMs: env.background.shutdownDrainMs,
  })
  // The durable half of the breaker, and for the same reason: the replica that observed the verdict
  // is the only one holding it. A cooldown is not written — a clock recovers it — but `exhausted`
  // and `needs_reauth` end only when a human acts, and a verdict that dies with the process is a
  // human who never finds out (`services/dataplane/status-writer.ts`).
  const statusWriter = createAccountStatusWriter({
    accounts,
    logger,
    flushIntervalMs: env.dataPlane.accountStatusWriteIntervalMs,
    shutdownDrainMs: env.background.shutdownDrainMs,
    now,
  })
  // The breaker's numbers reach it from exactly one place: `breaker.ts` reads no configuration and
  // no randomness of its own, so a store built without them silently runs the module defaults and
  // returns every account tripped in the same second in the same millisecond. `probeHoldMs` is the
  // other half — the gate that admits one half-open probe onto a recovering account.
  const health = createHealthStore({
    failureThreshold: env.failover.failureThreshold,
    baseBackoffMs: env.failover.baseBackoffMs,
    maxBackoffMs: env.failover.maxBackoffMs,
    authFailureCooldownMs: env.failover.authFailureCooldownMs,
    authFailureMaxCooldownMs: env.failover.authFailureMaxCooldownMs,
    probeHoldMs: env.failover.halfOpenHoldMs,
    // Both transports fold a reading in here and nowhere else, which is what makes one hook enough
    // to make every observed window durable.
    onQuotaWindows: (accountId, windows, observation) =>
      quotaWriter.record(accountId, windows, observation),
    // Every standing block the breaker forms is announced here and nowhere else, which is what
    // makes one hook enough to make every one of them durable. Which of them may be *stored* is
    // the writer's policy, not this file's.
    onBlocked: (accountId, status, observation, windows) => {
      if (observation !== undefined) statusWriter.record(accountId, status, observation, windows)
    },
    // "Re-check now" and account deletion clear this store; the SDK's own per-Account buckets are
    // the same request path's memory of the same fact and have to go with them, or the next
    // `rate_limit_event` re-publishes the window the operator just dismissed. A queued status
    // verdict goes for the same reason: landing after the operator's clear would undo a button
    // press with no visible cause.
    onReset: (accountId) => {
      sdkQuota.forget(accountId)
      statusWriter.forget(accountId)
    },
  })
  let catalogAccountIds = new Set<string>()
  let recoveryComponents: ReturnType<typeof createRecoveryComponents> | undefined
  const catalogSnapshots = createCatalogSnapshotRepository(database)
  const catalog = createRoutingCatalog({
    load: () => loadCatalog(catalogSnapshots),
    onInstalled: (loaded) => {
      reconcileSdkQuota(loaded)
      recoveryComponents?.reconcile(loaded)
      const nextIds = new Set(loaded.map((account) => account.id))
      for (const id of new Set([...catalogAccountIds, ...health.entries().keys()])) {
        if (!nextIds.has(id)) health.reset(id)
      }
      catalogAccountIds = nextIds
      for (const account of loaded) health.reconcile(account.id, accountHealthFacts(account))
    },
    refreshIntervalMs: env.dataPlane.catalogRefreshSeconds * 1_000,
    now,
  })
  recoveryComponents = createRecoveryComponents({
    database,
    accounts,
    catalog,
    health,
    config: env.recovery,
    logger,
    now,
  })
  // The shipped price table plus the operator's overrides, held in memory for the same reason the
  // catalog is: every attempt is priced while the request is still being served. It shares the
  // catalog's staleness bound because it is the same kind of value — admin-edited configuration
  // another replica may have changed — and one knob for both is one fewer to explain.
  const prices = createPriceBook({
    load: () => priceOverrides.list(),
    refreshIntervalMs: env.dataPlane.catalogRefreshSeconds * 1_000,
    now,
  })
  // What the hourly sweep discovered, held warm so `GET /v1/catalog` renders without a query per
  // model. It shares the catalog's staleness bound for the same reason the price book does: it is
  // the same kind of value — a table another replica may have rewritten — and one knob for all
  // three is one fewer to explain.
  const modelCatalogStore = createModelCatalogStore({
    load: () => modelCatalog.list(),
    refreshIntervalMs: env.dataPlane.catalogRefreshSeconds * 1_000,
    now,
  })

  return {
    sdkQuota,
    quotaWriter,
    statusWriter,
    health,
    catalog,
    recoveryComponents,
    prices,
    modelCatalogStore,
  }
}
