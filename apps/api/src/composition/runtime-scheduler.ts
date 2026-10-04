import { IDLE_PROBE_MODELS, schedulerFromEnv } from "../scheduler"
import { describeProvider } from "../services/accounts/providers"
import { refreshAccountCatalog } from "../services/models"
import type { AdminServices } from "../types"
import type { createCliResources } from "./cli-resources"
import type { createRequestServices } from "./request-services"
import type { createRuntimeRepositories } from "./runtime-repositories"
import type { createRuntimeTelemetry } from "./runtime-telemetry"
import type { RuntimeDeps } from "./runtime-types"
import type { createWarmState } from "./warm-state"
export function createRuntimeScheduler(
  deps: RuntimeDeps,
  repositories: ReturnType<typeof createRuntimeRepositories>,
  warm: ReturnType<typeof createWarmState>,
  cli: ReturnType<typeof createCliResources>,
  telemetry: ReturnType<typeof createRuntimeTelemetry>,
  request: ReturnType<typeof createRequestServices>,
  admin: AdminServices,
  now: () => Date,
) {
  const { env, logger } = deps
  const {
    sessions,
    usageRecords,
    auditEvents,
    keys,
    oauthStates,
    usageHistory,
    accounts,
    scheduledTasks,
    modelCatalog,
    schedulerLock,
  } = repositories
  const { health } = warm
  const { configDirs, transcripts, credentialFreshness } = cli
  const { adminSessions, metrics } = telemetry
  const { usageGaugeProbe, backgroundStartGuard, catalogRefreshDeps } = request
  // Built AFTER the admin plane, not before: the keepalive sweep spends the admin plane's own
  // "Test now" rather than a second probe of its own, so a scheduled probe and an operator's button
  // press share one cooldown, one subprocess gate, and one audit kind. Nothing between the two
  // needed the scheduler, so this is an ordering, not an indirection.
  const scheduler = schedulerFromEnv({
    sessions,
    usageRecords,
    auditEvents,
    apiKeys: keys,
    oauthStates,
    history: usageHistory,
    accounts,
    scheduledTasks,
    health,
    configDirs,
    transcripts,
    adminSessions,
    testAccount: async (accountId, model, expectedAccount) => {
      const result = await admin.testNow.test(accountId, {
        model,
        confirmed: true,
        backgroundExpectedAccount: expectedAccount,
      })
      // A refusal (`ok: false`) is a validation outcome — an unknown id, a provider with no
      // implementation. Reported as "not tested" rather than as a failed account, because nothing
      // was sent and the account said nothing about itself.
      return result.ok ? result.value : { tested: false }
    },
    // Free, and asked before anything is billed: a credential that is already dead fails the
    // test for a reason only a human can fix.
    ...(admin.authProbe === undefined ? {} : { authProbe: admin.authProbe }),
    // The free half's usage read: a turn-free query per logged-in subscription, so an account
    // nothing routed to today still shows real percentages. Bounded by the same semaphore.
    usageProbe: (account) =>
      usageGaugeProbe.read({
        accountId: account.id,
        configDir: configDirs.pathFor(account.id),
        beforeBackgroundUpstreamStart: backgroundStartGuard(account),
      }),
    probeModels: IDLE_PROBE_MODELS,
    // Metadata, never a token: one boolean per account, from the same gate every spawn site asks.
    // It is what lets the sweep warm a cold credential with a real turn *before* its turn-free
    // gauge read, instead of ending a subprocess mid-refresh.
    credentialCold: async (account) =>
      describeProvider(account.provider).requiresConfigDir
        ? credentialFreshness.wouldRefresh(account.id)
        : false,
    modelCatalog,
    // Hourly, free, and pointed at `model_catalog` alone: a listing costs no tokens and spends no
    // quota window, and nothing in routing reads what it writes. `supported_models` — which does
    // gate routing — stays the operator's, untouched by any timer.
    refreshCatalog: (account, at) => refreshAccountCatalog(catalogRefreshDeps, account, at),
    env,
    schedulerLock,
    logger,
    now,
    onTick: (result) => metrics.observeTask(result),
  })

  return { scheduler }
}
