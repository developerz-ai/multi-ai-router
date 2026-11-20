import {
  type AccountModelsService,
  createAccountModelsService,
  createDiscoverModelsService,
  createSupportedModelsWriter,
  type DiscoverModelsService,
  type SupportedModelsWriter,
} from "../services/accounts"
import type { AuditRecorder } from "../services/admin"
import type { AdminPlaneDeps } from "./admin-types"

const DAY_MS = 86_400_000

export interface AccountModelPlane {
  /** The one writer of every account's `supportedModels` (`services/accounts/supported-models.ts`). */
  readonly writer: SupportedModelsWriter
  /** "Discover models": one free GET at the provider's listing, merged in — never a removal. */
  readonly discoverModels: DiscoverModelsService
  /** `PATCH` / `PUT /:id/models`: add and remove single ids, or a replace that names its removals. */
  readonly models: AccountModelsService
}

/** Everything that writes an account's model list, built around one writer so the rule holds. */
export function createAccountModelPlane(
  deps: Pick<AdminPlaneDeps, "env" | "logger" | "now" | "accounts" | "cipher" | "coherence">,
  audit: AuditRecorder,
): AccountModelPlane {
  const { env, logger, accounts } = deps
  const writer = createSupportedModelsWriter({
    accounts,
    audit,
    now: deps.now,
    memoryMs: env.routingLimits.modelRemovalMemoryDays * DAY_MS,
    mutationCommitted: () => deps.coherence.refreshCatalog(),
    log: logger,
  })
  const discoverModels = createDiscoverModelsService({
    accounts,
    models: writer,
    cipher: deps.cipher,
    audit,
    timeoutMs: env.failover.upstreamTimeoutMs,
    maxResponseBytes: env.modelListingMaxBytes,
    log: logger,
    reasonMaxChars: env.logReasonMaxChars,
  })
  return { writer, discoverModels, models: createAccountModelsService(writer) }
}
