import type {
  AccountRepository,
  AccountRow,
  ApiKeyTombstoneRepository,
  AuditRepository,
  ModelCatalogRepository,
  OauthStateRepository,
  ScheduledTaskRepository,
  SessionRepository,
  UsageHistoryRepository,
  UsageRecordRepository,
  UsageReportRepository,
} from "@multi-ai-router/db"
import type { Env } from "../../config/env"
import type { AccountConfigDirs } from "../../providers/claude-sdk/config-dir"
import type { SdkTranscripts } from "../../providers/claude-sdk/transcripts"
import type { HealthStore } from "../../services/dataplane"
import type { AccountAuthProbe } from "../../services/health/claudeAuthProbe"
import type { AdminSessionStoreForPurge } from "./admin-session-purge"
import type { CooldownRecheckPorts } from "./cooldown-recheck"
import type { CredentialTaskDeps } from "./credential-tasks"
import type { IdleAccountProbeDeps } from "./idle-account-probe"
import type { ModelCatalogRefreshDeps } from "./model-catalog-refresh"
import type { PlanQuotaReadPorts } from "./plan-quota-read"
import type { PoolReapPorts } from "./pool-reap"
import type { ReportTaskDeps } from "./report-tasks"

/** Everything the task registry (`index.ts`) is handed: one port per task, plus the config. */
export interface ScheduledTaskDeps
  extends Pick<CredentialTaskDeps, "credentialMetadata" | "lastLogins">,
    Pick<ReportTaskDeps, "usageReports" | "usageReportDelivery"> {
  readonly sessions: Pick<SessionRepository, "deleteIdleBefore">
  readonly usageRecords: Pick<UsageRecordRepository, "deleteRetainedBatch">
  readonly auditEvents: Pick<AuditRepository, "deleteOlderThan">
  readonly keyTombstones: Pick<ApiKeyTombstoneRepository, "purgeRevoked" | "deleteOlderThan">
  /** The janitor's sweep of stored weekly reports. The report task itself uses `usageReports`. */
  readonly usageReportRows: Pick<UsageReportRepository, "deleteOlderThan">
  readonly oauthStates: Pick<OauthStateRepository, "deleteExpiredBefore">
  readonly history: Pick<UsageHistoryRepository, "backfill" | "deleteRetainedHistory">
  /**
   * The admin console's session store, over the shared `admin_sessions` table. Handed in as the
   * store rather than its repository because the store also evicts what the sweep deletes from
   * its per-replica read cache — see the task's own module comment.
   */
  readonly adminSessions: AdminSessionStoreForPurge
  readonly accounts: Pick<
    AccountRepository,
    | "list"
    | "listSummaries"
    | "findById"
    | "listIds"
    | "listQuotaWindows"
    | "clearObservedQuotaWindow"
    | "findIdle"
    | "readEligibleBackgroundAccount"
  >
  /**
   * The janitor's sweep of the task run log. The runner uses this repository separately to
   * persist task outcomes; contribution backfill tracks progress through durable receipts.
   */
  readonly scheduledTasks: Pick<ScheduledTaskRepository, "lastSuccess" | "deleteOlderThan">
  /** The quota floor's freshness read. It never writes health — see that task's note. */
  readonly health: Pick<HealthStore, "stateOf">
  /**
   * The subscription config-directory volume, for the reaper. Built in the composition root rather
   * than here because the admin plane provisions and removes through the same instance.
   */
  readonly configDirs: Pick<AccountConfigDirs, "root" | "list" | "remove">
  /**
   * The session transcripts the `claude` CLI leaves under those same directories, for the
   * transcript sweep. Built beside `configDirs` over the same root.
   */
  readonly transcripts: Pick<SdkTranscripts, "root" | "survey" | "remove">
  /**
   * The keepalive sweep's billed half — the admin plane's own "Test now", handed in rather than
   * rebuilt, so a scheduled probe and an operator's button press share one cooldown, one
   * subprocess gate, and one audit kind. Absent means the sweep has nothing to spend and probes
   * nothing.
   */
  readonly testAccount?: IdleAccountProbeDeps["test"]
  /**
   * The free half: "is this Claude subscription still logged in", asked of the CLI. Absent where
   * no CLI is available, in which case a dead credential is discovered by the paid test instead.
   */
  readonly authProbe?: AccountAuthProbe
  /**
   * The turn-free usage read for one subscription account, for the free half of the sweep. Absent
   * where no CLI is available — the request path's gauge still covers accounts that serve traffic.
   */
  readonly usageProbe?: IdleAccountProbeDeps["usage"]
  /**
   * Which model each provider is probed with. Empty means nothing is probed — the sweep never
   * invents a model name, because the client picks the model and this is the one place the router
   * would otherwise have to choose one (non-negotiable 4 in spirit).
   */
  readonly probeModels?: Readonly<Record<string, string>>
  /**
   * Whether a `claude` subprocess spawned against this account now would refresh its access token
   * (`CredentialFreshness.wouldRefresh`) — metadata, never a token. Absent disables the credential
   * keepalive, which is what a deployment with no config directories wants.
   */
  readonly credentialCold?: (account: AccountRow) => Promise<boolean>
  /**
   * The model catalog's staleness ordering, and the attempt ledger the sweep rotates on. The
   * sweep reads `refreshed_at` and `model_catalog_attempts.last_attempted_at`, and records or
   * clears an attempt row as it asks each account; the catalog writes themselves still go
   * through {@link ScheduledTaskDeps.refreshCatalog}, which owns the transaction per account.
   */
  readonly modelCatalog?: Pick<
    ModelCatalogRepository,
    "lastRefreshedAt" | "lastAttemptedAt" | "recordAttempt" | "clearAttempt"
  >
  /**
   * One account's catalog refresh, handed in rather than rebuilt, so the hourly sweep and the admin
   * plane's discover button ask an upstream through exactly one parser. Absent means no sweep is
   * built at all — a deployment with nothing wired gets no task rather than one that ticks and
   * does nothing.
   */
  readonly refreshCatalog?: ModelCatalogRefreshDeps["refresh"]
  /** The hourly look at accounts on a long cooldown. Absent means no task is built. */
  readonly cooldownRecheck?: CooldownRecheckPorts
  /** The background read of plans that report usage on their own endpoint. Absent: no task. */
  readonly planQuotaRead?: PlanQuotaReadPorts
  /** The empty-pool reap's candidate read and the reaper it hands each one. Absent: no task. */
  readonly poolReap?: PoolReapPorts
  /** A full `Env` satisfies this, so the composition root passes `env` straight through. */
  readonly env: Pick<
    Env,
    "retention" | "janitorIntervalMinutes" | "schedulerLimits" | "usageBackfillFullScanHours"
  > &
    CredentialTaskDeps["env"] &
    ReportTaskDeps["env"]
}
