import { describeError } from "@multi-ai-router/core"
import type { Scheduler } from "../scheduler"
import type { AdminServices } from "../types"
import type { createAdminPlane } from "./admin"
import type { createCliResources } from "./cli-resources"
import { createRuntimeLifecycle } from "./lifecycle"
import type { createRequestServices } from "./request-services"
import type { createRuntimeRepositories } from "./runtime-repositories"
import type { createRuntimeTelemetry } from "./runtime-telemetry"
import type { RuntimeDeps } from "./runtime-types"
import type { createWarmState } from "./warm-state"
export function assembleRuntimeLifecycle(
  deps: RuntimeDeps,
  repositories: ReturnType<typeof createRuntimeRepositories>,
  warm: ReturnType<typeof createWarmState>,
  cli: ReturnType<typeof createCliResources>,
  telemetry: ReturnType<typeof createRuntimeTelemetry>,
  request: ReturnType<typeof createRequestServices>,
  admin: AdminServices,
  refresher: ReturnType<typeof createAdminPlane>["refresher"],
  scheduler: Scheduler,
) {
  const { logger } = deps
  const { schedulerLock, refreshLock } = repositories
  const { catalog, prices, modelCatalogStore, recoveryComponents, quotaWriter, statusWriter } = warm
  const { ownership } = cli
  const { usage } = telemetry
  const { activeRequests } = request
  const lifecycle = createRuntimeLifecycle({
    logger,
    start: async (assertStarting) => {
      // Awaited: an empty catalog would look exactly like a deployment with no accounts.
      await catalog.refresh()
      assertStarting()
      catalog.start()
      recoveryComponents?.coordinator.start()
      // Awaited for the weaker reason: an unloaded book prices off the shipped table, which is
      // wrong rather than absent, and a spend column that corrects itself a second later is worse
      // than one that was right from the first request.
      await prices.refresh()
      assertStarting()
      prices.start()
      // Not awaited, and the one warm store here that genuinely need not be: an unloaded model
      // catalog temporarily thins listings and uses the configured translation cap fallback.
      // Neither needs a boot failure while catalog metadata is unavailable.
      void modelCatalogStore.refresh().catch((error: unknown) => {
        logger.warn("model catalog did not load at boot", {
          component: "runtime",
          error: describeError(error, Number.POSITIVE_INFINITY),
        })
      })
      modelCatalogStore.start()
      usage.start()
      quotaWriter.start()
      statusWriter.start()
      // Synchronous by design: the first sweep is not a boot precondition.
      scheduler.start()
      // Awaited: rebuilt from `tokenExpiresAt`, so a token that expired during downtime is due now.
      await refresher.start()
      assertStarting()
      logger.info("runtime ready", {
        component: "runtime",
        accounts: catalog.accounts().length,
        pools: catalog.pools().length,
      })
    },
    phases: [
      [
        { name: "request-admission", run: () => activeRequests.closeAdmission() },
        {
          name: "background-admission",
          run: () => {
            request.closeBackgroundAdmission()
          },
        },
        { name: "account-connect-admission", run: () => admin.connect.closeAdmission() },
        { name: "cli-owner-admission", run: () => ownership.closeAdmission() },
        { name: "catalog-timers", run: () => catalog.stop() },
        { name: "price-timers", run: () => prices.stop() },
        { name: "model-catalog-timers", run: () => modelCatalogStore.stop() },
      ],
      [
        { name: "active-requests", run: () => activeRequests.stop() },
        { name: "account-connect", run: () => admin.connect.stop() },
        { name: "cli-owners", run: () => ownership.stop() },
        { name: "recovery-coordinator", run: () => recoveryComponents.coordinator.stop() },
        { name: "scheduler", run: () => scheduler.stop() },
        { name: "credential-refresher", run: () => refresher.stop() },
      ],
      [
        { name: "scheduler-lock-pool", run: () => schedulerLock.close() },
        { name: "refresh-lock-pool", run: () => refreshLock.close() },
      ],
      [
        { name: "usage-writer", run: () => usage.stop() },
        { name: "quota-writer", run: () => quotaWriter.stop() },
        { name: "status-writer", run: () => statusWriter.stop() },
      ],
    ],
  })

  return { lifecycle }
}
