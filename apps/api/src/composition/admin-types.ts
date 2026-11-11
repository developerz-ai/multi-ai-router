import type {
  AccountRepository,
  AdminCredentialRepository,
  ApiKeyRepository,
  ApiKeyTombstoneRepository,
  AuditRepository,
  CredentialRefreshLock,
  Database,
  OauthStateRepository,
  PoolRepository,
  PriceOverrideRepository,
  RecoveryRepository,
  ScheduledTaskRepository,
} from "@multi-ai-router/db"
import type { Env } from "../config/env"
import type { Logger } from "../logging/logger"
import type {
  CredentialFreshness,
  SdkConcurrency,
  SdkQuotaStore,
  SdkUsageGauge,
} from "../providers"
import type { AccountCliOwnership } from "../providers/claude-sdk/account-ownership"
import type { AccountConfigDirs } from "../providers/claude-sdk/config-dir"
import type { OwnerLaunchConfig } from "../providers/claude-sdk/owner-launch"
import type { CredentialRefresher } from "../services/accounts"
import type { createBackgroundStartGuard } from "../services/accounts/background-admission"
import type { CoherenceHooks } from "../services/admin"
import type { SessionStore } from "../services/admin-auth"
import type { RoutingCatalogStore } from "../services/catalog"
import type { PriceBook } from "../services/cost"
import type { CredentialCipher } from "../services/crypto/cipher"
import type { HealthStore } from "../services/dataplane"
import type { RefreshSubscriptionModels } from "../services/models"
import type { AdminServices } from "../types"

export interface AdminPlaneDeps {
  readonly ownership: { manager: AccountCliOwnership; config: OwnerLaunchConfig }
  readonly backgroundStartGuard: (
    expected: Parameters<typeof createBackgroundStartGuard>[1],
    signal?: AbortSignal,
  ) => () => Promise<void>
  readonly accountDeletionCommitted: (id: string) => Promise<void>
  readonly recovery: {
    repository: RecoveryRepository
    coordinator: { demand(accountId: string): void }
  }
  readonly env: Env
  readonly logger: Logger
  readonly now: () => Date
  /** Read-only repositories the usage screen builds its own reader from. */
  readonly database: Database
  readonly accounts: AccountRepository
  readonly refreshLock: Pick<CredentialRefreshLock, "tryRun">
  readonly keys: ApiKeyRepository
  readonly keyTombstones: Pick<ApiKeyTombstoneRepository, "listAll">
  readonly pools: PoolRepository
  readonly auditEvents: AuditRepository
  readonly oauthStates: OauthStateRepository
  /** The one-row local admin credential; the auth service reads it live per login. */
  readonly adminCredentials: AdminCredentialRepository
  readonly scheduledTasks: ScheduledTaskRepository
  readonly priceOverrides: PriceOverrideRepository
  readonly cipher: CredentialCipher
  readonly catalog: RoutingCatalogStore
  readonly health: HealthStore
  /** Refreshed after a price edit, so the console is read-after-write consistent on cost. */
  readonly prices: PriceBook
  /**
   * The replica's `claude` subprocess ceiling, as the composition root built it. Passed in rather
   * than created here because "Test now" spawns the same process the dispatch path does, and one
   * memory budget takes one gate — see `providers/claude-sdk/test-probe.ts`.
   */
  readonly sdkConcurrency: SdkConcurrency
  /**
   * The refresh-window gate (`providers/claude-sdk/credential-freshness.ts`), from the same root and
   * for the same reason as the ceiling above: an operator's "Test now" is a subprocess against the
   * Account's config dir, and one landing mid-refresh is exactly how a credential gets spent twice.
   */
  readonly credentialFreshness: CredentialFreshness
  /**
   * The dispatch path's own Claude quota store, so a "Test now" turn's `rate_limit_event` readings
   * land where routing and the console already read them. Passed in for the same reason the gate
   * above is: a second store would be a second, disagreeing answer to "how much of this
   * subscription is left".
   */
  readonly sdkQuota: Pick<SdkQuotaStore, "ingest">
  /**
   * One isolated `CLAUDE_CONFIG_DIR` per subscription account, as the composition root built it.
   * Passed in for the same reason the gate above is: the scheduler's reaper sweeps the very volume
   * this plane provisions on, and two instances could be rooted at two different places.
   */
  readonly configDirs: AccountConfigDirs
  readonly coherence: CoherenceHooks
  /**
   * Built in the composition root rather than defaulted here because the scheduler's admin-session
   * purge task (`scheduler/tasks/admin-session-purge.ts`) sweeps this very instance — two instances
   * would mean the task cleans a map nothing ever populates.
   */
  readonly sessionStore: SessionStore
  /**
   * One Account's model-catalog refresh, for the connect flow to call the moment a Claude login
   * completes (`services/models/refresher.ts`). The same refresh the hourly sweep runs, plus an
   * immediate warm of the store — so a subscription lists its models before the next tick rather
   * than answering `data: []` for up to an hour.
   */
  readonly refreshSubscriptionModels: RefreshSubscriptionModels
  /** The dispatch path's usage gauge, so a "Test now" turn also reads the plan's percentages. */
  readonly usageGauge?: SdkUsageGauge
}

export interface AdminPlane {
  readonly services: AdminServices
  /**
   * Exposed for boot and shutdown ordering. It is built here because the connect flow hands it
   * every freshly written credential, and it must be armed before the listener opens.
   */
  readonly refresher: CredentialRefresher
}
