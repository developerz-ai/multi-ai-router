import type { Database, PoolSample, SqlConnection } from "@multi-ai-router/db"
import type { Env } from "../config/env"
import type { Logger } from "../logging/logger"
import type { RouterMetrics } from "../observability"
import type { SdkQuotaStore } from "../providers"
import type { Scheduler } from "../scheduler"
import type { RoutingCatalogStore } from "../services/catalog"
import type { PriceBook } from "../services/cost"
import type {
  AccountStatusWriter,
  Dispatcher,
  HealthStore,
  QuotaWindowWriter,
  RouterKeyVerifier,
} from "../services/dataplane"
import type { ModelCatalogStore } from "../services/models"
import type { AdminServices } from "../types"

export interface RuntimeDeps {
  readonly env: Env
  readonly database: Database
  /** Main SQL handle retained for pool diagnostics; scheduler locks use a separate pool. */
  readonly sql: SqlConnection
  /** The same pool's own occupancy sample, for `router_db_pool_connections` — `main.ts`. */
  readonly dbPoolStats: () => PoolSample
  readonly logger: Logger
}

export interface Runtime {
  readonly admin: AdminServices
  readonly verifier: RouterKeyVerifier
  readonly dispatcher: Dispatcher
  readonly catalog: RoutingCatalogStore
  readonly health: HealthStore
  /**
   * The two halves of quota state, exposed for the same reason {@link health} is: they are warm,
   * per-runtime, and invalidated from outside the request that wrote them. One holds what the Agent
   * SDK reported for each Account, the other makes an observed reading durable off the request path.
   */
  readonly sdkQuota: SdkQuotaStore
  readonly quotaWriter: QuotaWindowWriter
  /**
   * The durable half of {@link health}: the standing blocks the breaker forms, written through to
   * `accounts.status` so `exhausted` outlives the process that observed it.
   */
  readonly statusWriter: AccountStatusWriter
  /**
   * The warm model catalog and the warm price book, both exposed for `GET /v1/catalog` — the one
   * listing that answers with a size and a price beside each model. Warm for the reason everything
   * else here is: the endpoint that enumerates the router is the one an operator polls.
   */
  readonly models: ModelCatalogStore
  readonly prices: PriceBook
  /** Exposed for the admin plane's "run now" and for shutdown ordering; the timers are internal. */
  readonly scheduler: Scheduler
  /** What `GET /metrics` renders. Fed from the usage drain, the scheduler, and per-scrape gauges. */
  readonly metrics: RouterMetrics
  /** Loads the catalog and starts the background writers. Awaited before the listener opens. */
  start(): Promise<void>
  /** Close data-plane admission immediately on shutdown, before the HTTP drain. */
  closeAdmission(): void
  /** Flushes what is queued and stops the timers. */
  stop(): Promise<void>
}
